#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The sync driver bootstraps Git before any Effect runtime exists.

// One driver, one run, one exit code, one report. `fork:sync [<tag>] [--dry-run]`
// walks one upstream release tag end to end: target, fetch, rebase, ci, push,
// blocked, report. There is no state machine, no gates, no lanes, and no modes —
// a rerun of the same command is always the next move.
//
// The sync worktree is the carrier between runs. A run records its tag, target
// sha, lease, and every stop's conflict rows beside it; a rerun on the same
// three adopts the kept worktree — continuing a resolved rebase, or taking a
// finished HEAD with any reshape extras committed there — and reports every
// stop so far. A red candidate or a green dry run keeps it too, so a fix
// commits there and the real run publishes the tip CI proved. A different tag
// or a moved lease recreates it. A new worktree runs the repo's own worktree
// setup step, so a stop already has dependencies.
//
// | Step    | Fails when                                         |
// | ------- | -------------------------------------------------- |
// | target  | the named target is not a release tag on upstream  |
// | fetch   | the fetch errors                                   |
// | rebase  | a conflict neither rerere nor hook re-apply fixes  |
// | ci      | hyprws CI is not green on the candidate tip        |
// | push    | the expected-old lease is refused                  |
// | blocked | `gh` refuses the write                             |
//
// A failed run — target, fetch, ci, push, or a crash — files one issue the
// way a blocked run files its block issue: keyed by the failing step and the
// target tag (the trunk sha before a tag resolves), refreshed by a rerun with
// the same failure, closed by the next clean run.
//
// The typed report at `.t3/fork-sync/<tag>.json` is the only run authority; the
// Markdown this prints is output, never read back. Publication goes through
// plain `gh`, and nothing is ever posted to upstream.
//
// The trunk moves only to a sha hyprws CI already passed: the driver pushes
// the rebased tip to the candidate branch, waits for the CI run on that exact
// sha, and lease-pushes the same sha. CI is the one check authority: the
// local `vp run fork:ci` before a candidate push only refuses what CI would
// refuse sooner, and a green preflight never stands in for the run.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import { FIXUP_PREFIX, fixupTarget } from "./fork-delta.ts";
import {
  forkPullRequests,
  linkFindings,
  memberLine,
  readStack,
  squashesLines,
  systemFoldGit,
  withoutSquashes,
  type FoldCommit,
} from "./fork-fold.ts";
import { FORK_CI_WORKFLOW_PATH } from "./lib/fork-ci-flags.ts";
import { parseArgs, UsageError } from "./lib/fork-cli.ts";
import {
  commandText,
  requireCommandSuccess,
  runCommand,
  type CommandResult,
} from "./lib/fork-command.ts";
import { deriveForkHooksIn } from "./lib/fork-hooks.ts";
import { reapplyForkHooks } from "./lib/fork-hook-reapply.ts";
import { mergeLicenseLists } from "./lib/fork-license-merge.ts";
import {
  FORK_REPOSITORY,
  HYPRWS_BRANCH,
  positionUpstreamReleaseTags,
  selectNewestReleaseTag,
  SYNC_CANDIDATE_BRANCH,
} from "./lib/fork-policy.ts";
import { FIXUP_OWNERS_ENV, FOLD_MESSAGES_ENV, sequenceEditor } from "./lib/fork-sync-todo.ts";
import { splitTrailerBlock } from "./lib/fork-trailers.ts";

const SYNC_DIR = ".t3/fork-sync";
const WORKTREE_DIR = "worktree";
/** The attention issue keeps the governed label and outcome-shaped legacy titles. */
const BLOCK_LABEL = "ci";
const BLOCK_TITLE_PHRASE = '"hyprws sync blocked" in:title';
const FAILURE_TITLE_PHRASE = '"hyprws sync failed" in:title';
const REPORT_SCHEMA = "fork.sync-report.v2";

/** Stable per step and target, so a rerun refreshes the issue without renaming it. */
const syncIssueTitle = (outcome: "blocked" | "failed", step: string, key: string): string =>
  `hyprws sync ${outcome} at ${step} (${key.length === 40 ? key.slice(0, 7) : key})`;

const blockingShaMarker = (sha: string): string => `<!-- blocking-sha:${sha} -->`;
export { blockingShaMarker };

export const failureMarker = (step: string, key: string): string =>
  `<!-- sync-failure:${step}:${key} -->`;

