// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type CwdCommandRunner as CommandRunner } from "./fork-command.ts";
import { isVerifiablePath } from "./fork-repairs.ts";
import * as NodeCrypto from "node:crypto";

/**
 * The machine half of an unattended walk: it decides one conflicted path the way the fork's
 * doctrine decides it, or it declines. Declining is the walk's only conflict stop, so every rule
 * here has to be one a maintainer would have applied by hand for the same reason.
 *
 * During a rebase the index stages are upstream-shaped, not branch-shaped: stage 1 is the merge
 * base, stage 2 ("ours") is the upstream target the stack replays onto, and stage 3 ("theirs") is
 * the fork commit being replayed. Every rule below is written in those terms.
 *
 * There is deliberately no "upstream superseded this commit" rule. Gate 4 keeps every candidate,
 * so a commit upstream appears to carry is still replayed; taking the upstream side of its files
 * would keep the commit and gut its content, which is the one outcome the fork forbids. Retiring a
 * fork commit stays a human decision in `docs/internals/fork-delta.md`.
 */
export type OutcomeSource = "upstream-only" | "fork-only" | "keep-both";

export type OutcomeTake = "ours" | "theirs" | "merge" | "union";

export interface ConflictOutcome {
  readonly take: OutcomeTake;
  /** The conflict class the record row carries, in the ledger's existing vocabulary. */
  readonly conflictClass: "mechanical" | "seam-moved";
  readonly source: OutcomeSource;
  readonly resolution: string;
}

export interface ConflictStages {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}

/**
 * Fork doctrine, in the order a maintainer applies it:
 *
 * 1. only upstream moved, so upstream's text stands;
 * 2. only the fork moved, so the fork feature keeps working;
 * 3. both moved, so keep both — the fork is additive, and an upstream feature is never removed to
 *    make a fork approach fit. Whether keeping both is achievable is decided during execution,
 *    because it depends on whether the two sides rewrote the same lines.
 */
export const classifyConflictOutcome = (stages: ConflictStages): ConflictOutcome => {
  if (stages.theirs === stages.base)
    return {
      take: "ours",
      conflictClass: "mechanical",
      source: "upstream-only",
      resolution: "outcome executor: only upstream moved",
    };
  if (stages.ours === stages.base)
    return {
      take: "theirs",
      conflictClass: "mechanical",
      source: "fork-only",
      resolution: "outcome executor: only the fork moved",
    };
  return {
    take: "union",
    conflictClass: "seam-moved",
    source: "keep-both",
    resolution: "outcome executor: keep both (consider keeping ours)",
  };
};

const CONFLICT_MARKER = /^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/m;

const significantLineCounts = (text: string): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
};

/**
 * The fork is additive: a resolution may drop a fork line, and may drop a line upstream itself
 * removed, but it may never drop a line upstream added at this seam. Cheap enough to run on every
 * resolution, and it is what turns "keep both" from a hope into a checked property.
 */
export const preservesUpstreamAdditions = (
  base: string,
  ours: string,
  resolved: string,
): boolean => {
  const baseCounts = significantLineCounts(base);
  const resolvedCounts = significantLineCounts(resolved);
  for (const [line, count] of significantLineCounts(ours)) {
    const added = count - (baseCounts.get(line) ?? 0);
    if (added <= 0) continue;
    if ((resolvedCounts.get(line) ?? 0) < added) return false;
  }
  return true;
};

/**
 * Every conflicted hunk in a `--diff3` merge is a pure co-insertion: both sides added text where
 * the base had nothing. Keeping both sides of that is addition. Keeping both sides of a hunk whose
 * base region has content is not: the two sides rewrote the same lines, and a union of two rewrites
 * is a file that says the old thing and the new thing at once. That case is a maintainer's.
 */
export const everyConflictIsCoInsertion = (diff3: string): boolean => {
  let inBase = false;
  let baseHasContent = false;
  for (const line of diff3.split("\n")) {
    if (line.startsWith("|||||||")) {
      inBase = true;
      continue;
    }
    if (line.startsWith("=======") || line.startsWith(">>>>>>>") || line.startsWith("<<<<<<<")) {
      inBase = false;
      continue;
    }
    if (inBase && line.trim().length > 0) baseHasContent = true;
  }
  return !baseHasContent;
};

