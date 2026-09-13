// @effect-diagnostics nodeBuiltinImport:off - The fold verbs run real git in a lane worktree.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import {
  assertOnly,
  COMMENT_CONFIG,
  git,
  gitRaw,
  lines,
  oneValue,
  readReport,
  writeReport,
  writeRecord,
  type ConflictRow,
  type SyncReport,
} from "./fork-sync-state.ts";
import type { CommandRunner } from "./lib/fork-command.ts";
import { normalizeReplayMessages } from "./lib/fork-replay-messages.ts";
import { HYPRWS_REF } from "./lib/fork-policy.ts";
import { classifyTrunkMovement, proveSegment, replaySegment } from "./lib/fork-sync-fold.ts";
import { parseForkTrailers } from "./lib/fork-trailers.ts";

/**
 * The fold wiring (RSI-Software/t3code-hyprws#922) lives here so `scripts/fork-sync.ts` keeps only
 * dispatch and call sites. Everything the verbs need from that file — the rebase argument prefix,
 * record-decision preservation, the check battery, and the conflict-stop text — arrives through
 * `FoldVerbContext`, so the walk module never becomes an import of this one.
 */
export interface FoldVerbContext {
  readonly rehearsalRebaseArgs: (args: ReadonlyArray<string>) => ReadonlyArray<string>;
  readonly preserveRecordDecisions: (report: SyncReport) => SyncReport;
  readonly unblockCheck: (
    values: ReadonlyMap<string, string>,
    cwd: string,
    runner: CommandRunner,
  ) => SyncReport;
  readonly rehearsalConflictStop: (
    reportPath: string,
    recordPath: string,
    commit: { readonly sha: string; readonly subject: string },
    conflicts: ReadonlyArray<string>,
    rerereResolved?: ReadonlyArray<string>,
  ) => string;
  /**
   * Records `walk.stop = {reason: "conflict", detail}` on the report the way `stopWalk` does in
   * the walk module, so a fold conflict stop feeds the same consumers (record-decisions' guard,
   * the dirty-lane allowance) without the verb throwing the auto walk's stop error.
   */
  readonly recordWalkStop: (report: SyncReport, detail: string) => SyncReport;
}

const GENERATED_PATH = "pnpm-lock.yaml";

const foldRecordDigest = (recordPath: string): string =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(recordPath, "utf8")).digest("hex");

const currentRebaseCommit = (
  runner: CommandRunner,
  worktree: string,
): { sha: string; subject: string; domain: string } => {
  const raw = git(runner, worktree, ["show", "-s", "--format=%H%x1f%s%x1f%b", "REBASE_HEAD"], true);
  const [sha = "", subject = "", body = ""] = raw.split("\x1f");
  return { sha, subject, domain: parseForkTrailers(body).domain ?? "?" };
};

const pendingFoldConflicts = (runner: CommandRunner, worktree: string): ReadonlyArray<string> =>
  lines(git(runner, worktree, ["diff", "--name-only", "--diff-filter=U"], true));

const rerereResolvedPaths = (
  runner: CommandRunner,
  worktree: string,
  conflicts: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const remaining = new Set(
    lines(git(runner, worktree, ["-c", "rerere.enabled=true", "rerere", "remaining"], true)),
  );
  return conflicts.filter((path) => !remaining.has(path));
};

/**
 * Ordinary `## Conflicts` rows for the landed commit, with a fold attribution in the subject cell
 * so the row shows which fold produced it while every existing consumer (parser, churn, resume
 * matching) keeps reading the table it already knows.
 */
const foldConflictRows = (
  commit: { readonly sha: string; readonly subject: string; readonly domain: string },
  conflicts: ReadonlyArray<string>,
  rerereResolved: ReadonlyArray<string>,
  foldIndex: number,
): ReadonlyArray<ConflictRow> => {
  const reused = new Set(rerereResolved);
  const subject = `${commit.subject} (fold ${foldIndex + 1})`;
  return conflicts.map((path) => ({
    commit: commit.sha,
    subject,
    domain: commit.domain,
    path,
    class: path === GENERATED_PATH ? "generated" : "TODO",
    resolution:
      path === GENERATED_PATH
        ? "restore HEAD and regenerate"
        : reused.has(path)
          ? "review rerere's recorded resolution and stage"
          : "TODO",
    agentSafe: path === GENERATED_PATH ? "pending regeneration" : "TODO",
    decidedBy: "TODO",
  }));
};