export interface CommandSpec {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stream?: boolean;
  readonly timeout?: number;
  readonly input?: string;
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
      ...(spec.timeout === undefined ? {} : { timeout: spec.timeout }),
      ...(spec.input === undefined ? {} : { input: spec.input }),
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

/** How a conflict row resolved: hook re-apply, an accepted net-zero delete, regeneration, or a manual resolution. */
export const ConflictVia = Schema.Literals(["hook", "manual", "net-zero-delete", "regenerate"]);

/** The recorded reason when an upstream deletion meets a net-zero fork edit. */
export const NET_ZERO_REASON = "upstream deleted; fork edit is net-zero";

export const ConflictRow = Schema.Struct({
  /** Repo-relative path of the conflicted file. */
  path: Schema.String,
  /** The fork commit being replayed when the path conflicted. */
  forkCommit: Schema.String,
  forkSubject: Schema.String,
  /** The newest upstream commit that touched the path on the target side. */
  upstreamCommit: Schema.String,
  upstreamSubject: Schema.String,
  /** The resolution the run applied, or `manual` when the run stopped. */
  via: ConflictVia,
  /** Hook keys re-inserted by hook re-apply; empty for every other row. */
  hooksReapplied: Schema.Array(Schema.String),
  /** Why hook re-apply refused the path; set on `manual` rows that carried hooks. */
  refuseReason: Schema.optionalKey(Schema.String),
  /** Why an automatic rule resolved the path; set on `net-zero-delete` and `regenerate` rows. */
  reason: Schema.optionalKey(Schema.String),
});
export interface ConflictRow extends Schema.Schema.Type<typeof ConflictRow> {}

/**
 * The typed decision route a stopped run or a green dry run leaves behind.
 * Recovery reads this — resolve the named paths in the named worktree, continue
 * the rebase, rerun; after a green dry run, the real run publishes the kept tip.
 */
export const DecisionRoute = Schema.Struct({
  /** The detached worktree holding the stopped rebase or kept tip; `""` when nothing to resume. */
  worktree: Schema.String,
  /** The rebased tip a red candidate or a green dry run left in the worktree; trunk did not move. */
  tip: Schema.optionalKey(Schema.String),
  /** The paths resolved by hand there. */
  paths: Schema.Array(Schema.String),
  /** The exact resume commands, verbatim. */
  resume: Schema.String,
});
export interface DecisionRoute extends Schema.Schema.Type<typeof DecisionRoute> {}

/** One hyprws CI job on the candidate sha, as GitHub concluded it. */
export const CiJob = Schema.Struct({
  name: Schema.String,
  /** GitHub's conclusion: `success`, `failure`, `cancelled`, `skipped`, … */
  conclusion: Schema.String,
  url: Schema.String,
});
export interface CiJob extends Schema.Schema.Type<typeof CiJob> {}

/** The hyprws CI verdict on the candidate sha: the one gate before the trunk push. */
export const CandidateCi = Schema.Struct({
  /** The run's URL; `""` when no run started. */
  run: Schema.String,
  /**
   * GitHub's run conclusion (`failure` as soon as one job fails), `never started` / `timed out`
   * when the wait gave up, or `skipped: local fork:ci failed …` when the preflight refused the push.
   */
  conclusion: Schema.String,
  jobs: Schema.Array(CiJob),
});
export interface CandidateCi extends Schema.Schema.Type<typeof CandidateCi> {}

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
  /** Every stop's rows, earlier runs on the same kept worktree included, in stop order. */
  conflicts: Schema.Array(ConflictRow),
  /** hyprws CI on the candidate sha; `null` when no rebase completed. */
  ci: Schema.NullOr(CandidateCi),
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
      publishedVia: Schema.NullOr(Schema.Literal("gh")),
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
      publishedVia: Schema.NullOr(Schema.Literal("gh")),
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
  decodeForkSyncReport(JSON.parse(NodeFS.readFileSync(reportPath(root, tag), "utf8")));

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

/**
 * `maintenance.auto=false`: every `git commit` the sequencer runs would
 * otherwise detach a `git maintenance run --auto` whose `rerere gc` holds
 * MERGE_RR.lock while the next pick conflicts, and the rebase dies on that lock
 * after clearing REBASE_HEAD but before recording the stop.
 */
const REBASE_CONFIG = [
  "-c",
  "core.commentChar=auto",
  "-c",
  "diff.algorithm=histogram",
  "-c",
  "rerere.enabled=true",
  "-c",
  "maintenance.auto=false",
];

export const worktreePath = (root: string): string => NodePath.join(root, SYNC_DIR, WORKTREE_DIR);

/**
 * What the kept sync worktree was built for and what it carries between runs.
 * A rerun adopts it only when tag, target, and lease match exactly.
 */
const WorktreeState = Schema.Struct({
  tag: Schema.String,
  targetSha: Schema.String,
  lease: Schema.String,
  /** Every stop's rows so far, so the run that finishes the rebase reports them all. */
  conflicts: Schema.optionalKey(Schema.Array(ConflictRow)),
  /** Where the rebase finished; commits above it are tip work a recreated worktree carries. */
  rebased: Schema.optionalKey(Schema.String),
});
interface WorktreeState extends Schema.Schema.Type<typeof WorktreeState> {}
const decodeWorktreeState = Schema.decodeUnknownSync(WorktreeState);

const worktreeStatePath = (root: string): string =>
  NodePath.join(root, SYNC_DIR, `${WORKTREE_DIR}.json`);

const writeWorktreeState = (root: string, state: WorktreeState): void =>
  NodeFS.writeFileSync(worktreeStatePath(root), `${JSON.stringify(state, null, 2)}\n`);

/** The kept worktree's state when it was built for `expected`'s tag, target, and lease. */
const readWorktreeState = (root: string): WorktreeState | null => {
  try {
    return decodeWorktreeState(JSON.parse(NodeFS.readFileSync(worktreeStatePath(root), "utf8")));
  } catch {
    return null;
  }
};

const keptWorktreeState = (
  runner: CommandRunner,
  root: string,
  expected: WorktreeState,
): WorktreeState | null => {
  const state = readWorktreeState(root);
  if (state === null) return null;
  return state.tag === expected.tag &&
    state.targetSha === expected.targetSha &&
    state.lease === expected.lease &&
    gitResult(runner, worktreePath(root), ["rev-parse", "--verify", "HEAD"]).status === 0
    ? state
    : null;
};

/**
 * The stops recorded so far plus this run's, one row per fork commit and path:
 * re-entering a stop that is still unresolved replaces its rows in place.
 */
const mergeStops = (
  carried: ReadonlyArray<ConflictRow>,
  current: ReadonlyArray<ConflictRow>,
): ReadonlyArray<ConflictRow> => {
  const rows = new Map<string, ConflictRow>();
  for (const row of [...carried, ...current]) rows.set(`${row.forkCommit}\0${row.path}`, row);
  return [...rows.values()];
};

/**
 * Run the setup step the worktree's `t3.json` marks `runOnWorktreeCreate`, as
 * T3 Code runs it for a thread worktree (`scripts/setup-worktree.ts` here: it
 * installs dependencies). It runs in a scrubbed environment, so the push
 * credential and the live instance's variables never reach it.
 */
const runWorktreeSetup = (runner: CommandRunner, root: string, worktree: string): void => {
  let contents: string;
  try {
    contents = NodeFS.readFileSync(NodePath.join(worktree, "t3.json"), "utf8");
  } catch {
    return;
  }
  const setup = parseT3ProjectFile(contents)?.scripts?.find(
    (script) => script.runOnWorktreeCreate === true,
  );
  if (setup === undefined) return;
  process.stdout.write(`sync: running worktree setup '${setup.command}' in ${worktree}\n`);
  runRequire(runner, "sh", ["-c", setup.command], {
    cwd: worktree,
    env: {
      ...verificationEnv(worktree),
      ...projectScriptRuntimeEnv({ project: { cwd: root }, worktreePath: worktree }),
    },
    stream: true,
  });
};

/**
 * Tip commits a dropped worktree held, oldest first, waiting to apply to the
 * new rebase. Refs keep them reachable and recorded through a failed setup, a
 * conflicting pick, or a killed run; they go only once the carry lands.
 */
const CARRY_REFS = "refs/fork-sync/carry/";

const carriedCommits = (runner: CommandRunner, root: string): ReadonlyArray<string> =>
  lines(
    git(runner, root, ["for-each-ref", "--sort=refname", "--format=%(objectname)", CARRY_REFS]),
  );

/** Replace the carry in one ref transaction, so no crash leaves part of it. */
const writeCarry = (runner: CommandRunner, root: string, commits: ReadonlyArray<string>): void => {
  const refs = commits.map((_, index) => `${CARRY_REFS}${String(index).padStart(4, "0")}`);
  const stale = lines(
    git(runner, root, ["for-each-ref", "--format=%(refname)", CARRY_REFS]),
  ).filter((ref) => !refs.includes(ref));
  const input = [
    ...stale.map((ref) => `delete ${ref}\n`),
    ...refs.map((ref, index) => `update ${ref} ${commits[index]}\n`),
  ].join("");
  if (input !== "") runRequire(runner, "git", ["update-ref", "--stdin"], { cwd: root, input });
};

/**
 * Before a moved lease or a new tag drops the worktree to rebase from scratch,
 * the tip commits above its finished rebase (the fixups a red candidate
 * needed) become the carry. They already hold any earlier carry that landed;
 * one still picking, or not yet started, stays as it is.
 */
const saveTipCommits = (runner: CommandRunner, root: string): void => {
  const state = readWorktreeState(root);
  const worktree = worktreePath(root);
  // The ancestry check runs first: it also fails, without throwing, on a
  // worktree an earlier removal already took.
  if (
    state?.rebased === undefined ||
    gitResult(runner, worktree, ["merge-base", "--is-ancestor", state.rebased, "HEAD"]).status !==
      0 ||
    pickInProgress(runner, worktree)
  )
    return;
  const tip = lines(git(runner, worktree, ["rev-list", "--reverse", `${state.rebased}..HEAD`]));
  if (tip.length > 0) writeCarry(runner, root, tip);
};

const pickInProgress = (runner: CommandRunner, worktree: string): boolean =>
  gitResult(runner, worktree, ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"]).status === 0 ||
  NodeFS.existsSync(
    git(runner, worktree, ["rev-parse", "--path-format=absolute", "--git-path", "sequencer"]),
  );

/**
 * Apply the carry above the finished rebase. A stopped pick stays for the
 * operator to resolve and `git add`; the rerun continues it. A HEAD already
 * above the rebase with no pick running means the carry landed by hand.
 */
const applyCarry = (
  runner: CommandRunner,
  root: string,
  worktree: string,
  rebased: string,
): void => {
  const carry = carriedCommits(runner, root);
  if (carry.length === 0) return;
  const env = { ...process.env, GIT_EDITOR: "true" };
  let args: ReadonlyArray<string> | null = null;
  if (pickInProgress(runner, worktree)) args = ["cherry-pick", "--continue"];
  else if (git(runner, worktree, ["rev-parse", "HEAD"]) === rebased) {
    process.stdout.write(`sync: carrying ${carry.length} tip commit(s) onto the new rebase\n`);
    args = ["cherry-pick", ...carry];
  }
  if (args !== null) {
    const picked = runner.run("git", [...REBASE_CONFIG, ...args], { cwd: worktree, env });
    if (picked.status !== 0 || picked.error !== undefined)
      throw new Error(
        `a tip commit carried from the dropped sync worktree stops on a conflict in ${worktree}; resolve it, git add, then rerun`,
      );
  }
  writeCarry(runner, root, []);
};

/**
 * Drop the sync worktree and its state; the carry refs outlive it. The state
 * goes first, so a killed removal never leaves state naming a missing worktree.
 */
const dropWorktree = (runner: CommandRunner, root: string): void => {
  NodeFS.rmSync(worktreeStatePath(root), { force: true });
  gitAllow(runner, root, ["worktree", "remove", "--force", worktreePath(root)]);
};

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
 * Hook re-apply for one conflicted path: the merged text is upstream's (`:2:`) and the fork side
 * (`:3:`) declares the hooks. The fork side must be a fully marked insertion (the base stage `:1:`
 * equals it with every marked span removed); `null` for any other shape.
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
  const theirsLines = theirs.split("\n");
  const baseSplit = base.split("\n");
  const spanText = (lines: ReadonlyArray<string>, span: { startLine: number; endLine: number }) =>
    lines.slice(span.startLine - 1, span.endLine).join("\n");
  const marked = new Set<number>();
  for (const entry of entries)
    for (let line = entry.span.startLine; line <= entry.span.endLine; line += 1) marked.add(line);
  // An earlier commit's hook sits in the base too; strip it only when this
  // commit leaves it byte-identical, so an edited hook still refuses instead
  // of re-applying as `intact` with its old text.
  const theirsHooks = new Map(entries.map(({ key, span }) => [key, spanText(theirsLines, span)]));
  let baseEntries: ReturnType<typeof deriveForkHooksIn> = [];
  try {
    baseEntries = deriveForkHooksIn(path, base);
  } catch {}
  const baseMarked = new Set<number>();
  for (const { key, span } of baseEntries)
    if (theirsHooks.get(key) === spanText(baseSplit, span))
      for (let line = span.startLine; line <= span.endLine; line += 1) baseMarked.add(line);
  // Line arrays, not raw text: the fork blob and the base blob may differ in a
  // trailing newline while carrying the same lines.
  const shape = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
    lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const baseLines = shape(baseSplit.filter((_, index) => !baseMarked.has(index + 1)));
  const forkLines = shape(theirsLines.filter((_, index) => !marked.has(index + 1)));
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

/**
 * A generated path a conflict regenerates instead of stopping. A `generator` route reruns a `vp`
 * command; `from: "root"` runs the trunk checkout's copy with its install against the replay
 * worktree, whose own copy may be mid-replay. A `merge` route merges the three stages and formats.
 */
export type RegenerationRoute =
  | {
      readonly path: string;
      /** The `vp` argv that regenerates the path. */
      readonly generator: ReadonlyArray<string>;
      readonly from: "root" | "worktree";
    }
  | {
      readonly path: string;
      readonly merge: typeof mergeLicenseLists;
      /** The key the merge unions entries on, as the runbook and report rows name it. */
      readonly by: string;
    };

/**
 * Every generated path the stop loop regenerates, in run order: the lockfile
 * first. The Regenerable files table in docs/fork/operations/fork-sync.md
 * lists the same rows.
 */
export const REGENERATION_ROUTES: ReadonlyArray<RegenerationRoute> = [
  { path: "pnpm-lock.yaml", generator: ["install", "--lockfile-only"], from: "worktree" },
  {
    path: "third-party-licenses.config.json",
    merge: mergeLicenseLists,
    by: "package name",
  },
  {
    path: "apps/web/src/routeTree.gen.ts",
    generator: ["run", "fork:regenerate-route-tree"],
    from: "root",
  },
];

export const resolverText = (route: RegenerationRoute): string =>
  "generator" in route ? commandText("vp", route.generator) : `merge by ${route.by}`;

/**
 * Resolve and stage one generated path. A generator route restores it from `HEAD` (the target plus
 * the fork commits replayed so far) and reruns its generator; a merge route merges the stages and
 * formats. Returns the failure detail, or `null` once staged.
 */
const regenerate = (
  runner: CommandRunner,
  root: string,
  worktree: string,
  route: RegenerationRoute,
): string | null => {
  if ("merge" in route) {
    const merged = route.merge({
      base: stageContent(runner, worktree, 1, route.path),
      upstream: stageContent(runner, worktree, 2, route.path),
      fork: stageContent(runner, worktree, 3, route.path),
    });
    if ("refuseReason" in merged) return merged.refuseReason;
    NodeFS.writeFileSync(NodePath.join(worktree, route.path), merged.text);
    const formatted = runner.run("vp", ["fmt", route.path], {
      cwd: worktree,
      env: verificationEnv(worktree),
    });
    if (formatted.status !== 0 || formatted.error !== undefined)
      return checkFailureDetail(formatted);
    git(runner, worktree, ["add", "--", route.path]);
    return null;
  }
  git(runner, worktree, ["restore", "--source=HEAD", "--staged", "--worktree", "--", route.path]);
  const cwd = route.from === "root" ? root : worktree;
  const args = route.from === "root" ? [...route.generator, worktree] : route.generator;
  const result = runner.run("vp", args, { cwd, env: verificationEnv(cwd) });
  if (result.status !== 0 || result.error !== undefined) return checkFailureDetail(result);
  git(runner, worktree, ["add", "--", route.path]);
  return null;
};

export type RebaseOutcome =
  | {
      readonly status: "applied";
      readonly newSha: string;
      readonly conflicts: ReadonlyArray<ConflictRow>;
    }
  | {
      readonly status: "blocked";
      readonly conflicts: ReadonlyArray<ConflictRow>;
    };

export interface SubjectCommit {
  readonly sha: string;
  readonly subject: string;
}

export interface FixupResolution {
  /** `[fixup sha, owner sha]`, oldest fixup first. */
  readonly owners: ReadonlyArray<readonly [fixup: string, owner: string]>;
  readonly refusals: ReadonlyArray<string>;
}

/**
 * Resolve each `fixup!` commit to the one fork commit above `target` it names.
 * A name absent from, or named more than once by, the stack refuses before the
 * rebase starts: an orphan would silently become a regular commit, and an
 * ambiguous name could fold into the wrong commit.
 */
export const resolveFixups = (commits: ReadonlyArray<SubjectCommit>): FixupResolution => {
  const ownerShas = new Map<string, Array<string>>();
  for (const commit of commits) {
    if (commit.subject.startsWith(FIXUP_PREFIX)) continue;
    ownerShas.set(commit.subject, [...(ownerShas.get(commit.subject) ?? []), commit.sha]);
  }
  const owners: Array<readonly [string, string]> = [];
  const refusals: Array<string> = [];
  for (const { sha, subject } of commits) {
    const named = fixupTarget(subject, ownerShas);
    if (named === undefined) continue;
    const shas = ownerShas.get(named) ?? [];
    const [owner] = shas;
    if (owner === undefined)
      refusals.push(`fixup "${subject}" names no fork commit above the target`);
    else if (shas.length > 1)
      refusals.push(`fixup "${subject}" names ${shas.length} fork commits above the target`);
    else owners.push([sha, owner]);
  }
  return { owners, refusals };
};

/**
 * Each owner's message after the sync folds its fixups: a `Squashes:` section above its trailer
 * block lists owner and fixups as fork:fold renders a fold, so a squash landing's PR link survives.
 * A fixup citing no fork pull request keeps nothing, so its owner is absent from the map and folds
 * as git's plain `fixup`.
 */
export const foldSyncMessages = (
  commits: ReadonlyArray<FoldCommit>,
  owners: ReadonlyArray<readonly [fixup: string, owner: string]>,
): ReadonlyMap<string, string> => {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit] as const));
  const fixupsOf = new Map<string, Array<FoldCommit>>();
  for (const [fixup, owner] of owners) {
    const commit = bySha.get(fixup);
    if (commit === undefined) throw new Error(`fixup ${fixup} is not a commit above the target`);
    fixupsOf.set(owner, [...(fixupsOf.get(owner) ?? []), commit]);
  }
  const messages = new Map<string, string>();
  for (const [owner, fixups] of fixupsOf) {
    if (!fixups.some((fixup) => forkPullRequests(fixup.message).length > 0)) continue;
    const ownerCommit = bySha.get(owner);
    if (ownerCommit === undefined)
      throw new Error(`fixup owner ${owner} is not a commit above the target`);
    messages.set(owner, foldedOwnerMessage(ownerCommit, fixups));
  }
  return messages;
};

