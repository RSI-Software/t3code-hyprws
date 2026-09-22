#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The sync driver bootstraps Git before any Effect runtime exists.
//
// One driver, one run, one exit code, one report. `fork:sync [<tag>] [--dry-run]`
// walks one upstream release tag end to end: target, fetch, rebase, check, push,
// blocked, report. There is no state machine, no gates, no lanes, and no modes —
// a rerun of the same command is always the next move.
//
// | Step    | Fails when                                         |
// | ------- | -------------------------------------------------- |
// | target  | the named target is not a release tag on upstream  |
// | fetch   | the fetch errors                                   |
// | rebase  | a conflict neither rerere nor hook re-apply fixes  |
// | check   | `fork:delta --check`, `fork:ci`, or the typecheck is red |
// | push    | the expected-old lease is refused                  |
// | blocked | `ghb` is unavailable                               |
//
// A failed run — target, fetch, check, push, or a crash — files one issue the
// way a blocked run files its block issue: keyed by the failing step and the
// target tag (the trunk sha before a tag resolves), refreshed by a rerun with
// the same failure, closed by the next clean run.
//
// The typed report at `.t3/fork-sync/<tag>.json` is the only run authority; the
// Markdown this prints is output, never read back. Publication goes through
// `ghb`, never bare `gh`, and nothing is ever posted to upstream.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { parseArgs, UsageError } from "./lib/fork-cli.ts";
import {
  commandText,
  requireCommandSuccess,
  runCommand,
  type CommandResult,
} from "./lib/fork-command.ts";
import { deriveForkHooksIn } from "./lib/fork-hooks.ts";
import { reapplyForkHooks } from "./lib/fork-hook-reapply.ts";
import {
  FORK_REPOSITORY,
  HYPRWS_BRANCH,
  positionUpstreamReleaseTags,
  selectNewestReleaseTag,
} from "./lib/fork-policy.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYNC_DIR = ".t3/fork-sync";
const WORKTREE_DIR = "worktree";
/** ghb issues only this label from the governed set; the title search does the rest. */
const BLOCK_LABEL = "ci";
const BLOCK_TITLE_PHRASE = '"hyprws sync blocked" in:title';
const FAILURE_TITLE_PHRASE = '"hyprws sync failed" in:title';
const REPORT_SCHEMA = "fork.sync-report.v1";
/** The task the sync program files under; taxonomy Source is `repo#number` form. */
const BLOCK_SOURCE_ISSUE = "1151";

const blockIssueTitle = (tag: string, blockingShortSha: string): string =>
  `hyprws sync blocked at ${tag} (upstream ${blockingShortSha})`;

const blockingShaMarker = (sha: string): string => `<!-- blocking-sha:${sha} -->`;
export { blockingShaMarker };

/** A failed run's identity: the failing step plus the target tag or trunk sha. */
const failureIssueTitle = (step: string, key: string): string =>
  `hyprws sync failed at ${step} (${key.length === 40 ? key.slice(0, 7) : key})`;

export const failureMarker = (step: string, key: string): string =>
  `<!-- sync-failure:${step}:${key} -->`;

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export interface CommandSpec {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stream?: boolean;
}

export interface CommandRunner {
  run(command: string, args: ReadonlyArray<string>, spec: CommandSpec): CommandResult;
}

/** The production runner: every command is a real child process. */
export const realRunner: CommandRunner = {
  run: (command, args, spec) =>
    runCommand(command, args, {
      cwd: spec.cwd,
      ...(spec.env === undefined ? {} : { env: spec.env }),
      ...(spec.stream === undefined ? {} : { stream: spec.stream }),
    }),
};

const lines = (value: string): ReadonlyArray<string> =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const gitResult = (
  runner: CommandRunner,
  cwd: string,
  args: ReadonlyArray<string>,
): CommandResult => runner.run("git", args, { cwd });

