// @effect-diagnostics nodeBuiltinImport:off - The census runs in the fork bot, before Effect exists.
// @effect-diagnostics globalDate:off - Partial evidence is stamped with the operator's wall clock.
// Keeps a stop census's rows on disk while it is still walking.
//
// The census only returns its evidence when it finishes, so an interrupted run — a
// cancelled job, a killed process, a machine that went away — used to leave nothing
// behind, and the next run started from zero. This writes what has been observed so
// far to the repository's gitignored run-evidence tree, which outlives the scratch
// worktree the census tears down and is never part of a commit.
//
// The file is named after the walk and the process that is walking it, so two censuses
// running at once write to two files, and a partial file is always attributable.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { RebaseStopCensus, SequentialCensusEvidence } from "./fork-rebase-issues.ts";

/** The slowest a walking census rewrites its partial file. */
const PARTIAL_WRITE_INTERVAL_MS = 1_000;

export interface CensusPartial {
  readonly schemaVersion: 1;
  /** The process that walked it, so an operator can tell a live file from a dead one. */
  readonly pid: number;
  readonly updatedAt: string;
  readonly truncatedBy: RebaseStopCensus["truncatedBy"];
  readonly evidence: SequentialCensusEvidence;
}

/**
 * Where a repository's censuses leave their rows. `.dump/runs` is gitignored, is the
 * fork tooling's existing home for run evidence, and belongs to the repository rather
 * than to the temporary worktree the census removes on its way out. Tests point
 * `FORK_CENSUS_PARTIAL_DIR` somewhere disposable.
 */
export const censusPartialDir = (root: string): string =>
  process.env.FORK_CENSUS_PARTIAL_DIR ?? NodePath.join(root, ".dump", "runs", "fork-census");

/** Walks this process has started, so two of them never choose the same file. */
let walkCount = 0;

/**
 * The partial file for one census walk. Writing is best effort in both directions: a
 * walk is never failed by an unwritable evidence tree, and a reported write failure is
 * said once rather than once per stop.
 */
export class CensusPartialRecord {
  readonly path: string;
  private readonly now: () => number;
  private lastWrite = 0;
  private reportedFailure = false;

  constructor(
    root: string,
    key: { readonly sourceSha: string; readonly targetSha: string },
    now: () => number = () => Date.now(),
  ) {
    this.now = now;
    // The pid separates concurrent censuses; the ordinal separates the walks one
    // process makes, which `fork:forecast` does once per candidate target.
    walkCount += 1;
    const name = [
      key.sourceSha.slice(0, 12),
      key.targetSha.slice(0, 12),
      String(process.pid),
      String(walkCount),
    ].join("-");
    this.path = NodePath.join(censusPartialDir(root), `${name}.json`);
  }

  /**
   * Records the rows observed so far. Throttled, because a census with hundreds of
   * conflicting paths would otherwise rewrite the file faster than it walks; `final`
   * forces the write that the operator and the next run actually read.
   */
  record(
    evidence: SequentialCensusEvidence,
    truncatedBy: RebaseStopCensus["truncatedBy"],
    final = false,
  ): void {
    const at = this.now();
    if (!final && at - this.lastWrite < PARTIAL_WRITE_INTERVAL_MS) return;
    this.lastWrite = at;
    const partial: CensusPartial = {
      schemaVersion: 1,
      pid: process.pid,
      updatedAt: new Date(at).toISOString(),
      truncatedBy,
      evidence,
    };
    try {
      NodeFS.mkdirSync(NodePath.dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      NodeFS.writeFileSync(temporary, `${JSON.stringify(partial, null, 2)}\n`, "utf8");
      NodeFS.renameSync(temporary, this.path);
    } catch (error) {
      if (this.reportedFailure || process.env.FORK_QUIET === "1") return;
      this.reportedFailure = true;
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`census: partial rows are not being kept (${detail})\n`);
    }
  }
}