/**
 * One folded owner message: subject and prose, then the `Squashes:` section (this fold's members,
 * then an earlier fold's member lines, so a refold keeps every link), then the trailer block
 * verbatim. The section shape is foldMessage's, so no second rendering exists.
 */
const foldedOwnerMessage = (owner: FoldCommit, fixups: ReadonlyArray<FoldCommit>): string => {
  const [subject = "", ...rest] = owner.message.replace(/\r\n/g, "\n").split("\n");
  const { head, trailers } = splitTrailerBlock(rest.join("\n"));
  const members = [
    ...new Set([
      memberLine(owner),
      ...fixups.map((fixup) => memberLine(fixup)),
      ...squashesLines(owner.message),
    ]),
  ];
  const prose = withoutSquashes(head);
  return [
    subject,
    ...(prose.length === 0 ? [] : ["", prose]),
    "",
    "Squashes:",
    "",
    ...members,
    ...(trailers.length === 0 ? [] : ["", trailers]),
  ].join("\n");
};

/**
 * The link guard: a sync rewrites the trunk directly, so it refuses a rebased tip where a pull
 * request an old fork commit cites is cited by no new commit. A commit the target already carries
 * (an exact upstream backport, or every path it touched identical to the target) retires its link.
 */
export const refuseDroppedLinks = (
  root: string,
  target: ReleaseTag,
  oldSha: string,
  newSha: string,
): void => {
  const stackGit = systemFoldGit(root);
  const upstreamed = new Set(
    stackGit
      .text(["cherry", target.sha, oldSha])
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2)),
  );
  const old = readStack(stackGit, target.sha, oldSha);
  const superseded = (commit: FoldCommit): boolean =>
    commit.files.length > 0 &&
    stackGit.text(["diff", "--name-only", target.sha, newSha, "--", ...commit.files]) === "";
  const findings = linkFindings(
    {
      ...old,
      commits: old.commits.filter((commit) => !upstreamed.has(commit.sha) && !superseded(commit)),
    },
    readStack(stackGit, target.sha, newSha),
  );
  if (findings.length > 0)
    throw new Error(
      `the rebased tip dropped ${findings.length} pull request link(s):\n${findings.join("\n")}`,
    );
};

