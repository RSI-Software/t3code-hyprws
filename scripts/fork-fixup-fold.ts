#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This pre-pull-request check runs before an Effect runtime exists.

// The sync folds every `fixup! <owner subject>` into the commit it names
// during its rebase, so a fixup that only applies at the branch tip lands
// green in pull-request CI and then blocks the next sync
// (RSI-Software/t3code-hyprws#1554). This check proves the folds before
// landing: it replays the trunk-plus-branch stack from the upstream base with
// the sync's own fixup placement (`resolveFixups` and the sequence editor),
// in a throwaway repository, and requires a stop-free replay whose tree equals
// the unfolded tip. Rerere stays off: a recorded resolution would mask a stop
// the replay must report. A stack without fixups skips the replay entirely.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FIXUP_PREFIX } from "./fork-delta.ts";
import { resolveFixups, type SubjectCommit } from "./fork-sync.ts";
import { parseArgs, UsageError } from "./lib/fork-cli.ts";
import { runCommand } from "./lib/fork-command.ts";
import { SystemGit } from "./lib/fork-git-reader.ts";
import { FIXUP_OWNERS_ENV, sequenceEditor } from "./lib/fork-sync-todo.ts";

const HELP = `Usage: vp run fork:fixup-fold [--base <ref>] [--head <ref>]

Proves every fixup! commit in <base>..<head> folds into the commit it names.
The sync rebase folds each fixup into its owner, so a fixup that only applies
at the branch tip lands green in pull-request CI and then blocks the next
sync (RSI-Software/t3code-hyprws#1554). The replay runs the stack from
<base> in a throwaway repository with the sync's own fixup placement and
requires no stops and a tree equal to the unfolded tip. A stack without
fixups skips the replay.
`;

/** The sync rebase's config, minus rerere: the proof must see the raw fold, never a recorded resolution. */
const REPLAY_CONFIG = [
  "-c",
  "core.commentChar=auto",
  "-c",
  "diff.algorithm=histogram",
  "-c",
  "rerere.enabled=false",
  "-c",
  "maintenance.auto=false",
  "-c",
  "commit.gpgsign=false",
];

const shortSha = (sha: string): string => sha.slice(0, 7);

const stackSubjects = (git: SystemGit, base: string, head: string): ReadonlyArray<SubjectCommit> =>
  git
    .run(["log", "--reverse", "--format=%H%x1f%s", `${base}..${head}`])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\u001f");
      return { sha, subject };
    });

/**
 * Fetch, in one batch, every blob the replay reads (the base tree and the
 * stack's commits) that a partial clone lacks. CI checks out `blob:none`, and
 * the replay runs in a scratch repository with no promisor remote: a folded
 * blob another fetched ref already holds (a sync candidate) reads to a
 * promisor clone as remote-only, so git fetches it instead of writing it, and
 * a lazy fetch of a just-written blob is refused ("not our ref").
 */
const hydrateStack = (git: SystemGit, base: string, head: string): void => {
  const promisor = /^remote\.(.+)\.promisor true$/m.exec(
    git.runResult(["config", "--get-regexp", String.raw`^remote\..*\.promisor$`]).stdout,
  )?.[1];
  if (promisor === undefined) return;
  const missingIn = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
    git
      .run(["rev-list", "--objects", "--missing=print", ...args])
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1));
  const missing = [
    ...new Set([...missingIn(["--no-walk", base]), ...missingIn([`${base}..${head}`])]),
  ];
  if (missing.length === 0) return;
  const fetch = runCommand(
    "git",
    [
      "-c",
      "fetch.negotiationAlgorithm=noop",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--filter=blob:none",
      promisor,
      "--stdin",
    ],
    { cwd: git.cwd, input: `${missing.join("\n")}\n` },
  );
  if (fetch.status !== 0)
    throw new Error(`could not fetch the stack's blobs from ${promisor}: ${fetch.stderr.trim()}`);
};

/** Git's default diff context: a fold applies only while these lines around each edit match. */
const FOLD_CONTEXT = 3;

/**
 * The newest stack commit that shaped the lines a fixup edits or the context
 * around them, when that is not the fixup's owner. Those lines did not exist
 * yet at the owner, which is why the fold stopped; naming that commit instead
 * folds. Blame stops at `base`, so upstream history is never walked.
 */
const retargetFor = (
  git: SystemGit,
  base: string,
  fixup: string,
  owner: string,
  stack: ReadonlyArray<SubjectCommit>,
): string | undefined => {
  const order = new Map(stack.map((commit, index) => [commit.sha, index]));
  let newest = order.get(owner) ?? -1;
  let path = "";
  for (const line of git
    .run(["-c", "core.quotePath=false", "diff", "--unified=0", `${fixup}^`, fixup])
    .split("\n")) {
    if (line.startsWith("--- ")) path = line.startsWith("--- a/") ? line.slice(6) : "";
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (hunk === null || path === "") continue;
    const start = Number(hunk[1]);
    const count = Number(hunk[2] ?? 1);
    const blob = git.run(["cat-file", "-p", `${fixup}^:${path}`]);
    // A final line without a newline is still a line blame can name.
    const length = blob === "" ? 0 : blob.split("\n").length - (blob.endsWith("\n") ? 1 : 0);
    const from = Math.max(1, start - FOLD_CONTEXT + (count === 0 ? 1 : 0));
    const to = Math.min(length, start + Math.max(count, 1) - 1 + FOLD_CONTEXT);
    if (from > to) continue;
    const blame = git.run([
      "blame",
      "--porcelain",
      "-L",
      `${from},${to}`,
      `${base}..${fixup}^`,
      "--",
      path,
    ]);
    for (const [, sha = ""] of blame.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)) {
      const index = order.get(sha) ?? -1;
      if (index > newest && !(stack[index]?.subject ?? "").startsWith(FIXUP_PREFIX)) newest = index;
    }
  }
  const target = stack[newest];
  return target === undefined || target.sha === owner ? undefined : target.sha;
};