const git = (runner: CommandRunner, cwd: string, args: ReadonlyArray<string>): string => {
  const result = gitResult(runner, cwd, args);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim() || result.error?.message || "no output"}`,
    );
  return result.stdout.trim();
};

/** A git command whose failure the run itself tolerates. */
const gitAllow = (runner: CommandRunner, cwd: string, args: ReadonlyArray<string>): void => {
  gitResult(runner, cwd, args);
};

const runRequire = (
  runner: CommandRunner,
  command: string,
  args: ReadonlyArray<string>,
  spec: CommandSpec,
): string => requireCommandSuccess(runner.run(command, args, spec), command, args);

/** Best-effort trunk sha for a failure that stops before any tag resolved. */
const trunkSha = (runner: CommandRunner, root: string): string => {
  const result = gitResult(runner, root, ["rev-parse", "HEAD"]);
  return result.status === 0 && result.error === undefined && result.stdout.trim() !== ""
    ? result.stdout.trim()
    : "unknown";
};

// ---------------------------------------------------------------------------
// Typed report
// ---------------------------------------------------------------------------

/** How a conflict row resolved. Rerere's autoupdated replays never leave an unmerged path. */
export const ConflictVia = Schema.Literals(["rerere", "hook", "human"]);

export const ConflictRow = Schema.Struct({
  /** Repo-relative path of the conflicted file. */
  path: Schema.String,
  /** The fork commit being replayed when the path conflicted. */
  forkCommit: Schema.String,
  forkSubject: Schema.String,
  /** The newest upstream commit that touched the path on the target side. */
  upstreamCommit: Schema.String,
  upstreamSubject: Schema.String,
  /** The resolution the run applied, or `human` when the run stopped. */
  via: ConflictVia,
  /** Hook keys re-inserted by hook re-apply; empty for every other row. */
  hooksReapplied: Schema.Array(Schema.String),
  /** Why hook re-apply refused the path; set on `human` rows that carried hooks. */
  refuseReason: Schema.optionalKey(Schema.String),
});
export interface ConflictRow extends Schema.Schema.Type<typeof ConflictRow> {}

/**
 * The typed decision route a stopped run leaves behind. Recovery reads this —
 * resolve the named paths in the named worktree, continue the rebase, rerun.
 */
export const DecisionRoute = Schema.Struct({
  /** The detached worktree holding the stopped rebase; `""` when nothing to resume. */
  worktree: Schema.String,
  /** The paths a human resolves there. */
  paths: Schema.Array(Schema.String),
  /** The exact resume commands, verbatim. */
  resume: Schema.String,
});
export interface DecisionRoute extends Schema.Schema.Type<typeof DecisionRoute> {}

export const CheckRow = Schema.Struct({
  command: Schema.String,
  status: Schema.Literals(["passed", "failed", "skipped"]),
  detail: Schema.String,
});
export interface CheckRow extends Schema.Schema.Type<typeof CheckRow> {}

/** One stale block issue an applied run tried to close after the push. */
export const BlockClosure = Schema.Struct({
  issue: Schema.Number,
  /** Why the claim → comment → close sequence stopped; null when closed. */
  refusal: Schema.NullOr(Schema.String),
});
export interface BlockClosure extends Schema.Schema.Type<typeof BlockClosure> {}

export const ForkSyncReport = Schema.Struct({
  schema: Schema.Literal(REPORT_SCHEMA),
  outcome: Schema.Literals(["applied", "already-applied", "blocked", "failed"]),
  dryRun: Schema.Boolean,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  repository: Schema.String,
  target: Schema.Struct({ tag: Schema.String, sha: Schema.String }),
  /** The documented expected-old lease: the `origin/hyprws` sha the run fetched. */
  lease: Schema.Struct({ expectedOld: Schema.String }),
  trunk: Schema.Struct({
    before: Schema.String,
    /** The rebased tip; `null` when no rebase completed. */
    after: Schema.NullOr(Schema.String),
  }),
  /** The scan base: `git merge-base upstream/main <tip>`. */
  base: Schema.String,
  rerere: Schema.Struct({
    restored: Schema.Boolean,
    saved: Schema.Boolean,
    published: Schema.Boolean,
  }),
  conflicts: Schema.Array(ConflictRow),
  checks: Schema.Array(CheckRow),
  /** The block issues the applied run closed, or failed to close, after the push. */
  closedBlocks: Schema.Array(BlockClosure),
  decision: DecisionRoute,
  blocked: Schema.NullOr(
    Schema.Struct({
      /** The open issue carrying the block; `null` when unfiled or dry-run. */
      issue: Schema.NullOr(Schema.Number),
      title: Schema.String,
      blockingSha: Schema.String,
      publishError: Schema.NullOr(Schema.String),
      /** Which CLI posted: `ghb` when present, `gh` when it cannot spawn. */
      publishedVia: Schema.NullOr(Schema.Literals(["ghb", "gh"])),
    }),
  ),
  /** The one failure issue a non-blocked failed run files; `null` otherwise. */
  failure: Schema.NullOr(
    Schema.Struct({
      /** The open issue carrying the failure; `null` when unfiled or dry-run. */
      issue: Schema.NullOr(Schema.Number),
      title: Schema.String,
      /** The failing step; names the issue and keys its marker. */
      step: Schema.String,
      /** The target tag, or the trunk sha before a tag resolved. */
      key: Schema.String,
      publishError: Schema.NullOr(Schema.String),
      publishedVia: Schema.NullOr(Schema.Literals(["ghb", "gh"])),
    }),
  ),
  push: Schema.Struct({ pushed: Schema.Boolean, detail: Schema.String }),
  error: Schema.NullOr(Schema.String),
});
export interface ForkSyncReport extends Schema.Schema.Type<typeof ForkSyncReport> {}

const emptyDecision = (): DecisionRoute => ({ worktree: "", paths: [], resume: "" });

export const reportPath = (root: string, tag: string): string =>
  NodePath.join(root, SYNC_DIR, `${tag}.json`);

/** Prove the report against its schema, then persist it. Decisions hit disk before any post. */
const writeReport = (root: string, report: ForkSyncReport): string => {
  Schema.decodeUnknownSync(ForkSyncReport)(report);
  const path = reportPath(root, report.target.tag);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
};

/** Post-push recovery reads the typed report, never a rendered comment. */
export const readReport = (root: string, tag: string): ForkSyncReport =>
  Schema.decodeSync(ForkSyncReport)(JSON.parse(NodeFS.readFileSync(reportPath(root, tag), "utf8")));

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/**
 * The release tags upstream published onto `upstream/main`'s first-parent lane,
 * oldest first (`--reverse`), since `positionUpstreamReleaseTags` and
 * `selectNewestReleaseTag` treat a higher first-parent position as newer.
 */
export const releaseTags = (runner: CommandRunner, root: string): ReleaseTag[] => {
  const firstParentShas = lines(
    git(runner, root, ["rev-list", "--first-parent", "--reverse", "upstream/main"]),
  );
  const positioned = positionUpstreamReleaseTags(
    { run: (args) => git(runner, root, args) },
    firstParentShas,
  );
  return positioned
    .toSorted((left, right) => (selectNewestReleaseTag([left, right]) === left ? -1 : 1))
    .map(({ tag, sha }) => ({ tag, sha }));
};

export interface ReleaseTag {
  readonly tag: string;
  readonly sha: string;
}

export const resolveTarget = (
  candidates: ReadonlyArray<ReleaseTag>,
  explicit: string | null,
): ReleaseTag => {
  if (explicit !== null) {
    const named = candidates.find(({ tag }) => tag === explicit);
    if (named === undefined)
      throw new Error(`${explicit} is not a release tag on upstream; pass a v… tag or none`);
    return named;
  }
  const newest = candidates[0];
  if (newest === undefined) throw new Error("upstream publishes no release tags");
  return newest;
};

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

const REBASE_CONFIG = [
  "-c",
  "core.commentChar=auto",
  "-c",
  "diff.algorithm=histogram",
  "-c",
  "rerere.enabled=true",
];

export const worktreePath = (root: string): string => NodePath.join(root, SYNC_DIR, WORKTREE_DIR);

const stageContent = (
  runner: CommandRunner,
  worktree: string,
  stage: 1 | 2 | 3,
  path: string,
): string | null => {
  const result = gitResult(runner, worktree, ["show", `:${stage}:${path}`]);
  return result.status === 0 && result.error === undefined ? result.stdout : null;
};

const upstreamTouch = (
  runner: CommandRunner,
  root: string,
  tagSha: string,
  path: string,
): { sha: string; subject: string } => {
  const raw = git(runner, root, ["log", "-1", "--format=%H%x1f%s", tagSha, "--", path]);
  const [sha = "", subject = ""] = raw.split("\x1f");
  return { sha: sha || tagSha, subject: subject || "" };
};

/**
 * Hook re-apply for one conflicted path: the merged text is the upstream side
 * (`:2:`), the fork side (`:3:`) declares the hooks, and every reinserted key is
 * named. The fork side must be a fully marked insertion — the base stage (`:1:`)
 * equals the fork stage with every marked span removed
 * (RSI-Software/t3code-hyprws#1187); any other shape refuses. `null` when the
 * path is not purely a hook re-insertion.
 */
const reapplyHooks = (
  runner: CommandRunner,
  worktree: string,
  path: string,
): { readonly reinserted: ReadonlyArray<string> } | { readonly refuseReason: string } | null => {
  const base = stageContent(runner, worktree, 1, path);
  const ours = stageContent(runner, worktree, 2, path);
  const theirs = stageContent(runner, worktree, 3, path);
  if (base === null || ours === null || theirs === null) return null;
  let entries;
  try {
    entries = deriveForkHooksIn(path, theirs);
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const marked = new Set<number>();
  for (const entry of entries)
    for (let line = entry.span.startLine; line <= entry.span.endLine; line += 1) marked.add(line);
  // Line arrays, not raw text: the fork blob and the base blob may differ in a
  // trailing newline while carrying the same lines.
  const shape = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
    lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const baseLines = shape(base.split("\n"));
  const forkLines = shape(theirs.split("\n").filter((_, index) => !marked.has(index + 1)));
  const pureInsertion =
    baseLines.length === forkLines.length &&
    baseLines.every((line, index) => line === forkLines[index]);
  if (!pureInsertion)
    return {
      refuseReason:
        "the fork side is not a fully marked insertion: the base stage differs outside the marked region",
    };
  const result = reapplyForkHooks(
    ours,
    theirs,
    entries.map(({ key, anchor, span }) => ({ key, anchor, span })),
  );
  if (result.results.some(({ outcome }) => outcome.status === "refuse"))
    return {
      refuseReason: result.results
        .filter(({ outcome }) => outcome.status === "refuse")
        .map(({ key, outcome }) =>
          outcome.status === "refuse" ? `${key}: ${outcome.reason}` : key,
        )
        .join("; "),
    };
  if (result.reinserted.length === 0) return null;
  NodeFS.writeFileSync(NodePath.join(worktree, path), result.text);
  git(runner, worktree, ["add", "--", path]);
  return { reinserted: result.reinserted };
};

export type RebaseOutcome =
  | {
      readonly status: "applied";
      readonly newSha: string;
      readonly conflicts: ReadonlyArray<ConflictRow>;
    }
  | { readonly status: "blocked"; readonly conflicts: ReadonlyArray<ConflictRow> };

/**
 * Rebase `oldSha` onto `target` in a detached worktree. Known seams resolve by
 * themselves: rerere autoupdate stages them, and hook re-apply re-inserts the
 * marked fork hooks a conflicted file declares. Any path left standing after
 * both stops the run; its rows name the fork commit, the upstream commit, and
 * the worktree a human resumes in.
 */
export const rebaseOnto = (
  runner: CommandRunner,
  root: string,
  target: ReleaseTag,
  oldSha: string,
): RebaseOutcome => {
  const worktree = worktreePath(root);
  gitAllow(runner, root, ["worktree", "remove", "--force", worktree]);
  git(runner, root, ["worktree", "prune"]);
  git(runner, root, ["worktree", "add", "--quiet", "--detach", worktree, oldSha]);
  const editorEnv = { ...process.env, GIT_EDITOR: "true" };
  const rebaseArgs = ["rebase", "--rerere-autoupdate", target.sha];
  const conflicts: ConflictRow[] = [];
  const forkCommitCount = Number(
    git(runner, root, ["rev-list", "--count", `${target.sha}..${oldSha}`]),
  );
  let status = gitResult(runner, worktree, [...REBASE_CONFIG, ...rebaseArgs]);
  let stops = 0;
  while (status.status !== 0) {
    stops += 1;
    if (stops > forkCommitCount + 10)
      throw new Error(`the rebase stopped more times than it had commits to replay (${stops})`);
    if (gitResult(runner, worktree, ["rev-parse", "--verify", "REBASE_HEAD"]).status !== 0)
      throw new Error(
        `git rebase failed without a stop: ${status.stderr.trim() || status.stdout.trim() || "no output"}`,
      );
    const forkCommit = git(runner, worktree, ["rev-parse", "REBASE_HEAD"]);
    const forkSubject = git(runner, worktree, ["log", "-1", "--format=%s", "REBASE_HEAD"]);
    const unmerged = lines(git(runner, worktree, ["diff", "--name-only", "--diff-filter=U"]));
    const human: string[] = [];
    for (const path of unmerged) {
      const touch = upstreamTouch(runner, root, target.sha, path);
      const applied = reapplyHooks(runner, worktree, path);
      if (applied === null || "refuseReason" in applied) {
        human.push(path);
        conflicts.push({
          path,
          forkCommit,
          forkSubject,
          upstreamCommit: touch.sha,
          upstreamSubject: touch.subject,
          via: "human",
          hooksReapplied: [],
          ...(applied !== null ? { refuseReason: applied.refuseReason } : {}),
        });
        continue;
      }
      conflicts.push({
        path,
        forkCommit,
        forkSubject,
        upstreamCommit: touch.sha,
        upstreamSubject: touch.subject,
        via: "hook",
        hooksReapplied: [...applied.reinserted],
      });
    }
    if (human.length > 0) return { status: "blocked", conflicts };
    status = runner.run("git", [...REBASE_CONFIG, "rebase", "--continue"], {
      cwd: worktree,
      env: editorEnv,
    });
  }
  return {
    status: "applied",
    newSha: git(runner, worktree, ["rev-parse", "HEAD"]),
    conflicts,
  };
};

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

const VERIFICATION_ENV_KEYS = [
  // Vite+'s `node_modules/.bin/vp` shim exports an absolute NODE_PATH into the
  // store of the checkout it belongs to; inherited, it pins module resolution
  // for every process below to a foreign store.
  "NODE_PATH",
  "NPM_CONFIG_REGISTRY",
  "VP_ENV_USE_EVAL_ENABLE",
  "VP_NODE_DIST_MIRROR",
  "VP_NODE_SKIP_SIGNATURE_VERIFY",
  "VP_NODE_VERSION",
  // The push credential lives in the Git environment. Check commands run
  // rebased code, which must never see it; the driver's own pushes keep it.
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "HYPRWS_PUSH_TOKEN",
];

/** The worktree's own `.bin` first, and no other checkout's bin directory at all. */
const worktreeExecutablePath = (inherited: string | undefined, worktree: string): string => {
  const worktreeBin = NodePath.join(worktree, "node_modules", ".bin");
  const entries = (inherited ?? "")
    .split(NodePath.delimiter)
    .filter(
      (entry) =>
        entry.length > 0 &&
        entry !== worktreeBin &&
        !NodePath.resolve(entry).split(NodePath.sep).includes("node_modules"),
    );
  return [worktreeBin, ...entries].join(NodePath.delimiter);
};

const verificationEnv = (worktree: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !VERIFICATION_ENV_KEYS.includes(key)),
  ),
  PATH: worktreeExecutablePath(process.env.PATH, worktree),
});

/**
 * Reuse one checkout's pnpm install from the detached worktree: workspace links
 * are copied verbatim so they resolve to the rebased sources, the root store is
 * shared directly.
 */
export const linkInstalledModules = (root: string, worktree: string): void => {
  const copyModuleLinks = (source: string, destination: string): void => {
    NodeFS.mkdirSync(destination, { recursive: true });
    for (const entry of NodeFS.readdirSync(source, { withFileTypes: true })) {
      const sourcePath = NodePath.join(source, entry.name);
      const destinationPath = NodePath.join(destination, entry.name);
      if (entry.isSymbolicLink()) {
        NodeFS.symlinkSync(NodeFS.readlinkSync(sourcePath), destinationPath);
      } else if (entry.isDirectory()) {
        copyModuleLinks(sourcePath, destinationPath);
      } else {
        NodeFS.copyFileSync(sourcePath, destinationPath);
      }
    }
  };
  const visit = (directory: string, depth: number): void => {
    const relative = NodePath.relative(root, directory);
    const sourceModules = NodePath.join(directory, "node_modules");
    const worktreeModules = NodePath.join(worktree, relative, "node_modules");
    if (NodeFS.existsSync(sourceModules) && !NodeFS.existsSync(worktreeModules)) {
      if (relative.length === 0) NodeFS.symlinkSync(sourceModules, worktreeModules, "dir");
      else copyModuleLinks(sourceModules, worktreeModules);
    }
    if (depth === 2) return;
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".repos" ||
        entry.name === ".t3"
      )
        continue;
      visit(NodePath.join(directory, entry.name), depth + 1);
    }
  };
  visit(root, 0);
};

/**
 * The check battery, in the CI shape: the ledger gate, then everything the
 * fork's pull-request CI runs — `vp run fork:ci` derives the pinned scan flags
 * from HEAD (scripts/lib/fork-ci-flags.ts) and runs the rebase scan plus the
 * whole scripts suite — then the repo-wide typecheck the Check job runs as
 * `vpr typecheck`. A direct push to the trunk has no pull request to gate it,
 * so the driver runs the battery itself before the push.
 */
export const checkCommands = (): ReadonlyArray<ReadonlyArray<string>> => [
  ["run", "fork:delta", "--check"],
  ["run", "fork:ci"],
  ["run", "typecheck"],
];

export const runChecks = (
  runner: CommandRunner,
  root: string,
  worktree: string,
): ReadonlyArray<CheckRow> => {
  linkInstalledModules(root, worktree);
  const env = verificationEnv(worktree);
  return checkCommands().map((args) => {
    const result = runner.run("vp", args, { cwd: worktree, env, stream: true });
    return result.status === 0 && result.error === undefined
      ? { command: commandText("vp", args), status: "passed", detail: "" }
      : {
          command: commandText("vp", args),
          status: "failed",
          detail: `${result.stderr.trim() || result.stdout.trim() || "no output"} (exit ${result.status})`,
        };
  });
};

// ---------------------------------------------------------------------------
// Issue publication
// ---------------------------------------------------------------------------

export const blockingShaOf = (conflicts: ReadonlyArray<ConflictRow>): string | null =>
  conflicts.find((row) => row.via === "human")?.upstreamCommit ??
  conflicts[0]?.upstreamCommit ??
  null;

export const blockedIssueBody = (report: ForkSyncReport): string => {
  const cell = (value: string): string =>
    `\`${value.replaceAll("\\", "\\\\").replaceAll("|", "\\|")}\``;
  const blocked = report.blocked!;
  const first = report.conflicts[0];
  return [
    `Origin: hyprws sync run onto ${report.target.tag}; \`vp run fork:sync ${report.target.tag}\`.`,
    "",
    `A sync run rebased \`${HYPRWS_BRANCH}\` onto \`${report.target.tag}\` and stopped at a seam neither rerere nor hook re-apply resolves.`,
    "",
    `Blocking upstream commit: ${cell(`${blocked.blockingSha} ${first?.upstreamSubject ?? ""}`)}`,
    "",
    "| Path | Fork commit | Upstream commit | Refusal |",
    "| --- | --- | --- | --- |",
    ...report.conflicts.map(
      (row) =>
        `| ${cell(row.path)} | ${cell(`${row.forkCommit.slice(0, 7)} ${row.forkSubject}`)} | ${cell(`${row.upstreamCommit.slice(0, 7)} ${row.upstreamSubject}`)} | ${cell(row.refuseReason ?? "-")} |`,
    ),
    "",
    "## Resume",
    "",
    "The typed report is the authority; this issue is a projection of it.",
    "",
    "```bash",
    report.decision.resume,
    "```",
    "",
    "A rerun on the same upstream commit updates this issue; a clean run closes it.",
    `Report: \`${SYNC_DIR}/${report.target.tag}.json\` (schema \`${REPORT_SCHEMA}\`).`,
    "",
    blockingShaMarker(blocked.blockingSha),
  ].join("\n");
};