/**
 * Rebase `oldSha` onto `target` in a detached worktree. A fork landing that
 * amends a fork commit is titled `fixup! <subject>`, with ` (#N)` appended
 * when squash-landed; the rebase runs interactive with `--autosquash` and a
 * sequence editor that places each resolved fixup under its owner, so the
 * fixup folds into the commit it names and the series never carries
 * fix-of-fix (RSI-Software/t3code-hyprws#1179, RSI-Software/t3code-hyprws#1508). A squash-landed fixup keeps its PR
 * link: the editor appends an `exec` that amends the folded owner with the
 * `Squashes:` rendering fork:fold writes (RSI-Software/t3code-hyprws#1591, RSI-Software/t3code-hyprws#1592), and the link
 * guard refuses the rebased tip when it dropped a link. Hook re-apply
 * re-inserts the marked fork hooks a conflicted file declares. A delete/modify
 * whose deletion is on the upstream side and whose fork edit nets to zero
 * against the base the fork stack sits on accepts the deletion outright. A
 * path in `REGENERATION_ROUTES` regenerates once every other path in the stop
 * has resolved (RSI-Software/t3code-hyprws#1488). Any path left standing after
 * those stops the run; its rows name the fork commit, the upstream commit, and
 * the worktree the rebase resumes in.
 *
 * A kept worktree built for the same tag, target, and lease is adopted
 * instead: a rebase in progress re-enters the stop loop, so unresolved paths
 * block again and resolved ones continue; a finished HEAD is taken as the
 * rebased tip as long as it contains the target.
 *
 * `conflicts` collects this run's rows as they happen; `rebaseOnto` owns it.
 */
