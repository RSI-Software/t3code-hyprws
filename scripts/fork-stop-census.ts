// @effect-diagnostics nodeBuiltinImport:off - This standalone Git bot runs before an Effect runtime exists.
// Rehearses a sequential rebase to count where it would stop, without moving the fork.
//
// The walk runs the real `git rebase` in a disposable worktree and resolves each
// conflicted path provisionally from stage 3, so the stops it reports are the stops the
// operator would hit. It is bounded by a stop count and a wall clock, and it keeps its
// rows on disk as it goes (see `CensusPartialRecord`) so an interrupted walk is not lost.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";

import { requireSuccess, type PositionedTag } from "./fork-auto-rebase-plan.ts";
import { CensusPartialRecord } from "./lib/fork-census-partial.ts";
import { SystemGit } from "./lib/fork-command.ts";
import { makeProgressReporter } from "./lib/fork-progress.ts";
import type { GitCommandResult } from "./lib/fork-rebase-feasibility.ts";
import {
  censusTotals,
  type RebaseStopCensus,
  type SequentialCensusEvidence,
} from "./lib/fork-rebase-issues.ts";
import { parseForkTrailers } from "./lib/fork-trailers.ts";

export type StopCensusRunner = (
  root: string,
  headSha: string,
  baseSha: string,
  target: PositionedTag,
) => RebaseStopCensus;

export const STOP_CENSUS_LIMIT = 128;
export const STOP_CENSUS_TIME_LIMIT_MS = 6 * 60 * 1000;

interface StopCensusLimits {
  readonly stopLimit: number;
  readonly timeLimitMs: number;
  readonly now: () => number;
}

const defaultStopCensusLimits = (): StopCensusLimits => ({
  stopLimit: STOP_CENSUS_LIMIT,
  timeLimitMs: STOP_CENSUS_TIME_LIMIT_MS,
  now: () => NodePerfHooks.performance.now(),
});

const hasStage = (stages: string, stage: number): boolean =>
  stages.split("\n").some((line) => line.includes(` ${stage}\t`));