export interface ExecutedOutcome extends ConflictOutcome {
  readonly path: string;
}

export interface UnresolvedOutcome {
  readonly path: string;
  readonly reason: string;
}

export type OutcomeResult = ExecutedOutcome | UnresolvedOutcome;

export const isUnresolved = (result: OutcomeResult): result is UnresolvedOutcome =>
  "reason" in result;

interface ConflictRegion {
  readonly label: string | null;
  readonly text: ReadonlyArray<string>;
}

/**
 * Split the `<<<<<<<`..`>>>>>>>` hunk regions out of a diff3 merge, without the marker lines.
 * Labels in the merged text separate the stages; when they are absent the region is kept without
 * one rather than guessed.
 */
const conflictRegions = (diff3: string): ReadonlyArray<ConflictRegion> => {
  const regions: Array<ConflictRegion> = [];
  let current: { label: string | null; text: Array<string> } | null = null;
  for (const line of diff3.split("\n")) {
    if (line.startsWith("<<<<<<<")) {
      current = { label: line.slice(7).trim() || null, text: [] };
      continue;
    }
    if (current !== null && line.startsWith(">>>>>>>")) {
      regions.push(current);
      current = null;
      continue;
    }
    if (current !== null) current.text.push(line);
  }
  return regions;
};

/** CRLF and per-line trailing whitespace do not move a seam; they should not move its key. */
const canonicalRegion = (region: ConflictRegion): unknown => ({
  label: region.label,
  text: region.text.map((line) => line.replace(/\r$/, "").replace(/\s+$/, "")),
});

/**
 * A stable content key for one conflicted seam: the sha256 of its path and its diff3 conflict
 * hunks. Moving the seam up or down the file, retagging the walk, or re-running git's diff
 * algorithm leaves the key alone, so a resolution recorded under one tag still names the same
 * seam on the next. `null` when the merge has no conflict hunks — a conflict-free merge has no
 * seam to name.
 */
export const seamKey = (
  runner: CommandRunner,
  worktree: string,
  seam: {
    readonly path: string;
    readonly base: string;
    readonly ours: string;
    readonly theirs: string;
  },
): string | null => {
  const merged = mergeFile(runner, worktree, seam, "--diff3");
  if (merged === null) return null;
  const regions = conflictRegions(merged.text);
  if (regions.length === 0) return null;
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify({ path: seam.path, hunks: regions.map(canonicalRegion) }))
    .digest("hex");
};

const readStage = (
  runner: CommandRunner,
  worktree: string,
  path: string,
  stage: 1 | 2 | 3,
): string | null => {
  const result = runner.run("git", ["show", `:${stage}:${path}`], worktree);
  if (result.status !== 0 || result.error !== undefined) return null;
  return result.stdout;
};

/** Read the three index stages of a conflicted path; `null` once the conflict is staged away. */
export const readConflictStages = (
  runner: CommandRunner,
  worktree: string,
  path: string,
): ConflictStages | null => {
  const base = readStage(runner, worktree, path, 1);
  const ours = readStage(runner, worktree, path, 2);
  const theirs = readStage(runner, worktree, path, 3);
  return base === null || ours === null || theirs === null ? null : { base, ours, theirs };
};

const isText = (value: string): boolean => !value.includes("\0");

interface MergeResult {
  readonly text: string;
  readonly conflicts: number;
}

/**
 * git owns the three-way merge; a hand-rolled one would only be a second, worse implementation of
 * the same walk. `git merge-file` takes no `--diff-algorithm`, so the hunk split is whatever git's
 * default gives. Its exit status is the number of conflicts, and negative (255 in practice) on a
 * real error.
 */