const replayOnto = (
  runner: CommandRunner,
  root: string,
  target: ReleaseTag,
  oldSha: string,
  adopted: boolean,
  conflicts: ConflictRow[],
): RebaseOutcome => {
  const worktree = worktreePath(root);
  // The fork stack above `target` sits on this upstream commit — for a normal
  // run the previous release tag. Net-zero compares the fork trunk to it from
  // real refs, once per run, never from the worktree.
  const baseSha = git(runner, root, ["merge-base", target.sha, oldSha]);
  const stack = readStack(systemFoldGit(root), target.sha, oldSha);
  const fixups = resolveFixups(stack.commits);
  if (fixups.refusals.length > 0) throw new Error(fixups.refusals.join("; "));
  // Each owner absorbing a squash-landed fixup amends its folded message after
  // the rebase writes it, so the fixup's PR link survives as a `Squashes:`
  // member line. The message files live in the worktree's git dir: an exec
  // line a rerun's kept todo still holds must find its file.
  const foldDir = git(runner, worktree, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "fork-sync-folds",
  ]);
  NodeFS.mkdirSync(foldDir, { recursive: true });
  const foldFiles = [...foldSyncMessages(stack.commits, fixups.owners)].map(([owner, message]) => {
    const path = NodePath.join(foldDir, `${owner}.msg`);
    NodeFS.writeFileSync(path, message);
    return [owner, path] as const;
  });
  const editorEnv = {
    ...process.env,
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: sequenceEditor(),
    [FIXUP_OWNERS_ENV]: JSON.stringify(fixups.owners),
    [FOLD_MESSAGES_ENV]: JSON.stringify(foldFiles),
  };
  const rebaseArgs = ["rebase", "-i", "--autosquash", "--rerere-autoupdate", target.sha];
  const forkCommitCount = Number(
    git(runner, root, ["rev-list", "--count", `${target.sha}..${oldSha}`]),
  );
  const rebaseInProgress = (): boolean =>
    NodeFS.existsSync(
      git(runner, worktree, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge"]),
    );
  if (adopted && !rebaseInProgress()) {
    const head = git(runner, worktree, ["rev-parse", "HEAD"]);
    if (gitResult(runner, root, ["merge-base", "--is-ancestor", target.sha, head]).status !== 0)
      throw new Error(
        `the kept sync worktree at ${worktree} holds ${head.slice(0, 7)}, which does not contain ${target.tag}; reset it to a rebased tip and rerun`,
      );
    refuseDroppedLinks(root, target, oldSha, head);
    return { status: "applied", newSha: head, conflicts: [] };
  }
  // An adopted rebase in progress enters the stop loop as if it had just stopped.
  let status: CommandResult = adopted
    ? { status: 1, stdout: "", stderr: "" }
    : runner.run("git", [...REBASE_CONFIG, ...rebaseArgs], { cwd: worktree, env: editorEnv });
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
    const manual: string[] = [];
    const regenerable = new Map<string, { sha: string; subject: string }>();
    for (const path of unmerged) {
      const touch = upstreamTouch(runner, root, target.sha, path);
      // A generated path waits for every source path to resolve: its
      // generator reads them.
      if (REGENERATION_ROUTES.some((route) => route.path === path)) {
        regenerable.set(path, touch);
        continue;
      }
      // Delete/modify with the deletion on the upstream (rebase base) side:
      // when the fork trunk's final blob for the path equals the base blob,
      // the fork edit is net-zero and the deletion is accepted outright. Any
      // other delete/modify shape falls through to hook re-apply, which
      // refuses it, and then to a manual row.
      if (
        stageContent(runner, worktree, 2, path) === null &&
        stageContent(runner, worktree, 3, path) !== null &&
        gitResult(runner, root, ["diff", "--quiet", baseSha, oldSha, "--", path]).status === 0
      ) {
        git(runner, worktree, ["rm", "--quiet", "--", path]);
        conflicts.push({
          path,
          forkCommit,
          forkSubject,
          upstreamCommit: touch.sha,
          upstreamSubject: touch.subject,
          via: "net-zero-delete",
          hooksReapplied: [],
          reason: NET_ZERO_REASON,
        });
        continue;
      }
      const applied = reapplyHooks(runner, worktree, path);
      if (applied === null || "refuseReason" in applied) {
        manual.push(path);
        conflicts.push({
          path,
          forkCommit,
          forkSubject,
          upstreamCommit: touch.sha,
          upstreamSubject: touch.subject,
          via: "manual",
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
    if (manual.length > 0) return { status: "blocked", conflicts };
    for (const route of REGENERATION_ROUTES) {
      const touch = regenerable.get(route.path);
      if (touch === undefined) continue;
      const failure = regenerate(runner, root, worktree, route);
      const row = {
        path: route.path,
        forkCommit,
        forkSubject,
        upstreamCommit: touch.sha,
        upstreamSubject: touch.subject,
        hooksReapplied: [],
      };
      if (failure === null) {
        conflicts.push({
          ...row,
          via: "regenerate",
          reason:
            "merge" in route ? `merged by ${route.by}` : `regenerated by ${resolverText(route)}`,
        });
        continue;
      }
      manual.push(route.path);
      conflicts.push({
        ...row,
        via: "manual",
        refuseReason: `${resolverText(route)} failed: ${failure}`,
      });
    }
    if (manual.length > 0) return { status: "blocked", conflicts };
    status = runner.run("git", [...REBASE_CONFIG, "rebase", "--continue"], {
      cwd: worktree,
      env: editorEnv,
    });
  }
  const newSha = git(runner, worktree, ["rev-parse", "HEAD"]);
  refuseDroppedLinks(root, target, oldSha, newSha);
  return {
    status: "applied",
    newSha,
    conflicts,
  };
};

/** A sync rebase as the run sees it: this run's replay plus what the kept worktree carries. */
export type SyncRebase = RebaseOutcome & {
  /** Every stop's rows, earlier runs on the same kept worktree included, in stop order. */
  readonly recorded: ReadonlyArray<ConflictRow>;
};

/**
 * Rebase `oldSha` onto `target` in the kept sync worktree (see `replayOnto`).
 * A new worktree runs the repo's setup step before the rebase starts, so a
 * stop has dependencies. Each stop's rows persist beside the worktree as they
 * are recorded, so the run that finishes the rebase still reports them.
 */
export const rebaseOnto = (
  runner: CommandRunner,
  root: string,
  target: ReleaseTag,
  oldSha: string,
): SyncRebase => {
  const worktree = worktreePath(root);
  const expected: WorktreeState = { tag: target.tag, targetSha: target.sha, lease: oldSha };
  let state = keptWorktreeState(runner, root, expected);
  const adopted = state !== null;
  if (state === null) {
    saveTipCommits(runner, root);
    dropWorktree(runner, root);
    git(runner, root, ["worktree", "prune"]);
    git(runner, root, ["worktree", "add", "--quiet", "--detach", worktree, oldSha]);
    runWorktreeSetup(runner, root, worktree);
    state = expected;
    writeWorktreeState(root, state);
  }
  const carried = state.conflicts ?? [];
  const conflicts: ConflictRow[] = [];
  let outcome: RebaseOutcome;
  try {
    outcome = replayOnto(runner, root, target, oldSha, adopted, conflicts);
  } finally {
    state = { ...state, conflicts: mergeStops(carried, conflicts) };
    writeWorktreeState(root, state);
  }
  const recorded = mergeStops(carried, outcome.conflicts);
  if (outcome.status === "blocked") return { ...outcome, recorded };
  // Only the run that finishes the rebase records it: an adopted finished
  // worktree's HEAD already holds tip work above it.
  const rebased = state.rebased ?? outcome.newSha;
  writeWorktreeState(root, { ...state, rebased });
  applyCarry(runner, root, worktree, rebased);
  return { ...outcome, newSha: git(runner, worktree, ["rev-parse", "HEAD"]), recorded };
};

const VERIFICATION_ENV_KEYS = new Set([
  // Vite+'s `node_modules/.bin/vp` shim exports an absolute NODE_PATH into the
  // store of the checkout it belongs to; inherited, it pins module resolution
  // for every process below to a foreign store.
  "NODE_PATH",
  "NPM_CONFIG_REGISTRY",
  "VP_ENV_USE_EVAL_ENABLE",
  "VP_NODE_DIST_MIRROR",
  "VP_NODE_SKIP_SIGNATURE_VERIFY",
  "VP_NODE_VERSION",
  // The push credential lives in the Git environment. Setup and regeneration
  // run rebased code, which must never see it; the driver's own pushes keep it.
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "HYPRWS_PUSH_TOKEN",
  // The server's GitHub code reads these to pick its repository and host; CI
  // sets neither. `GH_TOKEN` stays: it only authenticates.
  "GH_HOST",
  "GH_REPO",
]);

/**
 * A shell inside T3 Code inherits the live instance's own variables: its home,
 * port, and service-launcher context. CI has none, and rebased code must
 * never reach live state, so every one of them is scrubbed.
 */
const VERIFICATION_ENV_PREFIX = /^T3(?:CODE)?_/;

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
    Object.entries(process.env).filter(
      ([key]) => !VERIFICATION_ENV_KEYS.has(key) && !VERIFICATION_ENV_PREFIX.test(key),
    ),
  ),
  PATH: worktreeExecutablePath(process.env.PATH, worktree),
});

/** The last lines of combined command output kept in a failure detail. */
export const CHECK_DETAIL_TAIL_LINES = 40;

export const checkFailureDetail = (
  result: CommandResult,
  tail = CHECK_DETAIL_TAIL_LINES,
): string => {
  const combined = [result.stdout, result.stderr].filter((stream) => stream.length > 0).join("\n");
  const text = combined.trim();
  if (text.length === 0) return `no output (exit ${result.status})`;
  return `${text.split("\n").slice(-tail).join("\n")} (exit ${result.status})`;
};