const moveAside = (worktree: string, cemetery: string, path: string, index: number): void => {
  const absolute = NodePath.resolve(worktree, path);
  if (!absolute.startsWith(`${NodePath.resolve(worktree)}${NodePath.sep}`)) {
    throw new Error(`refusing to resolve a conflict path outside the census worktree: ${path}`);
  }
  try {
    NodeFS.lstatSync(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  NodeFS.mkdirSync(cemetery, { recursive: true });
  NodeFS.renameSync(absolute, NodePath.join(cemetery, String(index)));
};

/**
 * Truncation is a one-off fact rather than progress, so it is said once and never
 * throttled away. A census that stops early used to report it only in its return value,
 * where an operator watching the walk never saw it.
 */
const announce = (message: string): void => {
  if (process.env.FORK_QUIET === "1") return;
  process.stderr.write(`census: ${message}\n`);
};

const timedOut = (result: GitCommandResult): boolean =>
  result.error instanceof Error && "code" in result.error && result.error.code === "ETIMEDOUT";

export const rehearseStopCensus = (
  root: string,
  headSha: string,
  baseSha: string,
  target: PositionedTag,
  limits: StopCensusLimits = defaultStopCensusLimits(),
  rerereEnabled = false,
): RebaseStopCensus => {
  const startedAt = limits.now();
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-rebase-census-"));
  const cemetery = `${worktree}-files`;
  const rootGit = new SystemGit(root);
  let worktreeGit: SystemGit | null = null;
  const rows: Array<SequentialCensusEvidence["rows"][number]> = [];
  let stopCount = 0;
  let movedFileCount = 0;
  let truncatedBy: RebaseStopCensus["truncatedBy"] = null;
  let finished = false;
  const progress = makeProgressReporter("census");
  const partial = new CensusPartialRecord(root, { sourceSha: headSha, targetSha: target.sha });
  const observed = (complete: boolean): SequentialCensusEvidence => ({
    version: 1,
    method: "sequential-rebase-stage3-provisional",
    sourceSha: headSha,
    baseSha,
    targetSha: target.sha,
    targetTag: target.tag,
    complete,
    rows,
  });
  const remainingTime = (): number => limits.timeLimitMs - (limits.now() - startedAt);
  const runRebase = (args: ReadonlyArray<string>): GitCommandResult | null => {
    const remaining = remainingTime();
    if (remaining <= 0) {
      truncatedBy = "time-limit";
      return null;
    }
    const result = worktreeGit?.runResult(args, Math.max(1, Math.ceil(remaining))) ?? null;
    if (result !== null && timedOut(result)) {
      truncatedBy = "time-limit";
      return null;
    }
    return result;
  };
  const rebaseArgs = [
    "-c",
    "core.editor=true",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    `rerere.enabled=${rerereEnabled ? "true" : "false"}`,
    "-c",
    "rerere.autoupdate=false",
    "rebase",
  ] as const;
  try {
    rootGit.run(["worktree", "add", "--detach", worktree, headSha]);
    worktreeGit = new SystemGit(worktree);
    let rebase = runRebase([...rebaseArgs, "--empty=drop", "--onto", target.sha, baseSha, headSha]);
    while (
      truncatedBy === null &&
      rebase !== null &&
      (rebase.status !== 0 || rebase.error !== undefined)
    ) {
      if (rebase.error !== undefined) requireSuccess("start or continue census rebase", rebase);
      if (remainingTime() <= 0) {
        truncatedBy = "time-limit";
        break;
      }
      const rebaseHead = worktreeGit.runResult(["rev-parse", "--verify", "REBASE_HEAD"]);
      const conflictPaths = worktreeGit
        .run(["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U", "-z"])
        .split("\0")
        .filter(Boolean);
      if (rebaseHead.status !== 0) requireSuccess("start or continue census rebase", rebase);
      if (conflictPaths.length === 0) {
        rebase = runRebase([...rebaseArgs, "--skip"]);
        continue;
      }
      stopCount += 1;
      const commit = rebaseHead.stdout.trim();
      const message = worktreeGit.run(["show", "-s", "--format=%B", commit]);
      const stagesByPath = conflictPaths.map((path) => ({
        path,
        stages: worktreeGit!.run(["ls-files", "--stage", "--", path]),
      }));
      // Observe every path before provisional continuation or a limit interrupts the stop.
      for (const { path, stages } of stagesByPath) {
        const base = hasStage(stages, 1);
        const ours = hasStage(stages, 2);
        const theirs = hasStage(stages, 3);
        rows.push({
          stop: stopCount,
          commit,
          subject: message.split("\n")[0] ?? "",
          domain: parseForkTrailers(message).domain ?? null,
          path,
          kind:
            !base && ours && theirs
              ? "add/add"
              : base && ours !== theirs
                ? "modify/delete"
                : base && ours && theirs
                  ? "content"
                  : "other-unmerged",
        });
      }
      progress("stops", stopCount, limits.stopLimit);
      // The rows of this stop are on disk before the walk risks another one.
      partial.record(observed(false), truncatedBy);
      if (stopCount >= limits.stopLimit) {
        truncatedBy = "stop-limit";
        break;
      }
      for (const [index, { path, stages }] of stagesByPath.entries()) {
        if (remainingTime() <= 0) {
          truncatedBy = "time-limit";
          break;
        }
        if (hasStage(stages, 3)) {
          worktreeGit.run(["checkout-index", "--force", "--stage=3", "--", path]);
        } else {
          moveAside(worktree, cemetery, path, movedFileCount + index);
        }
        worktreeGit.run(["add", "--all", "--", path]);
      }
      if (truncatedBy !== null) break;
      movedFileCount += conflictPaths.length;
      rebase = runRebase([...rebaseArgs, "--continue"]);
    }
    finished = true;
    if (truncatedBy !== null) {
      announce(`truncated by ${truncatedBy} after ${String(stopCount)} stops`);
    }
    return {
      targetTag: target.tag,
      evidence: observed(truncatedBy === null),
      ...censusTotals(rows),
      truncated: truncatedBy !== null,
      truncatedBy,
      stopLimit: limits.stopLimit,
      timeLimitSeconds: limits.timeLimitMs / 1000,
    };
  } finally {
    // Kept before teardown, so a census that threw still leaves the stops it reached.
    partial.record(observed(finished && truncatedBy === null), truncatedBy, true);
    worktreeGit?.runResult(["rebase", "--abort"]);
    rootGit.runResult(["worktree", "remove", "--force", worktree]);
    rootGit.runResult(["worktree", "prune"]);
    NodeFS.rmSync(worktree, { recursive: true, force: true });
    NodeFS.rmSync(cemetery, { recursive: true, force: true });
  }
};