export interface OpenBlockIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export interface GitHub {
  /** Which CLI posts the writes: `ghb` when present, `gh` when `ghb` cannot spawn. */
  readonly route: "ghb" | "gh";
  /** Open issues under the governed label matching one title phrase. */
  readonly list: (titlePhrase: string) => ReadonlyArray<OpenBlockIssue>;
  readonly create: (title: string, bodyPath: string) => number | null;
  /** Take the issue so the completed close finds an assignee; a no-op on `gh`. */
  readonly claim: (issue: number) => void;
  readonly comment: (issue: number, bodyPath: string) => void;
  readonly close: (issue: number) => void;
}

/** The governed filing ghb performs; `gh` cannot set these fields. */
const ghbCreateArgs = (repo: ReadonlyArray<string>, title: string, bodyPath: string) => [
  "issue",
  "create",
  ...repo,
  "--title",
  title,
  "--body-file",
  bodyPath,
  "--type",
  "Notification 🔔",
  "--priority",
  "High",
  "--filed-by",
  "Agent 🤖",
  "--source",
  BLOCK_SOURCE_ISSUE,
  "--label",
  BLOCK_LABEL,
  "--no-project",
  "--no-relationship",
];

/**
 * `ghb` first: its filing is governed and attested. CI has no `ghb`, so when the
 * binary cannot spawn at all the writes fall back to bare `gh` with the same
 * body, title, and marker. A `ghb` that runs but refuses never falls back — the
 * refusal is the observation, and `gh` must not route around governance.
 */