const CI_WORKFLOW = NodePath.basename(FORK_CI_WORKFLOW_PATH);
const CI_POLL_SECONDS = 30;
/** A push that has no run this long after it never will. */
const CI_START_SECONDS = 5 * 60;
/** Inside the sync workflow's own timeout, with the rebase before it. */
const CI_TIMEOUT_SECONDS = 60 * 60;
/** One GitHub read inside the wait; a hung read must not outlast the deadlines. */
const CI_READ_TIMEOUT_MS = 60_000;

interface CiRun {
  readonly databaseId: number;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
}

/** The newest hyprws CI push run on the candidate branch at `sha`, if any. */
const latestCiRun = (runner: CommandRunner, root: string, sha: string): CiRun | null =>
  (
    JSON.parse(
      runRequire(
        runner,
        "gh",
        [
          "run",
          "list",
          "--repo",
          FORK_REPOSITORY,
          "--workflow",
          CI_WORKFLOW,
          "--branch",
          SYNC_CANDIDATE_BRANCH,
          "--commit",
          sha,
          "--event",
          "push",
          "--limit",
          "1",
          "--json",
          "databaseId,status,conclusion,url",
        ],
        { cwd: root, timeout: CI_READ_TIMEOUT_MS },
      ),
    ) as ReadonlyArray<CiRun>
  )[0] ?? null;

/** The run's finished jobs; a job still running has no verdict to report. */
const finishedJobs = (runner: CommandRunner, root: string, run: CiRun): ReadonlyArray<CiJob> =>
  (
    JSON.parse(
      runRequire(
        runner,
        "gh",
        ["run", "view", String(run.databaseId), "--repo", FORK_REPOSITORY, "--json", "jobs"],
        { cwd: root, timeout: CI_READ_TIMEOUT_MS },
      ),
    ) as { readonly jobs: ReadonlyArray<CiJob & { readonly status: string }> }
  ).jobs
    .filter((job) => job.status === "completed")
    .map(({ name, conclusion, url }) => ({ name, conclusion, url }));

/**
 * hyprws CI's verdict on `sha`. A sha with a run already — a dry run's proven
 * tip, or a red run rerun by hand — reuses it. Any other sha runs the local
 * `vp run fork:ci` in the sync worktree first, so a lint, ledger, fold, or
 * scan refusal costs minutes instead of a CI round, and is then force-pushed
 * to the candidate branch. The driver polls until the run completes or a job
 * fails, and a run that never starts or never finishes is not green.
 */
export const candidateCi = (runner: CommandRunner, root: string, sha: string): CandidateCi => {
  let latest = latestCiRun(runner, root, sha);
  if (latest === null) {
    const worktree = worktreePath(root);
    // The rebase may have moved the lockfile past what setup installed before
    // it. Setup itself refuses an unpublished HEAD, so install directly.
    const install = runner.run("vp", ["i", "--frozen-lockfile", "--", "--yes"], {
      cwd: worktree,
      env: verificationEnv(worktree),
      stream: true,
    });
    if (install.status !== 0 || install.error !== undefined)
      return {
        run: "",
        conclusion: `skipped: install for the local fork:ci failed (exit ${install.status})`,
        jobs: [],
      };
    process.stdout.write(`sync: running vp run fork:ci on ${sha.slice(0, 7)} before the push\n`);
    const local = runner.run("vp", ["run", "fork:ci"], {
      cwd: worktree,
      env: verificationEnv(worktree),
      stream: true,
    });
    if (local.status !== 0 || local.error !== undefined)
      return {
        run: "",
        conclusion: `skipped: local fork:ci failed (exit ${local.status})`,
        jobs: [],
      };
    const ref = `refs/heads/${SYNC_CANDIDATE_BRANCH}`;
    // A retry after a push that started no run would push an unchanged ref,
    // which GitHub records as no event; recreate the branch so it fires one.
    if (git(runner, root, ["ls-remote", "origin", ref]).startsWith(sha))
      git(runner, root, ["push", "origin", "--delete", ref]);
    process.stdout.write(`sync: pushing ${sha.slice(0, 7)} to ${SYNC_CANDIDATE_BRANCH}\n`);
    git(runner, root, ["push", "--force", "origin", `${sha}:${ref}`]);
  }
  const started = performance.now();
  for (let waited = 0; ; waited += CI_POLL_SECONDS) {
    if (latest !== null) {
      const jobs = finishedJobs(runner, root, latest);
      // One failed job already decides the verdict; the rest only delay the fix.
      if (latest.status === "completed" || jobs.some((job) => job.conclusion === "failure"))
        return {
          run: latest.url,
          conclusion: latest.status === "completed" ? latest.conclusion : "failure",
          jobs,
        };
    }
    // Wall time counts slow GitHub reads; the sleep count bounds a faked sleep.
    const elapsed = Math.max(waited, (performance.now() - started) / 1000);
    if (elapsed >= (latest === null ? CI_START_SECONDS : CI_TIMEOUT_SECONDS))
      return {
        run: latest?.url ?? "",
        conclusion: latest === null ? "never started" : "timed out",
        jobs: [],
      };
    if (waited % (10 * CI_POLL_SECONDS) === 0)
      process.stdout.write(
        `sync: waiting on hyprws CI for ${sha.slice(0, 7)}${latest === null ? "" : ` (${latest.url})`}\n`,
      );
    runner.run("sleep", [String(CI_POLL_SECONDS)], { cwd: root });
    latest = latestCiRun(runner, root, sha);
  }
};

const ciMark = (conclusion: string): string =>
  conclusion === "success" ? "✅" : conclusion === "skipped" ? "⏭️" : "❌";

/** The jobs that kept the candidate from green. */
const redJobs = (ci: CandidateCi): ReadonlyArray<CiJob> =>
  ci.jobs.filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped");

export const blockingShaOf = (conflicts: ReadonlyArray<ConflictRow>): string | null =>
  conflicts.find((row) => row.via === "manual")?.upstreamCommit ??
  conflicts[0]?.upstreamCommit ??
  null;

/** One sync run as the standing issue's recent-runs list records it. */
export interface StandingRun {
  readonly date: string;
  readonly subject: string;
  readonly detail: string;
}

const RECENT_RUNS = 5;
const RECENT_RUNS_HEADING = "## Recent runs";
const STANDING_PATTERN = /<!-- sync-standing since:(\S+) targets:(\d+) -->/;
const RUN_LINE_PATTERN = /^- (\S+) · `([^`]+)` · (.+)$/;

const standingRunsOf = (body: string): ReadonlyArray<StandingRun> => {
  const lines = body.split("\n");
  const start = lines.indexOf(RECENT_RUNS_HEADING);
  if (start === -1) return [];
  const runs: StandingRun[] = [];
  for (const line of lines.slice(start + 2)) {
    const match = RUN_LINE_PATTERN.exec(line);
    if (match === null) break;
    runs.push({ date: match[1]!, subject: match[2]!, detail: match[3]! });
  }
  return runs;
};

/**
 * The tail of a standing sync issue: when it opened, how many targets hit it,
 * and the last few runs. Every blocked or failed run rewrites the one open
 * attention issue, so this carries forward from the body it replaces; a
 * rerun on the same target and detail changes nothing here.
 */
const standingSection = (previous: string | undefined, run: StandingRun): ReadonlyArray<string> => {
  const earlier = previous === undefined ? [] : standingRunsOf(previous);
  const marker = previous === undefined ? null : STANDING_PATTERN.exec(previous);
  const sameTarget = earlier[0]?.subject === run.subject;
  const repeat = sameTarget && earlier[0]?.detail === run.detail;
  const runs = repeat ? earlier : [run, ...earlier].slice(0, RECENT_RUNS);
  const targets = (marker === null ? earlier.length : Number(marker[2])) + (sameTarget ? 0 : 1);
  const since = marker?.[1] ?? earlier.at(-1)?.date ?? run.date;
  return [
    `Open since ${since} across ${targets} target${targets === 1 ? "" : "s"}; each red run rewrites this issue and a clean run closes it.`,
    "",
    RECENT_RUNS_HEADING,
    "",
    ...runs.map((entry) => `- ${entry.date} · \`${entry.subject}\` · ${entry.detail}`),
    "",
    `<!-- sync-standing since:${since} targets:${targets} -->`,
  ];
};