const commitPaths = (
  runner: CommandRunner,
  root: string,
  from: string,
  to: string,
): ReadonlyArray<string> =>
  lines(git(runner, root, ["-c", "core.quotePath=false", "diff", "--name-only", from, to], true));

export type FoldMovement =
  | { readonly kind: "unchanged"; readonly live: string; readonly report: SyncReport }
  | {
      readonly kind: "conflict";
      readonly live: string;
      readonly report: SyncReport;
      readonly commit: { readonly sha: string; readonly subject: string; readonly domain: string };
      readonly paths: ReadonlyArray<string>;
    }
  | { readonly kind: "folded"; readonly live: string; readonly report: SyncReport };

const proveAndUpdate = (
  report: SyncReport,
  runner: CommandRunner,
  context: FoldVerbContext,
  head: string,
): SyncReport => {
  const lane = report.lane!;
  const index = report.activeFold!.index;
  const segment = report.folds![index]!;
  proveSegment(lane, {
    from: segment.from,
    to: segment.to,
    onto: segment.onto,
    head,
  });
  const touched = commitPaths(runner, report.repositoryRoot, segment.from, segment.to);
  const folds = report.folds!.map((fold, position) =>
    position === index ? { ...fold, replayedHead: head } : fold,
  );
  const { activeFold: _cleared, ...rest } = report;
  const updated = context.preserveRecordDecisions({
    ...rest,
    stage: "replayed",
    folds,
    source: { ...report.source!, expectedOld: segment.to },
    rebasedHead: head,
    stackSize: Number(
      git(runner, lane.worktree, ["rev-list", "--count", `${report.target!.sha}..${head}`], true),
    ),
    touchedPaths: [...new Set([...(report.touchedPaths ?? []), ...touched])],
  });
  writeReport(updated);
  writeRecord(updated);
  return updated;
};

/**
 * Fetch the trunk, classify movement past the incorporated frontier B, and — when the movement is
 * a linear landing sequence — fold it: append the segment, persist `activeFold` and the `folding`
 * stage before any Git mutation, replay onto the lane head, and prove the segment. A conflict
 * leaves the rebase in progress in the lane and returns the conflicting commit; a completed fold
 * returns the report regressed to `replayed` with B advanced to the new trunk tip.
 */
export const foldLinearMovement = (
  report: SyncReport,
  runner: CommandRunner,
  context: FoldVerbContext,
): FoldMovement => {
  if (report.lane === undefined || report.source === undefined || report.target === undefined)
    throw new Error("fold binding is incomplete");
  const root = report.repositoryRoot;
  git(runner, root, ["fetch", "--quiet", "origin", HYPRWS_REF]);
  const live = git(runner, root, ["rev-parse", "origin/hyprws^{commit}"]);
  const movement = classifyTrunkMovement(
    root,
    report.source.expectedOld,
    live,
    report.source.sharedBase,
    report.target.sha,
  );
  if (movement.kind === "unchanged") return { kind: "unchanged", live, report };
  if (movement.kind === "refuse")
    throw new Error(`unblock-fold refuses: ${movement.reason}; the lane is retained as evidence`);
  const worktree = report.lane.worktree;
  // The lane needs the landed objects before it can replay them; it shares origin with the root.
  git(runner, worktree, ["fetch", "--quiet", "origin", HYPRWS_REF]);
  const onto = git(runner, worktree, ["rev-parse", "HEAD"], true);
  const originalMessages = gitRaw(
    runner,
    root,
    [
      "log",
      "--reverse",
      "--topo-order",
      "--format=%B%x1e",
      `${report.source.expectedOld}..${live}`,
    ],
    true,
  );
  const originalCount = Number(
    git(runner, root, ["rev-list", "--count", `${report.source.expectedOld}..${live}`], true),
  );
  const index = (report.folds ?? []).length;
  const folds = [
    ...(report.folds ?? []),
    { from: report.source.expectedOld, to: live, onto, originalCount, originalMessages },
  ];
  // Persist the transient `folding` stage and the active fold before any Git mutation, so a worker
  // that dies inside the replay resumes into the fold instead of restarting the walk.
  const folding: SyncReport = {
    ...report,
    folds,
    activeFold: { index, operation: "replay" },
    stage: "folding",
    ...(report.baseCheckedHead === undefined && report.rebasedHead !== undefined
      ? { baseCheckedHead: report.rebasedHead }
      : {}),
  };
  writeReport(folding);
  const replay = replaySegment(report.lane, { from: folds[index]!.from, to: live, onto });
  if ("conflict" in replay) {
    const commit = currentRebaseCommit(runner, worktree);
    return { kind: "conflict", live, report: folding, commit, paths: replay.conflict.paths };
  }
  return { kind: "folded", live, report: proveAndUpdate(folding, runner, context, replay.head) };
};