export const githubClient = (runner: CommandRunner, root: string): GitHub => {
  const repo = ["--repo", FORK_REPOSITORY];
  const probe = runner.run("ghb", ["--version"], { cwd: root });
  const route = probe.error === undefined ? "ghb" : "gh";
  const list = (titlePhrase: string) =>
    JSON.parse(
      runRequire(
        runner,
        "gh",
        [
          "issue",
          "list",
          "--state",
          "open",
          "--label",
          BLOCK_LABEL,
          "--search",
          titlePhrase,
          ...repo,
          "--json",
          "number,title,body",
        ],
        { cwd: root },
      ),
    ) as ReadonlyArray<OpenBlockIssue>;
  if (route === "gh")
    return {
      route,
      list,
      create: (title, bodyPath) => {
        const result = runner.run(
          "gh",
          [
            "issue",
            "create",
            ...repo,
            "--title",
            title,
            "--body-file",
            bodyPath,
            "--label",
            BLOCK_LABEL,
          ],
          { cwd: root },
        );
        if (result.status !== 0 || result.error !== undefined)
          throw new Error(
            `gh issue create failed: ${result.stderr.trim() || result.stdout.trim() || result.error?.message || "no output"}`,
          );
        const url = /issues\/(\d+)/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
        return url === undefined ? null : Number(url);
      },
      claim: () => {
        // bare `gh` has no completed-close preconditions, so there is no claim to mirror
      },
      comment: (issue, bodyPath) => {
        runRequire(
          runner,
          "gh",
          ["issue", "comment", String(issue), ...repo, "--body-file", bodyPath],
          { cwd: root },
        );
      },
      close: (issue) => {
        runRequire(
          runner,
          "gh",
          ["issue", "close", String(issue), "--reason", "completed", ...repo],
          { cwd: root },
        );
      },
    };
  return {
    route,
    list,
    create: (title, bodyPath) => {
      const result = runner.run("ghb", ghbCreateArgs(repo, title, bodyPath), { cwd: root });
      if (result.status !== 0 || result.error !== undefined)
        throw new Error(
          `ghb issue create refused: ${result.stderr.trim() || result.stdout.trim() || result.error?.message || "no output"}`,
        );
      const url = /issues\/(\d+)/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
      return url === undefined ? null : Number(url);
    },
    claim: (issue) => {
      // the driver files parentless with --no-project, so the claim must judge
      // the intake Standalone 📍 or ghb refuses it
      runRequire(runner, "ghb", ["issue", "claim", String(issue), "--standalone", ...repo], {
        cwd: root,
      });
    },
    comment: (issue, bodyPath) => {
      runRequire(
        runner,
        "ghb",
        ["issue", "comment", String(issue), ...repo, "--body-file", bodyPath],
        { cwd: root },
      );
    },
    close: (issue) => {
      // no --comment: the attested comment published before this check is the evidence
      runRequire(
        runner,
        "ghb",
        ["issue", "close", String(issue), "--reason", "completed", ...repo],
        { cwd: root },
      );
    },
  };
};