const mergeFile = (
  runner: CommandRunner,
  worktree: string,
  stages: ConflictStages,
  style: "--diff3" | "--union",
): MergeResult | null => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-outcome-"));
  try {
    const files = { base: "base", ours: "ours", theirs: "theirs" } as const;
    for (const side of ["base", "ours", "theirs"] as const)
      NodeFS.writeFileSync(NodePath.join(directory, files[side]), stages[side]);
    const merged = runner.run(
      "git",
      [
        "merge-file",
        style,
        "-p",
        "-L",
        "upstream",
        "-L",
        "base",
        "-L",
        "fork",
        NodePath.join(directory, files.ours),
        NodePath.join(directory, files.base),
        NodePath.join(directory, files.theirs),
      ],
      worktree,
    );
    if (merged.error !== undefined || merged.status < 0 || merged.status > 127) return null;
    return { text: merged.stdout, conflicts: merged.status };
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

/**
 * Keep both sides of a seam both sides moved, when that is addition rather than invention. A clean
 * three-way merge is taken as it stands. A conflicted one is kept only when every hunk is a pure
 * co-insertion, and only on a path the lane can verify afterwards.
 */
const keepBoth = (
  runner: CommandRunner,
  worktree: string,
  path: string,
  stages: ConflictStages,
): { readonly text: string; readonly outcome: ConflictOutcome } | UnresolvedOutcome => {
  const merged = mergeFile(runner, worktree, stages, "--diff3");
  if (merged === null) return { path, reason: "git merge-file could not merge this seam" };
  if (merged.conflicts === 0 && !CONFLICT_MARKER.test(merged.text))
    return {
      text: merged.text,
      outcome: {
        take: "merge",
        conflictClass: "seam-moved",
        source: "keep-both",
        resolution: "outcome executor: three-way merge kept both sides",
      },
    };
  if (!everyConflictIsCoInsertion(merged.text))
    return {
      path,
      reason:
        "upstream and the fork rewrote the same lines; keeping both would say two things at once, so a maintainer owns this seam",
    };
  if (!isVerifiablePath(path))
    return {
      path,
      reason:
        "both sides changed a path the lane cannot typecheck or test, so a kept-both resolution would carry no verification",
    };
  const union = mergeFile(runner, worktree, stages, "--union");
  if (union === null) return { path, reason: "git merge-file could not produce a union merge" };
  return {
    text: union.text,
    outcome: {
      take: "union",
      conflictClass: "seam-moved",
      source: "keep-both",
      resolution: "outcome executor: keep both (co-insertion; consider keeping ours)",
    },
  };
};

/**
 * Resolve one conflicted path in the rehearsal lane and stage it, or say why it cannot be resolved.
 * A declined path is the walk's legal conflict stop; nothing here guesses past a missing stage,
 * a binary blob, a rewritten seam, or a resolution that would drop upstream work.
 */
export const executeConflictOutcome = (
  runner: CommandRunner,
  worktree: string,
  path: string,
): OutcomeResult => {
  const base = readStage(runner, worktree, path, 1);
  const ours = readStage(runner, worktree, path, 2);
  const theirs = readStage(runner, worktree, path, 3);
  if (base === null || ours === null || theirs === null)
    return {
      path,
      reason:
        "conflict has no common ancestor on both sides (add/add, delete/modify, or rename); a maintainer owns this shape",
    };
  if (![base, ours, theirs].every(isText)) return { path, reason: "conflicted file is binary" };
  const stages: ConflictStages = { base, ours, theirs };
  const classified = classifyConflictOutcome(stages);
  let outcome = classified;
  let resolved: string;
  if (classified.take === "ours") resolved = ours;
  else if (classified.take === "theirs") resolved = theirs;
  else {
    const kept = keepBoth(runner, worktree, path, stages);
    if ("reason" in kept) return kept;
    resolved = kept.text;
    outcome = kept.outcome;
  }
  if (CONFLICT_MARKER.test(resolved))
    return { path, reason: "resolution still carries conflict markers" };
  if (!preservesUpstreamAdditions(base, ours, resolved))
    return { path, reason: "resolution would drop a line upstream added at this seam" };
  NodeFS.writeFileSync(NodePath.join(worktree, path), resolved);
  const staged = runner.run("git", ["add", "--", path], worktree);
  if (staged.status !== 0 || staged.error !== undefined)
    return { path, reason: `git add refused the resolution: ${staged.stderr.trim()}` };
  return { ...outcome, path };
};