export const stopAtFoldConflict = (
  report: SyncReport,
  runner: CommandRunner,
  context: FoldVerbContext,
  conflict: {
    readonly commit: { readonly sha: string; readonly subject: string; readonly domain: string };
    readonly paths: ReadonlyArray<string>;
  },
): SyncReport => {
  const worktree = report.lane!.worktree;
  const conflicts = pendingFoldConflicts(runner, worktree);
  const rerereResolved = rerereResolvedPaths(runner, worktree, conflicts);
  const rows = foldConflictRows(
    conflict.commit,
    conflicts,
    rerereResolved,
    report.activeFold!.index,
  );
  // The fold conflict is an ordinary walk stop: `walk.stop` names it, so record-decisions accepts
  // the record and the dirty-lane allowance covers the stopped paths (RSI-Software/t3code-hyprws#922).
  const stopped = context.preserveRecordDecisions(
    context.recordWalkStop(
      {
        ...report,
        stage: "conflicts",
        conflicts: [...report.conflicts, ...rows],
      },
      `fold conflict at ${conflict.commit.subject} (${conflict.commit.sha.slice(0, 12)}): ${conflicts.join(", ")}`,
    ),
  );
  writeReport(stopped);
  writeRecord(stopped);
  process.stdout.write(
    context.rehearsalConflictStop(
      stopped.reportPath,
      stopped.recordPath,
      conflict.commit,
      conflicts,
      rerereResolved,
    ),
  );
  return stopped;
};

/**
 * `unblock-fold`: allowed from `replayed` or `checked` only. `unchanged` movement is a no-op,
 * `refuse` retains the lane and exits non-zero, `linear` folds and regresses the walk to
 * `replayed` so `unblock-check` reruns the final-tree gates on the new head.
 */
export const unblockFold = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
  context: FoldVerbContext,
): SyncReport => {
  assertOnly(values, ["--report"]);
  const report = readReport(oneValue(values, "--report") ?? "");
  if (report.kind === "rewrite")
    throw new Error(`unblock-fold requires an unblock walk, got ${report.kind ?? "unblock"}`);
  if (report.stage !== "replayed" && report.stage !== "checked")
    throw new Error(`unblock-fold requires replayed or checked state, got ${report.stage}`);
  const movement = foldLinearMovement(report, runner, context);
  if (movement.kind === "unchanged") {
    process.stdout.write(
      `unblock-fold: origin/hyprws is still at ${movement.live}; nothing to fold.\n${report.reportPath}\n`,
    );
    return report;
  }
  if (movement.kind === "conflict")
    return stopAtFoldConflict(movement.report, runner, context, movement);
  process.stdout.write(
    `unblock-fold: folded ${movement.report.folds?.length ?? 0} segment(s) up to ${movement.live}; stage regressed to replayed — rerun unblock-check.\n${movement.report.reportPath}\n`,
  );
  return movement.report;
};

/**
 * The tail every fold resume shares: conflicted folds stop exactly like a rehearsal stop (rows
 * attributed to the landed commit, stage `conflicts`, `activeFold` kept); a clean lane finishes
 * the fold — prove the segment, advance B to the segment's `to`, clear `activeFold`, regress to
 * `replayed`.
 */
export const finishActiveFold = (
  report: SyncReport,
  runner: CommandRunner,
  context: FoldVerbContext,
): SyncReport => {
  if (report.lane === undefined || report.folds === undefined || report.activeFold === undefined)
    throw new Error("fold resume binding is incomplete");
  const worktree = report.lane.worktree;
  const conflicts = pendingFoldConflicts(runner, worktree);
  if (conflicts.length > 0) {
    const commit = currentRebaseCommit(runner, worktree);
    return stopAtFoldConflict(report, runner, context, { commit, paths: conflicts });
  }
  let head = git(runner, worktree, ["rev-parse", "HEAD"], true);
  const segment = report.folds![report.activeFold.index]!;
  if (head === segment.onto) {
    // The worker died after the `folding` report was persisted but before the replay moved the
    // lane; start (or restart) the segment replay here instead of proving an unadvanced lane.
    git(runner, worktree, ["fetch", "--quiet", "origin", HYPRWS_REF]);
    const replay = replaySegment(report.lane, {
      from: segment.from,
      to: segment.to,
      onto: segment.onto,
    });
    if ("conflict" in replay)
      return stopAtFoldConflict(report, runner, context, {
        commit: currentRebaseCommit(runner, worktree),
        paths: replay.conflict.paths,
      });
    head = replay.head;
  }
  const updated = proveAndUpdate(report, runner, context, head);
  process.stdout.write(
    `fold: segment complete; stage regressed to replayed — rerun unblock-check.\n${updated.reportPath}\n`,
  );
  return updated;
};

