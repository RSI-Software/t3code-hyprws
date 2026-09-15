// @effect-diagnostics nodeBuiltinImport:off - The fork sync jobs carry this file before Effect exists.
// Carries one job's merge feasibility walk to another job in the same sync trigger.
//
// Two things travel: the finished `ForkRebaseFeasibility`, which is only usable when
// the consumer walks the same (source, target, base) triple, and the `git merge-tree`
// memo, which is usable always. A merge of two commit object ids is fixed for good,
// so a carried memo entry cannot describe a moved ref; a finished feasibility can, and
// is refused unless every sha it was computed against still matches.

import * as NodeFS from "node:fs";

import {
  MergeTreeMemo,
  type ForkRebaseFeasibility,
  type MergeTreeMemoEntry,
} from "./fork-rebase-feasibility.ts";

const OBJECT_ID = /^[0-9a-f]{40,64}$/;

const FEASIBILITY_ARTIFACT_VERSION = 1;

export interface FeasibilityKey {
  readonly sourceSha: string;
  readonly targetSha: string;
  readonly baseSha: string;
}

export interface FeasibilityArtifact extends FeasibilityKey {
  readonly schemaVersion: typeof FEASIBILITY_ARTIFACT_VERSION;
  readonly generatedBy: string;
  readonly feasibility: ForkRebaseFeasibility;
  readonly mergeTree: ReadonlyArray<MergeTreeMemoEntry>;
}

export interface CarriedFeasibility {
  /** The carried walk, or null when it was refused or never offered. */
  readonly feasibility: ForkRebaseFeasibility | null;
  /** Seeded with every carried merge, which stays valid even when the walk is refused. */
  readonly memo: MergeTreeMemo;
  /** Why a carried walk was not used, for the operator's stream and the run summary. */
  readonly refusal: string | null;
}

export class FeasibilityArtifactError extends Error {}

const fail = (detail: string): never => {
  throw new FeasibilityArtifactError(`feasibility artifact is malformed: ${detail}`);
};

const record = (value: unknown, label: string): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : (fail(`${label} is not an object`) as never);

const array = (value: unknown, label: string): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : (fail(`${label} is not an array`) as never);

const text = (value: unknown, label: string): string =>
  typeof value === "string" ? value : (fail(`${label} is not a string`) as never);

const optionalText = (value: unknown, label: string): string | null =>
  value === null ? null : text(value, label);

const count = (value: unknown, label: string): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : (fail(`${label} is not a count`) as never);

const objectId = (value: unknown, label: string): string => {
  const sha = text(value, label);
  return OBJECT_ID.test(sha) ? sha : (fail(`${label} is not an object id`) as never);
};

const paths = (value: unknown, label: string): ReadonlyArray<string> =>
  array(value, label).map((entry, index) => {
    const path = text(entry, `${label}[${String(index)}]`);
    return path.length > 0 ? path : (fail(`${label}[${String(index)}] is empty`) as never);
  });

const commit = (value: unknown, label: string) => {
  const source = record(value, label);
  return {
    sha: objectId(source.sha, `${label}.sha`),
    shortSha: text(source.shortSha, `${label}.shortSha`),
    subject: text(source.subject, `${label}.subject`),
    tags: paths(source.tags, `${label}.tags`),
  };
};

