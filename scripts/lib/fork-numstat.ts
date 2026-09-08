// Per-commit numstat reading shared by `fork:delta --inventory` and the sync
// walk's size record. Kept Effect-free so the operator state machine in
// fork-sync.ts can import it before Effect exists.
// See docs/internals/fork-delta.md for the conventions these numbers feed.

import { FORK_LOG_RECORD_SEPARATOR } from "./fork-trailers.ts";

export interface CommitNumstat {
  readonly files: ReadonlyArray<string>;
  readonly added: number;
  readonly deleted: number;
}

export const EMPTY_NUMSTAT: CommitNumstat = { files: [], added: 0, deleted: 0 };

// One numstat record per commit. `--no-renames` keeps every path a real path, so
// a renamed file intersects the net fork and upstream diffs — which list the new
// path only — exactly like fork:scan's `--name-only` commit lists do.
export const commitNumstatArguments = (shas: ReadonlyArray<string>) =>
  [
    "-c",
    "core.quotePath=false",
    "show",
    "--numstat",
    "--no-renames",
    `--format=${FORK_LOG_RECORD_SEPARATOR}%H`,
    ...shas,
  ] as const;

export const parseCommitNumstat = (raw: string): ReadonlyMap<string, CommitNumstat> => {
  const stats = new Map<string, CommitNumstat>();
  for (const record of raw.replace(/\r\n/g, "\n").split(FORK_LOG_RECORD_SEPARATOR)) {
    const [sha = "", ...rows] = record.split("\n");
    if (sha.trim().length === 0) continue;
    let added = 0;
    let deleted = 0;
    const files: Array<string> = [];
    for (const row of rows) {
      const cells = row.split("\t");
      const path = (cells[2] ?? "").trim();
      if (path.length === 0) continue;
      files.push(path);
      // Binary files report "-" for both counts; they still count as touched.
      added += Number.parseInt(cells[0] ?? "", 10) || 0;
      deleted += Number.parseInt(cells[1] ?? "", 10) || 0;
    }
    stats.set(sha.trim(), { files, added, deleted });
  }
  return stats;
};
