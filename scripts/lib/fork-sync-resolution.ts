// @effect-diagnostics nodeBuiltinImport:off - Resolution data is Git plumbing over the common git dir.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { SYNC_RESOLUTION_BRANCH } from "./fork-policy.ts";
import {
  git,
  gitAllow,
  gitPath,
  gitResult,
  lines,
  runRequire,
  type CommandRunner,
} from "./fork-sync-git.ts";

/**
 * Resolutions outlive the runner as git data: every CI run starts on a fresh
 * clone, so `.git/rr-cache` and the tip fixups die with it. Each rebase writes
 * them to one parentless commit at `RESOLUTION_REF`; whoever resolved a stop
 * pushes that commit to `sync/resolution`, and the next run imports it before
 * it rebases. The import treats the branch purely as data: it accepts only
 * rerere entries and one mbox, and nothing in it ever executes.
 */
export const RESOLUTION_REF = "refs/fork-sync/resolution";
const RESOLUTION_REMOTE_REF = `refs/remotes/origin/${SYNC_RESOLUTION_BRANCH}`;
const RESOLUTION_TAG_TRAILER = "Fork-Sync-Tag";
const FIXUPS_FILE = "fixups.mbox";
const RERERE_PATH = /^rr-cache\/[0-9a-f]{40,64}\/(?:pre|post)image(?:\.\d+)?$/;

/** The rerere ids the current stop recorded (`MERGE_RR` holds `<id>[.<n>]\t<path>\0`). */
export const stopRerereIds = (runner: CommandRunner, worktree: string): ReadonlyArray<string> => {
  let entries: string;
  try {
    entries = NodeFS.readFileSync(gitPath(runner, worktree, "MERGE_RR"), "utf8");
  } catch {
    return [];
  }
  return entries.split("\0").flatMap((entry) => entry.match(/^([0-9a-f]+)(?:\.\d+)?\t/)?.[1] ?? []);
};