/**
 * A scratch repository that borrows `root`'s objects through alternates and
 * writes its own. Without a promisor remote, a blob it lacks fails loudly
 * instead of fetching.
 */
const scratchRepository = (git: SystemGit): string => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-fixup-fold-"));
  const objects = git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  new SystemGit(repo).run(["init", "--quiet"]);
  NodeFS.writeFileSync(
    NodePath.join(repo, ".git", "objects", "info", "alternates"),
    `${NodePath.join(objects, "objects")}\n`,
  );
  return repo;
};

/**
 * Every reason the fixups in `base..head` do not fold at their owners, or an
 * empty array when the stack carries no fixup or every fold replays cleanly.
 * The replay runs in a scratch repository under the system temp dir, removed
 * again before this returns.
 */
export const fixupFoldFailures = (
  root: string,
  base: string,
  head: string,
): ReadonlyArray<string> => {
  const git = new SystemGit(root);
  const subjects = stackSubjects(git, base, head);
  if (!subjects.some((commit) => commit.subject.startsWith(FIXUP_PREFIX))) return [];
  const fixups = resolveFixups(subjects);
  if (fixups.refusals.length > 0) return fixups.refusals;

  const nameOf = new Map(subjects.map((commit) => [commit.sha, commit.subject]));
  const subjectOf = (sha: string): string => nameOf.get(sha) ?? "unknown";
  const name = (sha: string): string => `${subjectOf(sha)} (${shortSha(sha)})`;
  hydrateStack(git, base, head);
  const repo = scratchRepository(git);
  try {
    const resolve = (ref: string): string =>
      git.run(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
    const replay = new SystemGit(repo);
    replay.run(["checkout", "--quiet", "--detach", resolve(head)]);
    // The merge base, not `base` itself: upstream may have moved past the commit the stack sits on.
    const onto = git.run(["merge-base", resolve(base), resolve(head)]).trim();
    const result = runCommand("git", [...REPLAY_CONFIG, "rebase", "-i", "--autosquash", onto], {
      cwd: repo,
      env: {
        ...process.env,
        // Only the discarded replay commits need an identity; preserve the original authors.
        GIT_COMMITTER_NAME: "Fork Fixup Fold",
        GIT_COMMITTER_EMAIL: "fork-fixup-fold@example.invalid",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: sequenceEditor(),
        [FIXUP_OWNERS_ENV]: JSON.stringify(fixups.owners),
      },
    });
    if (result.status !== 0) {
      const stopped = replay.runResult(["rev-parse", "--verify", "REBASE_HEAD"]);
      const stoppedSha = stopped.status === 0 ? stopped.stdout.trim() : "";
      const pair = fixups.owners.find(([fixup]) => stoppedSha.startsWith(fixup));
      let retarget: string | undefined;
      if (pair !== undefined)
        try {
          retarget = retargetFor(git, base, pair[0], pair[1], subjects);
        } catch {
          // The hint is advisory; the refusal stands without it.
        }
      const reason =
        pair === undefined
          ? stoppedSha === ""
            ? "the replay failed before applying a commit"
            : `the replay stopped at ${name(stoppedSha)}`
          : `fixup "${subjectOf(pair[0])}" (${shortSha(pair[0])}) does not fold into its owner "${subjectOf(pair[1])}" (${shortSha(pair[1])}): the replay stopped applying it there` +
            (retarget === undefined
              ? ""
              : `; name "${subjectOf(retarget)}" (${shortSha(retarget)}) instead, the newest commit that changed the lines around this edit`);
      const detail = [result.stderr.trim(), result.error?.message].filter(Boolean).join("\n");
      return [detail === "" ? reason : `${reason}\n${detail}`];
    }
    const replayedTree = replay.run(["rev-parse", "HEAD^{tree}"]).trim();
    const tipTree = git.run(["rev-parse", `${head}^{tree}`]).trim();
    if (replayedTree !== tipTree)
      return [
        `the replayed tip tree ${shortSha(replayedTree)} differs from the unfolded tip tree ${shortSha(tipTree)}: a fixup did not fold`,
      ];
    return [];
  } finally {
    NodeFS.rmSync(repo, { recursive: true, force: true });
  }
};

export const run = (argv: ReadonlyArray<string>, cwd = process.cwd()): number => {
  if (argv.some((argument) => argument === "-h" || argument === "--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  let base: string;
  let head: string;
  try {
    const { values } = parseArgs(argv, { values: ["--base", "--head"] });
    base = values.get("--base") ?? "upstream/main";
    head = values.get("--head") ?? "HEAD";
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
    return 2;
  }
  const failures = fixupFoldFailures(cwd, base, head);
  if (failures.length === 0) return 0;
  process.stderr.write(
    `${failures.join("\n")}\n` +
      "a fixup! commit must fold into the commit it names: the sync folds each one during its rebase, so a fixup that only applies at the branch tip blocks the next sync; fold it into its owner (fork-fold) or reword it\n",
  );
  return 1;
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