export const attentionIssueBody = (report: ForkSyncReport, previous?: string): string => {
  if (report.failure !== null) {
    const failure = report.failure;
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
      ...(report.ci === null || redJobs(report.ci).length === 0
        ? []
        : [
            "",
            "| Job | Conclusion |",
            "| --- | --- |",
            ...redJobs(report.ci).map((job) => `| [${job.name}](${job.url}) | ${job.conclusion} |`),
          ]),
      ...(report.target.tag === ""
        ? []
        : ["", `Report: \`${SYNC_DIR}/${report.target.tag}.json\` (schema \`${REPORT_SCHEMA}\`).`]),
      "",
      ...standingSection(previous, {
        date: report.startedAt.slice(0, 10),
        subject: subject,
        detail: failure.step,
      }),
      "",
      failureMarker(failure.step, failure.key),
    ].join("\n");
  }
  const cell = (value: string): string =>
    `\`${value.replaceAll("\\", "\\\\").replaceAll("|", "\\|")}\``;
  const blocked = report.blocked!;
  // Earlier stops' rows lead the table; the subject is the blocking commit's.
  const blocking = report.conflicts.find((row) => row.upstreamCommit === blocked.blockingSha);
  return [
    `Origin: hyprws sync run onto ${report.target.tag}; \`vp run fork:sync ${report.target.tag}\`.`,
    "",
    `A sync run rebased \`${HYPRWS_BRANCH}\` onto \`${report.target.tag}\` and stopped at a seam neither rerere nor hook re-apply resolves.`,
    "",
    `Blocking upstream commit: ${cell(`${blocked.blockingSha} ${blocking?.upstreamSubject ?? ""}`)}`,
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
    `Report: \`${SYNC_DIR}/${report.target.tag}.json\` (schema \`${REPORT_SCHEMA}\`).`,
    "",
    ...standingSection(previous, {
      date: report.startedAt.slice(0, 10),
      subject: report.target.tag,
      detail: `upstream ${blocked.blockingSha.slice(0, 7)}`,
    }),
    "",
    blockingShaMarker(blocked.blockingSha),
  ].join("\n");
};

export interface OpenBlockIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

/**
 * The writes the sync projection performs against the fork repository. Reruns
 * edit the existing issue in place — create only files a fresh issue, and the
 * only comment that ever posts is the close evidence in `closeBlocks`.
 */
export interface GitHub {
  /** Open issues under the governed label matching one title phrase. */
  readonly list: (titlePhrase: string) => ReadonlyArray<OpenBlockIssue>;
  readonly create: (title: string, bodyPath: string) => number | null;
  /** Rewrite an existing issue's title and body in place; the rerun projection. */
  readonly edit: (issue: number, title: string, bodyPath: string) => void;
  /** Close with the small close-evidence comment inline; never the report body. */
  readonly close: (issue: number, comment: string) => void;
}

/** The issue type `gh` files and edits with. */
const NOTIFICATION_TYPE = "Notification 🔔";