const withBodyFile = <T>(body: string, effect: (path: string) => T): T => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-body-"));
  const path = NodePath.join(directory, "body.md");
  NodeFS.writeFileSync(path, body);
  try {
    return effect(path);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

/**
 * Upsert the one open issue keyed by `marker`: a matching issue gets the body
 * as a comment, otherwise the title files a fresh one. The typed report is the
 * authority; this projection happens beside it.
 */
const upsertMarkerIssue = (
  runner: CommandRunner,
  root: string,
  titlePhrase: string,
  marker: string,
  title: string,
  body: string,
): { readonly issue: number | null; readonly publishedVia: "ghb" | "gh" } => {
  const github = githubClient(runner, root);
  const existing = github.list(titlePhrase).find((issue) => issue.body.includes(marker));
  return withBodyFile(body, (bodyPath) => {
    if (existing !== undefined) {
      github.comment(existing.number, bodyPath);
      return { issue: existing.number, publishedVia: github.route };
    }
    return { issue: github.create(title, bodyPath), publishedVia: github.route };
  });
};

/**
 * Upsert the one open block issue keyed by the blocking sha. A `ghb` that
 * refuses is the raw observation printed with the body, and the run exits
 * non-zero with `blocked.publishError` set on the report.
 */
export const publishBlock = (
  runner: CommandRunner,
  root: string,
  report: ForkSyncReport,
): ForkSyncReport => {
  const blocked = report.blocked!;
  const body = blockedIssueBody(report);
  try {
    const { issue, publishedVia } = upsertMarkerIssue(
      runner,
      root,
      BLOCK_TITLE_PHRASE,
      blockingShaMarker(blocked.blockingSha),
      blocked.title,
      body,
    );
    return {
      ...report,
      blocked: {
        ...blocked,
        ...(issue === null ? {} : { issue }),
        publishError: null,
        publishedVia,
      },
    };
  } catch (error) {
    process.stdout.write(`${body}\n`);
    return {
      ...report,
      blocked: {
        ...blocked,
        publishError: error instanceof Error ? error.message : String(error),
        publishedVia: null,
      },
    };
  }
};

/** The applied-sha note the attested close comment carries; it is the close evidence. */
const blockCloseComment = (newSha: string): string => `Resolved by ${HYPRWS_BRANCH} ${newSha}.`;

/**
 * A clean run closes every open sync issue — block and failure alike: the trunk
 * moved, so none can hold. The ghb completed close refuses without an assignee
 * and without attested evidence naming a default-branch sha, and `--comment`
 * publishes after that check, so the sequence is claim, attested sha comment,
 * then close. Each issue reports its own refusal; one refusal never stops the
 * other closes.
 */
export const failureIssueBody = (report: ForkSyncReport): string => {
  const failure = report.failure!;
  const command =
    report.target.tag === "" ? "vp run fork:sync" : `vp run fork:sync ${report.target.tag}`;
  const subject =
    report.target.tag !== ""
      ? report.target.tag
      : report.trunk.before === ""
        ? "the trunk"
        : report.trunk.before.slice(0, 7);
  return [
    `Origin: hyprws sync run onto ${subject}; \`${command}\`.`,
    "",
    `A sync run failed at the \`${failure.step}\` step:`,
    "",
    "```",
    report.error ?? "unknown error",
    "```",
    ...(report.checks.length === 0
      ? []
      : [
          "",
          "| Check | Verdict |",
          "| --- | --- |",
          ...report.checks.map((check) => `| \`${check.command}\` | ${check.status} |`),
        ]),
    "",
    "A rerun with the same failure updates this issue; a clean run closes it.",
    ...(report.target.tag === ""
      ? []
      : [`Report: \`${SYNC_DIR}/${report.target.tag}.json\` (schema \`${REPORT_SCHEMA}\`).`]),
    "",
    failureMarker(failure.step, failure.key),
  ].join("\n");
};

/**
 * Upsert the one open failure issue keyed by the failing step and the target
 * tag (the trunk sha before a tag resolves), exactly as `publishBlock` does
 * for a block. A refusal prints the body and sets `failure.publishError`.
 */
export const publishFailure = (
  runner: CommandRunner,
  root: string,
  report: ForkSyncReport,
): ForkSyncReport => {
  const failure = report.failure!;
  const body = failureIssueBody(report);
  try {
    const { issue, publishedVia } = upsertMarkerIssue(
      runner,
      root,
      FAILURE_TITLE_PHRASE,
      failureMarker(failure.step, failure.key),
      failure.title,
      body,
    );
    return {
      ...report,
      failure: {
        ...failure,
        ...(issue === null ? {} : { issue }),
        publishError: null,
        publishedVia,
      },
    };
  } catch (error) {
    process.stdout.write(`${body}\n`);
    return {
      ...report,
      failure: {
        ...failure,
        publishError: error instanceof Error ? error.message : String(error),
        publishedVia: null,
      },
    };
  }
};
export const closeBlocks = (
  runner: CommandRunner,
  root: string,
  newSha: string,
): ReadonlyArray<BlockClosure> => {
  const github = githubClient(runner, root);
  const closures: BlockClosure[] = [];
  for (const titlePhrase of [BLOCK_TITLE_PHRASE, FAILURE_TITLE_PHRASE])
    for (const issue of github.list(titlePhrase)) {
      try {
        github.claim(issue.number);
        withBodyFile(blockCloseComment(newSha), (path) => github.comment(issue.number, path));
        github.close(issue.number);
        closures.push({ issue: issue.number, refusal: null });
      } catch (error) {
        closures.push({
          issue: issue.number,
          refusal: error instanceof Error ? error.message : String(error),
        });
      }
    }
  return closures;
};

// ---------------------------------------------------------------------------
// Rendering — output only, never read back
// ---------------------------------------------------------------------------

export const renderReport = (report: ForkSyncReport): string => {
  const head = {
    applied: "✅ applied",
    "already-applied": "✅ already applied",
    blocked: "🛑 blocked",
    failed: "❌ failed",
  }[report.outcome];
  const rows = [
    `Run: ${head}${report.dryRun ? " (dry run)" : ""} — ${report.target.tag}@${report.target.sha.slice(0, 7)}`,
    `Trunk: ${report.trunk.before.slice(0, 7)} → ${report.trunk.after === null ? "unchanged" : report.trunk.after.slice(0, 7)}`,
    `Lease: origin/${HYPRWS_BRANCH} at ${report.lease.expectedOld.slice(0, 7)}`,
    `Report: ${SYNC_DIR}/${report.target.tag}.json`,
  ];
  const blocks =
    report.closedBlocks.length === 0
      ? []
      : [
          "",
          ...report.closedBlocks.map(({ issue, refusal }) =>
            refusal === null
              ? `- ✅ closed block #${issue}`
              : `- ❌ block #${issue} close refused: ${refusal}`,
          ),
        ];
  const conflictTable =
    report.conflicts.length === 0
      ? []
      : [
          "",
          "| Path | Fork commit | Upstream commit | Via |",
          "| --- | --- | --- | --- |",
          ...report.conflicts.map(
            (row) =>
              `| \`${row.path}\` | \`${row.forkCommit.slice(0, 7)} ${row.forkSubject}\` | \`${row.upstreamCommit.slice(0, 7)} ${row.upstreamSubject}\` | ${row.via}${row.hooksReapplied.length > 0 ? ` (${row.hooksReapplied.join(", ")})` : ""} |`,
          ),
        ];
  const checks =
    report.checks.length === 0
      ? []
      : [
          "",
          ...report.checks.map(
            (check) => `- ${check.status === "passed" ? "✅" : "❌"} \`${check.command}\``,
          ),
        ];
  const decision =
    report.decision.worktree === ""
      ? []
      : [
          "",
          "## Decision route",
          "",
          `Worktree: \`${report.decision.worktree}\``,
          `Paths: ${report.decision.paths.map((path) => `\`${path}\``).join(", ")}`,
          "",
          "```bash",
          report.decision.resume,
          "```",
        ];
  const failure = report.error === null ? [] : ["", `Error: ${report.error}`];
  return [...rows, ...conflictTable, ...checks, ...blocks, ...decision, ...failure].join("\n");
};

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RunOptions {
  readonly runner?: CommandRunner;
  readonly root?: string;
  readonly now?: () => Date;
}