const parseFeasibility = (value: unknown): ForkRebaseFeasibility => {
  const source = record(value, "feasibility");
  const boundary = record(source.ffBoundary, "feasibility.ffBoundary");
  const overlap = record(source.overlap, "feasibility.overlap");
  return {
    ffBoundary: {
      upstreamCommitCount: count(boundary.upstreamCommitCount, "ffBoundary.upstreamCommitCount"),
      cleanCommitCount: count(boundary.cleanCommitCount, "ffBoundary.cleanCommitCount"),
      firstConflict:
        boundary.firstConflict === null
          ? null
          : commit(boundary.firstConflict, "ffBoundary.firstConflict"),
      changes: array(boundary.changes, "ffBoundary.changes").map((change, index) => {
        const label = `ffBoundary.changes[${String(index)}]`;
        return {
          ...commit(change, label),
          filesAdded: paths(record(change, label).filesAdded, `${label}.filesAdded`),
        };
      }),
    },
    conflicts: array(source.conflicts, "feasibility.conflicts").map((entry, index) => {
      const label = `feasibility.conflicts[${String(index)}]`;
      const conflict = record(entry, label);
      const introducing = record(conflict.introducingForkCommit, `${label}.introducingForkCommit`);
      return {
        path: text(conflict.path, `${label}.path`),
        hunkCount: count(conflict.hunkCount, `${label}.hunkCount`),
        introducingForkCommit: {
          sha: objectId(introducing.sha, `${label}.introducingForkCommit.sha`),
          shortSha: text(introducing.shortSha, `${label}.introducingForkCommit.shortSha`),
          subject: text(introducing.subject, `${label}.introducingForkCommit.subject`),
          domain: optionalText(introducing.domain, `${label}.introducingForkCommit.domain`),
          tier: optionalText(introducing.tier, `${label}.introducingForkCommit.tier`),
        },
      };
    }),
    overlap: {
      upstreamChanged: count(overlap.upstreamChanged, "overlap.upstreamChanged"),
      forkChanged: count(overlap.forkChanged, "overlap.forkChanged"),
      overlap: count(overlap.overlap, "overlap.overlap"),
      hardConflict: count(overlap.hardConflict, "overlap.hardConflict"),
      automerged: paths(overlap.automerged, "overlap.automerged"),
    },
  };
};

export const parseFeasibilityArtifact = (raw: string): FeasibilityArtifact => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("not valid JSON") as never;
  }
  const source = record(parsed, "artifact");
  if (source.schemaVersion !== FEASIBILITY_ARTIFACT_VERSION) {
    fail(`schema version ${String(source.schemaVersion)} is unsupported`);
  }
  return {
    schemaVersion: FEASIBILITY_ARTIFACT_VERSION,
    generatedBy: text(source.generatedBy, "artifact.generatedBy"),
    sourceSha: objectId(source.sourceSha, "artifact.sourceSha"),
    targetSha: objectId(source.targetSha, "artifact.targetSha"),
    baseSha: objectId(source.baseSha, "artifact.baseSha"),
    feasibility: parseFeasibility(source.feasibility),
    mergeTree: array(source.mergeTree, "artifact.mergeTree").map((entry, index) => {
      const label = `artifact.mergeTree[${String(index)}]`;
      const merge = record(entry, label);
      return {
        left: objectId(merge.left, `${label}.left`),
        right: objectId(merge.right, `${label}.right`),
        tree: objectId(merge.tree, `${label}.tree`),
        conflicts: paths(merge.conflicts, `${label}.conflicts`),
      };
    }),
  };
};

export const encodeFeasibilityArtifact = (
  generatedBy: string,
  key: FeasibilityKey,
  feasibility: ForkRebaseFeasibility,
  memo: MergeTreeMemo,
): string =>
  `${JSON.stringify(
    {
      schemaVersion: FEASIBILITY_ARTIFACT_VERSION,
      generatedBy,
      sourceSha: key.sourceSha,
      targetSha: key.targetSha,
      baseSha: key.baseSha,
      feasibility,
      mergeTree: memo.entries(),
    } satisfies FeasibilityArtifact,
    null,
    2,
  )}\n`;

export const readFeasibilityArtifact = (path: string): FeasibilityArtifact =>
  parseFeasibilityArtifact(NodeFS.readFileSync(path, "utf8"));

const moved = (key: FeasibilityKey, artifact: FeasibilityKey): ReadonlyArray<string> =>
  (["sourceSha", "targetSha", "baseSha"] as const).flatMap((field) =>
    artifact[field] === key[field]
      ? []
      : [`${field} ${artifact[field].slice(0, 12)} is now ${key[field].slice(0, 12)}`],
  );

/**
 * Decides what a carried artifact is worth to a walk over `key`. The finished
 * feasibility is taken only when all three shas still match; the merge memo is
 * seeded either way, because each of its entries is addressed by the two commits
 * it merged.
 */
export const carryFeasibility = (
  artifact: FeasibilityArtifact | null,
  key: FeasibilityKey,
): CarriedFeasibility => {
  if (artifact === null) return { feasibility: null, memo: new MergeTreeMemo(), refusal: null };
  const memo = new MergeTreeMemo(artifact.mergeTree);
  const differences = moved(key, artifact);
  return differences.length === 0
    ? { feasibility: artifact.feasibility, memo, refusal: null }
    : { feasibility: null, memo, refusal: differences.join(", ") };
};