/** Every write goes through plain `gh`; `edit` rewrites title and body in one call. */
export const githubClient = (runner: CommandRunner, root: string): GitHub => {
  const repo = ["--repo", FORK_REPOSITORY];
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
  return {
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
          "--type",
          NOTIFICATION_TYPE,
          "--label",
          BLOCK_LABEL,
        ],
        { cwd: root },
      );
      let url = /issues\/(\d+)/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
      if (result.status !== 0 || result.error !== undefined) {
        // An older `gh` can reject `--type` at create; retry bare and set the
        // type by editing the fresh issue right after, noting either refusal.
        const retry = runner.run(
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
        if (retry.status !== 0 || retry.error !== undefined)
          throw new Error(
            `gh issue create failed: ${retry.stderr.trim() || retry.stdout.trim() || result.stderr.trim() || result.error?.message || "no output"}`,
          );
        url = /issues\/(\d+)/.exec(`${retry.stdout}\n${retry.stderr}`)?.[1];
        if (url !== undefined)
          runner.run("gh", ["issue", "edit", url, ...repo, "--type", NOTIFICATION_TYPE], {
            cwd: root,
          });
      }
      return url === undefined ? null : Number(url);
    },
    edit: (issue, title, bodyPath) => {
      runRequire(
        runner,
        "gh",
        ["issue", "edit", String(issue), ...repo, "--title", title, "--body-file", bodyPath],
        { cwd: root },
      );
    },
    close: (issue, comment) => {
      runRequire(
        runner,
        "gh",
        ["issue", "close", String(issue), "--reason", "completed", "--comment", comment, ...repo],
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
 * Normalise an issue body for the no-write comparison: strip any stray
 * `gh-bot:` attest footer line (`<!-- gh-bot:attest … -->`,
 * `<!-- gh-bot:edit-attest … -->`) left over on an issue an older ghb-filed
 * run created, trim trailing whitespace per line, then trim the whole.
 */
const normalisedBody = (body: string): string =>
  body
    .split("\n")
    .filter((line) => !/^<!-- gh-bot:.*-->\s*$/.test(line))
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();

/**
 * Adopt the newest open issue of either legacy kind as the one attention
 * issue. Carry its recent runs forward and close surplus issues with a pointer.
 * The typed report stays authoritative; an unchanged body makes no write.
 */
const upsertStandingIssue = (
  runner: CommandRunner,
  root: string,
  title: string,
  render: (previous?: string) => string,
): { readonly issue: number | null; readonly publishedVia: "gh" } => {
  const github = githubClient(runner, root);
  const [standing, ...superseded] = [
    ...new Map(
      [BLOCK_TITLE_PHRASE, FAILURE_TITLE_PHRASE]
        .flatMap((phrase) => github.list(phrase))
        .map((issue) => [issue.number, issue]),
    ).values(),
  ].sort((left, right) => right.number - left.number);
  if (standing === undefined)
    return withBodyFile(render(), (bodyPath) => ({
      issue: github.create(title, bodyPath),
      publishedVia: "gh",
    }));
  const body = render(standing.body);
  // the machine title suffix never matches the render, so the decision is on
  // the normalised body alone
  if (normalisedBody(standing.body) !== normalisedBody(body))
    withBodyFile(body, (bodyPath) => github.edit(standing.number, title, bodyPath));
  for (const issue of superseded) github.close(issue.number, `Superseded by #${standing.number}.`);
  return { issue: standing.number, publishedVia: "gh" };
};

/** Publish the latest red run into the shared standing attention issue. */
export const publishAttention = (
  runner: CommandRunner,
  root: string,
  report: ForkSyncReport,
): ForkSyncReport => {
  const key = report.blocked !== null ? "blocked" : "failure";
  const stop = report[key]!;
  try {
    const { issue, publishedVia } = upsertStandingIssue(runner, root, stop.title, (previous) =>
      attentionIssueBody(report, previous),
    );
    return {
      ...report,
      [key]: { ...stop, ...(issue === null ? {} : { issue }), publishError: null, publishedVia },
    };
  } catch (error) {
    process.stdout.write(`${attentionIssueBody(report)}\n`);
    return {
      ...report,
      [key]: {
        ...stop,
        publishError: error instanceof Error ? error.message : String(error),
        publishedVia: null,
      },
    };
  }
};

/** The applied-sha note the close carries as `gh issue close --comment`; it is the close evidence. */
const blockCloseComment = (newSha: string): string => `Resolved by ${HYPRWS_BRANCH} ${newSha}.`;

/**
 * A clean run closes every open sync issue — block and failure alike: the trunk
 * moved, so none can hold. `gh issue close --comment` posts the close evidence
 * and closes in one call. Each issue reports its own refusal; one refusal
 * never stops the other closes.
 */
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
        github.close(issue.number, blockCloseComment(newSha));
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
  const ci =
    report.ci === null
      ? []
      : [
          "",
          `CI: ${ciMark(report.ci.conclusion)} ${report.ci.conclusion}${report.ci.run === "" ? "" : ` — ${report.ci.run}`}`,
          ...redJobs(report.ci).map(
            (job) => `- ${ciMark(job.conclusion)} ${job.name} — ${job.url}`,
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
          ...(report.decision.tip === undefined ? [] : [`Tip: \`${report.decision.tip}\``]),
          ...(report.decision.paths.length === 0
            ? []
            : [`Paths: ${report.decision.paths.map((path) => `\`${path}\``).join(", ")}`]),
          "",
          "```bash",
          report.decision.resume,
          "```",
        ];
  const failure = report.error === null ? [] : ["", `Error: ${report.error}`];
  return [...rows, ...conflictTable, ...ci, ...blocks, ...decision, ...failure].join("\n");
};

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
    git(runner, root, ["fetch", "--tags", "--force", "upstream"]);
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
      conflicts: [],
      ci: null,
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
        title: syncIssueTitle("failed", step, target.tag),
        step,
        key: target.tag,
        publishError: null,
        publishedVia: null,
      };
      const failed = frame({ ...partial, failure });
      writeReport(root, failed);
      process.stdout.write(`${renderReport(failed)}\n`);
      if (dryRun) return 1;
      const published = publishAttention(runner, root, failed);
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
      if (dryRun) return { closed: [], error: null };
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
    const rebase = rebaseOnto(runner, root, target, expectedOld);

    if (rebase.status === "blocked") {
      // This run's rows: earlier stops' manual paths are already resolved.
      const manualPaths = rebase.conflicts
        .filter((row) => row.via === "manual")
        .map((row) => row.path);
      const blockingSha = blockingShaOf(rebase.conflicts) ?? target.sha;
      const worktree = worktreePath(root);
      // decisions persist before any comment posts
      const blockedReport = frame({
        outcome: "blocked",
        conflicts: [...rebase.recorded],
        decision: {
          worktree,
          paths: manualPaths,
          // The rerun continues the rebase itself, so every later stop still
          // gets rerere, hook re-apply, and regeneration before a human sees it.
          resume: [
            `git -C ${worktree} add -- ${manualPaths.map((path) => `"${path}"`).join(" ")}`,
            `vp run fork:sync ${target.tag}${dryRun ? " --dry-run" : ""}`,
          ].join("\n"),
        },
        blocked: {
          issue: null,
          title: syncIssueTitle("blocked", "rebase", target.tag),
          blockingSha,
          publishError: null,
          publishedVia: null,
        },
        error: `blocked by ${blockingSha.slice(0, 7)}: ${manualPaths.length} path${manualPaths.length === 1 ? "" : "s"} neither rerere nor hook re-apply resolves`,
      });
      writeReport(root, blockedReport);
      process.stdout.write(`${renderReport(blockedReport)}\n`);
      if (dryRun) {
        process.stdout.write(`${attentionIssueBody(blockedReport)}\n`);
        return 1;
      }
      const published = publishAttention(runner, root, blockedReport);
      const path = writeReport(root, published);
      process.stdout.write(
        published.blocked?.publishError !== null && published.blocked?.publishError !== undefined
          ? `block publication failed: ${published.blocked.publishError}\n${path}\n`
          : `${path}\n`,
      );
      return 1;
    }
    const newSha = rebase.newSha;

    // ci — hyprws CI on the candidate sha is the one gate before the trunk moves
    step = "ci";
    const ci = candidateCi(runner, root, newSha);
    if (ci.conclusion !== "success") {
      // The worktree stays: it carries the red tip and any fix committed there.
      const worktree = worktreePath(root);
      const red = redJobs(ci).map((job) => job.name);
      return fail({
        conflicts: [...rebase.recorded],
        ci,
        decision: {
          worktree,
          tip: newSha,
          paths: [],
          resume: [
            `# fix the red job in ${worktree} and commit there; a flake reruns in place once the run completes:`,
            ...(ci.run === ""
              ? []
              : [
                  `#   gh run rerun ${ci.run.split("/").at(-1)} --failed --repo ${FORK_REPOSITORY}`,
                ]),
            `vp run fork:sync ${target.tag}${dryRun ? " --dry-run" : ""}`,
          ].join("\n"),
        },
        error: `hyprws CI ${ci.conclusion} on candidate ${newSha.slice(0, 7)}${red.length === 0 ? "" : `: ${red.join(", ")}`}${ci.run === "" ? "" : ` (${ci.run})`}`,
      });
    }

    // push — the documented expected-old lease; a dry run reaches applied without it
    step = "push";
    if (dryRun) {
      // The worktree stays: the real run on the same tag and lease adopts the
      // proven tip instead of rebasing again, since rerere replays resolutions
      // but not the tip fixups committed after them (RSI-Software/t3code-hyprws#1495).
      const worktree = worktreePath(root);
      return finish(
        frame({
          outcome: "applied",
          trunk: { before: expectedOld, after: newSha },
          conflicts: [...rebase.recorded],
          ci,
          decision: {
            worktree,
            tip: newSha,
            paths: [],
            resume: `vp run fork:sync ${target.tag}`,
          },
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
    if (pushed.status !== 0 || pushed.error !== undefined) {
      // The worktree stays: a rerun on the same lease adopts the green tip, and
      // a moved lease rebases again and carries the tip commits over.
      const worktree = worktreePath(root);
      return fail({
        conflicts: [...rebase.recorded],
        ci,
        decision: {
          worktree,
          tip: newSha,
          paths: [],
          resume: `vp run fork:sync ${target.tag}`,
        },
        error: `push refused: ${pushed.stderr.trim() || pushed.error?.message || "unknown"}`,
      });
    }
    dropWorktree(runner, root);

    // a clean run closes the block issues it made stale, whether the rebase
    // moved the trunk or the trunk already sat on the target
    const close = closeStaleBlocks(newSha);
    const report = finish(
      frame({
        outcome: "applied",
        trunk: { before: expectedOld, after: newSha },
        conflicts: [...rebase.recorded],
        ci,
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
        conflicts: [],
        ci: null,
        closedBlocks: [],
        decision: emptyDecision(),
        blocked: null,
        failure: {
          issue: null,
          title: syncIssueTitle("failed", step, key),
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
        // No tag keys a report; the attention issue carries the run instead.
        const published = publishAttention(runner, root, report);
        if (
          published.failure?.publishError !== null &&
          published.failure?.publishError !== undefined
        )
          process.stdout.write(`failure publication failed: ${published.failure.publishError}\n`);
        return 1;
      }
      writeReport(root, report);
      process.stdout.write(`${renderReport(report)}\n`);
      const published = publishAttention(runner, root, report);
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