const USAGE = "usage: vp run fork:sync [<tag>] [--dry-run]";

export const run = (argv: ReadonlyArray<string>, options: RunOptions = {}): number => {
  const runner = options.runner ?? realRunner;
  const root = options.root ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  let parsed;
  try {
    parsed = parseArgs(argv, { positionals: { min: 0, max: 1 }, flags: ["--dry-run"] });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 1;
  }
  const dryRun = parsed.flags.has("--dry-run");
  const explicit = parsed.positionals[0] ?? null;
  // The failing step names the failure issue; it advances as the run does.
  let step = "fetch";
  // The resolved target, kept for the catch: it keys the failure issue when a
  // crash lands after the target resolved.
  let resolved: ReleaseTag | null = null;

  const finish = (report: ForkSyncReport): number => {
    const path = writeReport(root, report);
    process.stdout.write(`${renderReport(report)}\n${path}\n`);
    return report.error === null &&
      (report.outcome === "applied" || report.outcome === "already-applied")
      ? 0
      : 1;
  };

  try {
    // fetch — the tag list and the trunk lease both come from the remotes
    git(runner, root, ["fetch", "--tags", "upstream"]);
    git(runner, root, ["fetch", "origin", HYPRWS_BRANCH]);
    const expectedOld = git(runner, root, ["rev-parse", `origin/${HYPRWS_BRANCH}`]);
    const mergeBase = (tip: string): string =>
      git(runner, root, ["merge-base", "upstream/main", tip]);

    const frame = (partial: Partial<ForkSyncReport>): ForkSyncReport => ({
      schema: REPORT_SCHEMA,
      outcome: "failed",
      dryRun,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      repository: FORK_REPOSITORY,
      target: { tag: target.tag, sha: target.sha },
      lease: { expectedOld },
      trunk: { before: expectedOld, after: null },
      base: mergeBase(expectedOld),
      rerere: { restored: false, saved: false, published: false },
      conflicts: [],
      checks: [],
      closedBlocks: [],
      decision: emptyDecision(),
      blocked: null,
      failure: null,
      push: { pushed: false, detail: "" },
      error: null,
      ...partial,
    });

    // target — a tag the fork already sits on exits clean with `already applied`,
    // after closing the stale sync issues a previous run left open
    step = "target";
    const target = resolveTarget(releaseTags(runner, root), explicit);
    resolved = target;

    /**
     * A failed run files one issue the way a blocked one does: the report
     * persists first, the issue upserts beside it, and a dry run never files.
     */
    const fail = (partial: Partial<ForkSyncReport>): number => {
      const failure: ForkSyncReport["failure"] = {
        issue: null,
        title: failureIssueTitle(step, target.tag),
        step,
        key: target.tag,
        publishError: null,
        publishedVia: null,
      };
      const failed = frame({ ...partial, failure });
      writeReport(root, failed);
      process.stdout.write(`${renderReport(failed)}\n`);
      if (dryRun) return 1;
      const published = publishFailure(runner, root, failed);
      const path = writeReport(root, published);
      process.stdout.write(
        published.failure?.publishError !== null && published.failure?.publishError !== undefined
          ? `failure publication failed: ${published.failure.publishError}\n${path}\n`
          : `${path}\n`,
      );
      return 1;
    };

    /**
     * The one close pass every clean outcome shares: the trunk resolved the
     * stale sync issues — block and failure alike — so none can hold. This runs
     * before the report writes, so a refused close lands in the typed report
     * and the summary instead of dying as a hidden note on stderr.
     */
    const closeStaleBlocks = (
      resolvedSha: string,
    ): { readonly closed: ReadonlyArray<BlockClosure>; readonly error: string | null } => {
      let closed: ReadonlyArray<BlockClosure> = [];
      let failure: string | null = null;
      try {
        closed = closeBlocks(runner, root, resolvedSha);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      const refused = closed.filter((closure) => closure.refusal !== null);
      return {
        closed,
        error:
          failure ??
          (refused.length === 0
            ? null
            : `closing stale block issues failed: ${refused
                .map(({ issue, refusal }) => `#${issue}: ${refusal}`)
                .join("; ")}`),
      };
    };

    if (
      gitResult(runner, root, ["merge-base", "--is-ancestor", target.sha, expectedOld]).status === 0
    ) {
      const close = closeStaleBlocks(expectedOld);
      return finish(
        frame({
          outcome: "already-applied",
          trunk: { before: expectedOld, after: expectedOld },
          closedBlocks: [...close.closed],
          ...(close.error === null ? {} : { error: close.error }),
        }),
      );
    }

    // rebase
    step = "rebase";
    // No shared cache: the runner is ephemeral, so nothing published could replay
    // on the next run. Local rerere still replays within this rebase.
    const rerere = { restored: false, saved: false, published: false };
    const rebase = rebaseOnto(runner, root, target, expectedOld);

    if (rebase.status === "blocked") {
      const humanPaths = rebase.conflicts
        .filter((row) => row.via === "human")
        .map((row) => row.path);
      const blockingSha = blockingShaOf(rebase.conflicts) ?? target.sha;
      const worktree = worktreePath(root);
      // decisions persist before any comment posts
      const blockedReport = frame({
        outcome: "blocked",
        rerere: { ...rerere },
        conflicts: [...rebase.conflicts],
        decision: {
          worktree,
          paths: humanPaths,
          resume: [
            `git -C ${worktree} add -- ${humanPaths.map((path) => `"${path}"`).join(" ")}`,
            `git -C ${worktree} rebase --continue`,
            `vp run fork:sync ${target.tag}${dryRun ? " --dry-run" : ""}`,
          ].join("\n"),
        },
        blocked: {
          issue: null,
          title: blockIssueTitle(target.tag, blockingSha.slice(0, 7)),
          blockingSha,
          publishError: null,
          publishedVia: null,
        },
        error: `blocked by ${blockingSha.slice(0, 7)}: ${humanPaths.length} path${humanPaths.length === 1 ? "" : "s"} neither rerere nor hook re-apply resolves`,
      });
      writeReport(root, blockedReport);
      process.stdout.write(`${renderReport(blockedReport)}\n`);
      if (dryRun) {
        process.stdout.write(`${blockedIssueBody(blockedReport)}\n`);
        return 1;
      }
      const published = publishBlock(runner, root, blockedReport);
      const path = writeReport(root, published);
      process.stdout.write(
        published.blocked?.publishError !== null && published.blocked?.publishError !== undefined
          ? `block publication failed: ${published.blocked.publishError}\n${path}\n`
          : `${path}\n`,
      );
      return 1;
    }
    const newSha = rebase.newSha;

    // check
    step = "check";
    const checks = runChecks(runner, root, worktreePath(root));
    if (checks.some((check) => check.status === "failed")) {
      gitAllow(runner, root, ["worktree", "remove", "--force", worktreePath(root)]);
      return fail({
        rerere: { ...rerere },
        conflicts: [...rebase.conflicts],
        checks,
        error: "the check battery is red",
      });
    }

    // push — the documented expected-old lease; a dry run reaches applied without it
    step = "push";
    if (dryRun) {
      gitAllow(runner, root, ["worktree", "remove", "--force", worktreePath(root)]);
      return finish(
        frame({
          outcome: "applied",
          trunk: { before: expectedOld, after: newSha },
          rerere: { ...rerere },
          conflicts: [...rebase.conflicts],
          checks,
          push: { pushed: false, detail: "dry run" },
        }),
      );
    }
    const pushed = gitResult(runner, root, [
      "push",
      "origin",
      `${newSha}:${HYPRWS_BRANCH}`,
      `--force-with-lease=${HYPRWS_BRANCH}:${expectedOld}`,
    ]);
    const pushRefused = pushed.status !== 0 || pushed.error !== undefined;
    gitAllow(runner, root, ["worktree", "remove", "--force", worktreePath(root)]);
    if (pushRefused)
      return fail({
        rerere: { ...rerere },
        conflicts: [...rebase.conflicts],
        checks,
        error: `push refused: ${pushed.stderr.trim() || pushed.error?.message || "unknown"}`,
      });

    // a clean run closes the block issues it made stale, whether the rebase
    // moved the trunk or the trunk already sat on the target
    const close = closeStaleBlocks(newSha);
    const report = finish(
      frame({
        outcome: "applied",
        trunk: { before: expectedOld, after: newSha },
        rerere: { ...rerere },
        conflicts: [...rebase.conflicts],
        checks,
        push: { pushed: true, detail: `${newSha.slice(0, 7)} → origin/${HYPRWS_BRANCH}` },
        closedBlocks: [...close.closed],
        ...(close.error === null ? {} : { error: close.error }),
      }),
    );
    return report;
  } catch (error) {
    const message =
      error instanceof UsageError || error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    // The failure issue keys on the target tag when one resolved or was named,
    // else the trunk sha; the report still needs a tag, so a crash before any
    // tag writes none.
    const tag = resolved?.tag ?? explicit ?? "";
    const key = resolved?.tag ?? explicit ?? trunkSha(runner, root);
    try {
      const report: ForkSyncReport = {
        schema: REPORT_SCHEMA,
        outcome: "failed",
        dryRun,
        startedAt: startedAt.toISOString(),
        finishedAt: now().toISOString(),
        repository: FORK_REPOSITORY,
        target: { tag, sha: "" },
        lease: { expectedOld: "" },
        trunk: { before: "", after: null },
        base: "",
        rerere: { restored: false, saved: false, published: false },
        conflicts: [],
        checks: [],
        closedBlocks: [],
        decision: emptyDecision(),
        blocked: null,
        failure: {
          issue: null,
          title: failureIssueTitle(step, key),
          step,
          key,
          publishError: null,
          publishedVia: null,
        },
        push: { pushed: false, detail: "" },
        error: message,
      };
      if (dryRun) {
        if (tag === "") return 1;
        return finish(report);
      }
      if (tag === "") {
        // No tag keys a report; the failure issue carries the run instead.
        const published = publishFailure(runner, root, report);
        if (
          published.failure?.publishError !== null &&
          published.failure?.publishError !== undefined
        )
          process.stdout.write(`failure publication failed: ${published.failure.publishError}\n`);
        return 1;
      }
      writeReport(root, report);
      process.stdout.write(`${renderReport(report)}\n`);
      const published = publishFailure(runner, root, report);
      const path = writeReport(root, published);
      process.stdout.write(
        published.failure?.publishError !== null && published.failure?.publishError !== undefined
          ? `failure publication failed: ${published.failure.publishError}\n${path}\n`
          : `${path}\n`,
      );
      return 1;
    } catch {
      return 1;
    }
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
