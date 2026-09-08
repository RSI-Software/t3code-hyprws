// The size a sync walk records for the stack it replayed: total fork commits,
// the per-domain table, and the shared-file count — the same three numbers the
// `fork:delta --inventory` budget seeds from, captured per cycle so every walk
// states how big the stack it moved was. Kept Effect-free; fork-sync.ts runs
// before Effect exists.

import { overlapPaths } from "./fork-overlap.ts";
import type { CommitNumstat } from "./fork-numstat.ts";

export interface WalkSizeDomain {
  readonly domain: string;
  readonly commits: number;
  readonly added: number;
  readonly deleted: number;
  /** Files of this domain the net fork and upstream diffs both changed. */
  readonly shared: number;
}

export interface WalkSize {
  /** Every commit the walk replayed, tagged or not; the domains below are the tagged ones. */
  readonly commits: number;
  /** One row per Fork-Domain, sorted by domain. */
  readonly domains: ReadonlyArray<WalkSizeDomain>;
  /** Sum of the per-domain shared counts, matching the inventory's total attribution. */
  readonly sharedFiles: number;
}

export const buildWalkSize = (input: {
  readonly commits: ReadonlyArray<{
    readonly sha: string;
    readonly domain?: string;
    readonly repair?: string;
  }>;
  readonly statsBySha: ReadonlyMap<string, CommitNumstat>;
  readonly forkChanged: ReadonlySet<string>;
  readonly upstreamChanged: ReadonlySet<string>;
}): WalkSize => {
  const EMPTY: CommitNumstat = { files: [], added: 0, deleted: 0 };
  const buckets = new Map<
    string,
    { commits: number; added: number; deleted: number; files: Set<string> }
  >();
  let total = 0;
  for (const commit of input.commits) {
    // A walk repair commit is the walk's own bookkeeping, not the replayed
    // stack: repairs never count toward the size the walk records.
    if (commit.repair !== undefined) continue;
    total += 1;
    if (commit.domain === undefined) continue;
    const stats = input.statsBySha.get(commit.sha) ?? EMPTY;
    const bucket = buckets.get(commit.domain) ?? {
      commits: 0,
      added: 0,
      deleted: 0,
      files: new Set<string>(),
    };
    bucket.commits += 1;
    bucket.added += stats.added;
    bucket.deleted += stats.deleted;
    for (const path of stats.files) bucket.files.add(path);
    buckets.set(commit.domain, bucket);
  }
  const domains = [...buckets]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([domain, bucket]): WalkSizeDomain => ({
      domain,
      commits: bucket.commits,
      added: bucket.added,
      deleted: bucket.deleted,
      shared: overlapPaths(bucket.files, input.forkChanged, input.upstreamChanged).length,
    }));
  return {
    commits: total,
    domains,
    sharedFiles: domains.reduce((sum, row) => sum + row.shared, 0),
  };
};