/** Run git against a scratch index, so building or reading a tree never touches a checkout's. */
const withScratchIndex = <T>(
  runner: CommandRunner,
  root: string,
  effect: (gitIndexed: (args: ReadonlyArray<string>, input?: string) => string) => T,
): T => {
  const index = gitPath(runner, root, "fork-sync-resolution.index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  NodeFS.rmSync(index, { force: true });
  try {
    return effect((args, input) =>
      runRequire(runner, "git", args, {
        cwd: root,
        env,
        ...(input === undefined ? {} : { input }),
      }),
    );
  } finally {
    NodeFS.rmSync(index, { force: true });
  }
};

/**
 * Write `RESOLUTION_REF`: the resolved rerere entries `state` names, plus the
 * tip commits above the finished rebase as `fixups.mbox`. Nothing to carry
 * deletes it.
 */
export const exportResolution = (
  runner: CommandRunner,
  root: string,
  worktree: string,
  state: {
    readonly tag: string;
    readonly rebased?: string;
    readonly rerere?: ReadonlyArray<string>;
  },
): void => {
  const commonDir = git(runner, root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // Only resolved entries: an id with no postimage is a stop still waiting.
  const files = (state.rerere ?? []).flatMap((id) => {
    let names: ReadonlyArray<string>;
    try {
      names = NodeFS.readdirSync(NodePath.join(commonDir, "rr-cache", id));
    } catch {
      return [];
    }
    if (!names.some((name) => name.startsWith("postimage"))) return [];
    return names.map((name) => `rr-cache/${id}/${name}`).filter((path) => RERERE_PATH.test(path));
  });
  const shas =
    files.length === 0
      ? []
      : lines(
          git(runner, root, [
            "hash-object",
            "-w",
            "--",
            ...files.map((path) => NodePath.join(commonDir, path)),
          ]),
        );
  const entries = files.map((path, index) => `100644 ${shas[index]}\t${path}`);
  if (
    state.rebased !== undefined &&
    gitResult(runner, worktree, ["merge-base", "--is-ancestor", state.rebased, "HEAD"]).status === 0
  ) {
    const mbox = runRequire(runner, "git", ["format-patch", "--stdout", `${state.rebased}..HEAD`], {
      cwd: worktree,
    });
    if (mbox !== "")
      entries.push(
        `100644 ${runRequire(runner, "git", ["hash-object", "-w", "--stdin"], { cwd: root, input: mbox }).trim()}\t${FIXUPS_FILE}`,
      );
  }
  if (entries.length === 0) {
    gitAllow(runner, root, ["update-ref", "-d", RESOLUTION_REF]);
    return;
  }
  const tree = withScratchIndex(runner, root, (gitIndexed) => {
    gitIndexed(["update-index", "--add", "--index-info"], `${entries.join("\n")}\n`);
    return gitIndexed(["write-tree"]).trim();
  });
  const commit = git(runner, root, [
    "commit-tree",
    tree,
    "-m",
    `fork-sync resolution for ${state.tag}`,
    "-m",
    `${RESOLUTION_TAG_TRAILER}: ${state.tag}`,
  ]);
  git(runner, root, ["update-ref", RESOLUTION_REF, commit]);
  process.stdout.write(
    `sync: resolution data at ${RESOLUTION_REF} (${commit.slice(0, 7)}); push it to ${SYNC_RESOLUTION_BRANCH} to carry it to the next run\n`,
  );
};

/** What `origin/sync/resolution` holds for this sync. */
export interface ImportedResolution {
  readonly commit: string;
  /** Every imported rerere id: a stop one replays never reaches `MERGE_RR`, yet the next export needs it. */
  readonly rerere: ReadonlyArray<string>;
  /** The fixups mbox, only when made for this sync's tag. */
  readonly fixups: string | null;
}

/**
 * Import `origin/sync/resolution` before the rebase: its rerere entries join
 * the local rr-cache without replacing one, and its fixups return only when
 * they were made for `tag`. Anything but rerere entries and the mbox refuses
 * the run: the branch is data an agent writes, never code the driver trusts.
 */
export const importResolution = (
  runner: CommandRunner,
  root: string,
  tag: string,
): ImportedResolution | null => {
  const remoteRef = `refs/heads/${SYNC_RESOLUTION_BRANCH}`;
  const listed = gitResult(runner, root, ["ls-remote", "--exit-code", "origin", remoteRef]);
  if (listed.status === 2) return null;
  if (listed.status !== 0 || listed.error !== undefined)
    throw new Error(
      `git ls-remote origin ${remoteRef} failed: ${listed.stderr.trim() || listed.error?.message || "no output"}`,
    );
  git(runner, root, ["fetch", "--no-tags", "origin", `+${remoteRef}:${RESOLUTION_REMOTE_REF}`]);
  const entries = lines(git(runner, root, ["ls-tree", "-r", "--full-tree", RESOLUTION_REMOTE_REF]));
  const rerere: string[] = [];
  let fixups: string | null = null;
  for (const entry of entries) {
    const match = /^100644 blob ([0-9a-f]+)\t(.+)$/.exec(entry);
    const path = match?.[2] ?? entry;
    if (match !== null && RERERE_PATH.test(path)) rerere.push(path);
    else if (match !== null && path === FIXUPS_FILE) fixups = match[1] ?? null;
    else
      throw new Error(
        `origin/${SYNC_RESOLUTION_BRANCH} holds ${path}, which is not resolution data; only rr-cache entries and ${FIXUPS_FILE} import`,
      );
  }
  const commonDir = git(runner, root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const missing = rerere.filter((path) => !NodeFS.existsSync(NodePath.join(commonDir, path)));
  if (missing.length > 0)
    withScratchIndex(runner, root, (gitIndexed) => {
      gitIndexed(["read-tree", RESOLUTION_REMOTE_REF]);
      gitIndexed(["checkout-index", `--prefix=${commonDir}/`, "--", ...missing]);
    });
  const madeFor = git(runner, root, [
    "log",
    "-1",
    `--format=%(trailers:key=${RESOLUTION_TAG_TRAILER},valueonly)`,
    RESOLUTION_REMOTE_REF,
  ]);
  process.stdout.write(
    `sync: imported ${missing.length} rerere entr${missing.length === 1 ? "y" : "ies"} from origin/${SYNC_RESOLUTION_BRANCH}${fixups !== null && madeFor !== tag ? ` (fixups made for ${madeFor || "no tag"} skipped)` : ""}\n`,
  );
  return {
    commit: git(runner, root, ["rev-parse", RESOLUTION_REMOTE_REF]),
    rerere: [...new Set(rerere.map((path) => path.split("/")[1]!))],
    fixups:
      fixups !== null && madeFor === tag
        ? runRequire(runner, "git", ["cat-file", "blob", fixups], { cwd: root })
        : null,
  };
};