/**
 * The one fold-and-recheck step both the pre-gate fold and the apply retry loop run: fold the
 * linear movement past B, record a conflicting fold through the ordinary conflict stop, and hand
 * a folded walk to `recheck` (the final-tree gates) for its regression to `checked`.
 */
export const foldAndRecheck = (
  report: SyncReport,
  runner: CommandRunner,
  context: FoldVerbContext,
  recheck: (report: SyncReport) => SyncReport,
): SyncReport => {
  const folded = foldLinearMovement(report, runner, context);
  if (folded.kind === "unchanged") return report;
  if (folded.kind === "conflict") {
    stopAtFoldConflict(folded.report, runner, context, folded);
    throw new Error(
      `folding the landed suffix conflicts in ${folded.commit.subject} (${folded.commit.sha.slice(0, 12)}); the lane is retained with the conflict rows recorded`,
    );
  }
  return recheck(folded.report);
};

export interface LeasedPushInput {
  readonly report: SyncReport;
  readonly runner: CommandRunner;
  readonly context: FoldVerbContext;
  readonly worktree: string;
  /** The verified head being published. */
  readonly head: string;
  /** The incorporated frontier B the push leases. */
  readonly lease: string;
  readonly recordPath: string;
  /** Runs the final-tree gates after a fold and returns the refreshed `checked` report. */
  readonly recheck: (report: SyncReport) => SyncReport;
}

const isDefiniteStaleLease = (output: string): boolean =>
  /\[rejected\].*\(stale info\)/.test(output);

/**
 * The leased apply push with bounded fold retry (RSI-Software/t3code-hyprws#922). Before every
 * attempt the pending `publication` receipt `{expectedOld: B, head, recordDigest}` is persisted.
 * A definite Git lease rejection (`[rejected] … (stale info)`) — never an auth, network, or other
 * failure — fetches, classifies, folds the uncovered suffix, reruns the final-tree gates through
 * `recheck`, and retries, at most 3 attempts; then the lane is retained. Any other failure keeps
 * the current behaviour: the error surfaces unchanged.
 */
export const leasedPushWithFoldRetry = (input: LeasedPushInput): SyncReport => {
  let report = input.report;
  let lease = input.lease;
  let head = input.head;
  const { recordPath } = input;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const recordDigest = foldRecordDigest(recordPath);
    report = { ...report, publication: { expectedOld: lease, head, recordDigest } };
    writeReport(report);
    const push = input.runner.run(
      "git",
      [
        "-c",
        "core.commentChar=auto",
        "push",
        `--force-with-lease=${HYPRWS_REF}:${lease}`,
        "origin",
        `HEAD:${HYPRWS_REF}`,
      ],
      input.worktree,
      undefined,
      { ...process.env, ...COMMENT_CONFIG },
    );
    if (push.status === 0 && push.error === undefined) {
      report = {
        ...report,
        publication: { expectedOld: lease, head, recordDigest, outcome: "applied" },
      };
      writeReport(report);
      return report;
    }
    const pushFailure = push.error?.message ?? (push.stderr.trim() || push.stdout.trim());
    if (
      !isDefiniteStaleLease(`${push.stderr}\n${push.stdout}`) ||
      report.kind === "rewrite" ||
      attempt === 3
    )
      throw new Error(`leased apply refused; this report cannot be refreshed: ${pushFailure}`);
    process.stdout.write(
      `apply: trunk moved past ${lease}; folding the landed suffix and retrying (attempt ${attempt + 1} of 3)\n`,
    );
    report = foldAndRecheck(report, input.runner, input.context, input.recheck);
    if (report.source === undefined || report.installedHead === undefined)
      throw new Error("post-fold recheck lost its bindings");
    lease = report.source.expectedOld;
    head = report.installedHead;
  }
  throw new Error("leased apply exhausted its fold retries");
};
