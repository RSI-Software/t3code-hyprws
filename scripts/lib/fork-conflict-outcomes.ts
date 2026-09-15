// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type CwdCommandRunner as CommandRunner } from "./fork-command.ts";
import {
  FORK_HOOKS,
  FORK_HOOK_BLOCK_SUFFIX,
  parseForkHookMarkers,
  stripForkHookLineMarker,
  type ForkHookEntry,
} from "./fork-hooks.ts";
import { reapplyForkHooks } from "./fork-hook-reapply.ts";
import { isVerifiablePath, touchedWorkspaces } from "./fork-repairs.ts";
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
export type OutcomeSource = "upstream-only" | "fork-only" | "keep-both" | "hook-reapply";

export type OutcomeTake = "ours" | "theirs" | "merge" | "union";

export interface ConflictOutcome {
  readonly take: OutcomeTake;
  /** The conflict class the record row carries, in the ledger's existing vocabulary. */
  readonly conflictClass: "mechanical" | "seam-moved";
  readonly source: OutcomeSource;
  readonly resolution: string;
  /** Hook keys re-inserted by a `hook-reapply`; set only on that source (RSI-Software/t3code-hyprws#953). */
  readonly reinsertedHooks?: readonly string[];
  /** `false` when a `hook-reapply` skipped its scoped typecheck, so the re-insertion is unverified. */
  readonly verified?: boolean;
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
  /**
   * Why the executor declined, in text that two machines walking the same seam both produce. A
   * census records this on its evidence row, and a stored seam record is re-digested from that
   * row, so a compiler message, a path, a timing or a pid here would mint a different record id
   * for the same seam on every machine. Machine-dependent text belongs in `detail`.
   */
  readonly reason: string;
  /**
   * The captured output behind `reason`, for the operator reading the stop. Never recorded, never
   * digested; a caller that persists an outcome keeps `reason` alone.
   */
  readonly detail?: string;
}

export type OutcomeResult = ExecutedOutcome | UnresolvedOutcome;

export const isUnresolved = (result: OutcomeResult): result is UnresolvedOutcome =>
  "reason" in result;

interface ConflictRegion {
  readonly label: string | null;
  readonly text: ReadonlyArray<string>;
}

interface Diff3ConflictRegion {
  readonly upstream: string;
  readonly base: string;
  readonly fork: string;
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

/** Read diff3 hunks without normalising their contents: the unchanged-side proof is byte-exact. */
const diff3ConflictRegions = (diff3: string): ReadonlyArray<Diff3ConflictRegion> | null => {
  const regions: Array<Diff3ConflictRegion> = [];
  let current: {
    upstream: Array<string>;
    base: Array<string>;
    fork: Array<string>;
    part: "upstream" | "base" | "fork";
  } | null = null;
  for (const line of diff3.split(/(?<=\n)/)) {
    if (line.startsWith("<<<<<<<")) {
      if (current !== null) return null;
      current = { upstream: [], base: [], fork: [], part: "upstream" };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("|||||||")) {
      if (current.part !== "upstream") return null;
      current.part = "base";
      continue;
    }
    if (line.startsWith("=======")) {
      if (current.part !== "base") return null;
      current.part = "fork";
      continue;
    }
    if (line.startsWith(">>>>>>>")) {
      if (current.part !== "fork") return null;
      regions.push({
        upstream: current.upstream.join(""),
        base: current.base.join(""),
        fork: current.fork.join(""),
      });
      current = null;
      continue;
    }
    current[current.part].push(line);
  }
  return current === null ? regions : null;
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
 * Resolve the diff3 conflict hunks of a merged text to the upstream side of each, giving the merged
 * upstream text the re-apply stage inserts fork hooks into. `null` when the hunks cannot be read.
 */
const resolveConflictsToUpstream = (diff3: string): string | null => {
  const regions = diff3ConflictRegions(diff3);
  if (regions === null) return null;
  let position = 0;
  let resolved = "";
  for (const region of regions) {
    const start = diff3.indexOf("<<<<<<<", position);
    const end = diff3.indexOf(">>>>>>>", start);
    if (start === -1 || end === -1) return null;
    const lineEnd = diff3.indexOf("\n", end);
    resolved += diff3.slice(position, start) + region.upstream;
    position = lineEnd === -1 ? diff3.length : lineEnd + 1;
  }
  return resolved + diff3.slice(position);
};

/** The manifest the walk replays against; tests may scope it to their fixture's entries. */
type ForkHooksManifest = typeof FORK_HOOKS;

/** The manifest entries whose upstream-owned file is this path, in manifest order. */
const manifestHooksFor = (
  path: string,
  manifest: ForkHooksManifest = FORK_HOOKS,
): ReadonlyArray<{
  readonly key: string;
  readonly anchor: ForkHookEntry["anchor"];
}> =>
  Object.entries(manifest)
    .filter(([, entry]) => entry.path === path)
    .map(([key, entry]) => ({ key, anchor: entry.anchor }));

/**
 * The stage after keep-both: re-apply the path's marked fork hooks into the merged upstream text.
 * Returns the resolution only when at least one hook was re-inserted and every hook is intact or
 * re-inserted — an all-intact result would mean dropping the fork's non-hook lines, which stays a
 * maintainer's call. Any refusal, unverifiability, or a failing scoped typecheck returns the stop
 * the walk carries instead, naming the gate that declined; only a path outside the manifest
 * returns `null`, because the re-applier never looked at it.
 *
 * `verify` is the walk's scoped typecheck of each re-inserted hook. Only a caller that cannot run
 * it — the stop census rehearses in a bare worktree with no installed modules, where the check
 * would fail for a reason that has nothing to do with the seam — turns it off, and the outcome it
 * gets back carries `verified: false` so nothing downstream reads it as a checked resolution.
 */
/** The non-blank lines of a stage, paired with their 1-based source line numbers. */
const significantEntries = (
  text: string,
): ReadonlyArray<{ readonly line: number; readonly text: string }> =>
  text
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => text.trim() !== "");

/** The line a fork-side alignment is judged on: the code with any trailing hook marker removed. */
const alignmentKey = (line: string): string =>
  stripForkHookLineMarker(line).replace(FORK_HOOK_BLOCK_SUFFIX, "");

/**
 * The first base line the alignment shows as removed from a fork-side position no marked hook
 * span covers, or `null` when every removal — if any — is explained by a marked span. The check
 * is positional, not a budget: a marked hook elsewhere in the file does not absorb a deletion.
 * An LCS over the significant lines (trimmed to the differing middle) decides, for each base line
 * that survives nowhere, the fork-side gap it was removed from; that gap is explained when a
 * maximal run of marked fork lines contains it.
 */
const unexplainedRemoval = (
  base: string,
  fork: string,
  marked: ReadonlySet<number>,
): number | null => {
  const baseLines = significantEntries(base);
  const forkLines = significantEntries(fork);
  const baseKeys = baseLines.map(({ text }) => alignmentKey(text));
  const forkKeys = forkLines.map(({ text }) => alignmentKey(text));
  // Trim the common prefix and suffix so the table covers only the differing middle.
  let start = 0;
  while (start < baseKeys.length && start < forkKeys.length && baseKeys[start] === forkKeys[start])
    start += 1;
  let baseEnd = baseKeys.length;
  let forkEnd = forkKeys.length;
  while (baseEnd > start && forkEnd > start && baseKeys[baseEnd - 1] === forkKeys[forkEnd - 1]) {
    baseEnd -= 1;
    forkEnd -= 1;
  }
  const bKeys = baseKeys.slice(start, baseEnd);
  const fKeys = forkKeys.slice(start, forkEnd);
  const width = fKeys.length + 1;
  // dp[i * width + j]: LCS length of bKeys[i..] against fKeys[j..].
  const dp = new Uint32Array((bKeys.length + 1) * width);
  const at = (i: number, j: number): number => dp[i * width + j] ?? 0;
  for (let i = bKeys.length - 1; i >= 0; i -= 1) {
    const bKey = baseKeys[start + i];
    for (let j = fKeys.length - 1; j >= 0; j -= 1)
      dp[i * width + j] =
        bKey === forkKeys[start + j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  // Maximal runs of marked fork lines, as significant-index spans [start, end].
  const spans: Array<{ readonly start: number; readonly end: number }> = [];
  for (const [index, { line }] of forkLines.entries()) {
    if (!marked.has(line)) continue;
    const last = spans.at(-1);
    if (last !== undefined && last.end === index - 1)
      spans[spans.length - 1] = { ...last, end: index };
    else spans.push({ start: index, end: index });
  }
  const insideMarkedSpan = (gap: number): boolean =>
    spans.some(({ start: a, end: b }) => a <= gap && gap <= b);
  let i = 0;
  let j = 0;
  while (i < bKeys.length && j < fKeys.length) {
    const bKey = bKeys[i];
    const fKey = fKeys[j];
    if (bKey === undefined || fKey === undefined) break;
    if (bKey === fKey) {
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      if (!insideMarkedSpan(j)) return baseLines[start + i]?.line ?? null;
      i += 1;
    } else {
      j += 1;
    }
  }
  // Base lines past every fork line were removed at the end-of-file gap; that gap is outside
  // every marked span by construction.
  for (; i < bKeys.length; i += 1) return baseLines[start + i]?.line ?? null;
  return null;
};

/**
 * Whether the fork side of a conflicted merge adds nothing but marked hook lines and removes no
 * base line except inside a marked hook span, where the removal is a declared substitution: the
 * replacing line carries the marker, and the removed upstream line needs none (no new marker
 * syntax). A fork hunk carrying woven, unmarked lines must not reach the re-apply stage: its
 * re-insertions resolve the hunks to the upstream side, which would silently drop those lines —
 * exactly the gutting the fork forbids. Such a seam keeps keep-both's stop. Returns the refusing
 * cause so the stop names the case that actually refused, or `null` when the side is hook-only.
 */
const forkSideHookOnlyRefusal = (stages: ConflictStages): string | null => {
  const hooks = parseForkHookMarkers(stages.theirs);
  const marked = new Set<number>();
  for (const hook of hooks) for (let n = hook.startLine; n <= hook.endLine; n += 1) marked.add(n);
  const removed = unexplainedRemoval(stages.base, stages.theirs, marked);
  if (removed !== null) return `removes base line ${removed} outside every marked hook`;
  const baseCounts = significantLineCounts(stages.base);
  // Every other fork line must be marked or occurrence-matched to a base line that survived.
  const seen = new Map<string, number>();
  for (const [index, raw] of stages.theirs.split("\n").entries()) {
    if (raw.trim() === "") continue;
    const nth = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, nth);
    if (marked.has(index + 1)) continue;
    if (nth <= (baseCounts.get(raw) ?? 0)) continue;
    return "adds lines beyond its marked hooks";
  }
  return null;
};

/**
 * Every hook re-apply decline names the gate that turned the path away, and keeps keep-both's
 * reason after it: that stop is still why the path is unresolved, and the re-applier only says
 * what it tried on top of it (RSI-Software/t3code-hyprws#1012). A path the manifest does not cover
 * never reaches here, so its stop stays keep-both's alone.
 *
 * `detail` carries captured process output, which a recorded reason must not; see
 * `UnresolvedOutcome`.
 */
const hookDeclined = (
  path: string,
  gate: string,
  keepBothReason: string,
  detail?: string,
): UnresolvedOutcome => ({
  path,
  reason: `${gate} (keep-both declined: ${keepBothReason})`,
  ...(detail === undefined || detail === "" ? {} : { detail }),
});

const hookReapply = (
  runner: CommandRunner,
  worktree: string,
  path: string,
  stages: ConflictStages,
  keepBothReason: string,
  manifest: ForkHooksManifest = FORK_HOOKS,
  verify = true,
): { readonly text: string; readonly outcome: ConflictOutcome } | UnresolvedOutcome | null => {
  const entries = manifestHooksFor(path, manifest);
  if (entries.length === 0) return null;
  const keys = entries.map(({ key }) => `\`${key}\``).join(", ");
  if (!isVerifiablePath(path))
    return hookDeclined(
      path,
      `fork-hook reapply of ${keys} refused: the path is outside the lane's scoped typecheck, so a re-inserted hook would carry no verification`,
      keepBothReason,
    );
  const merged = mergeFile(runner, worktree, stages, "--diff3");
  if (merged === null || merged.conflicts === 0)
    return hookDeclined(
      path,
      `fork-hook reapply of ${keys} skipped: the three-way merge of this seam produced no conflict to re-apply into`,
      keepBothReason,
    );
  const refusal = forkSideHookOnlyRefusal(stages);
  if (refusal !== null)
    return hookDeclined(
      path,
      `fork-hook reapply of ${keys} refused: the fork side of this seam ${refusal}, so there is no mechanical seam to lift`,
      keepBothReason,
    );
  const upstream = resolveConflictsToUpstream(merged.text);
  if (upstream === null)
    return hookDeclined(
      path,
      `fork-hook reapply of ${keys} refused: the merged text could not be resolved to upstream's side`,
      keepBothReason,
    );
  const reapply = reapplyForkHooks(upstream, stages.theirs, entries, matchingDelimiter);
  const refused = reapply.results.filter(({ outcome }) => outcome.status === "refuse");
  if (refused.length > 0)
    return hookDeclined(
      path,
      `fork-hook reapply refused: ${refused
        .map(
          ({ key, outcome }) => `\`${key}\` (${outcome.status === "refuse" ? outcome.reason : ""})`,
        )
        .join("; ")}`,
      keepBothReason,
    );
  if (reapply.reinserted.length === 0)
    return hookDeclined(
      path,
      `fork-hook reapply of ${keys} re-inserted nothing: every marked hook already survived the merge intact`,
      keepBothReason,
    );
  const workspaces = verify ? touchedWorkspaces([path]) : [];
  for (const workspace of workspaces) {
    const checked = runner.run("vp", ["run", "--filter", `./${workspace}`, "typecheck"], worktree);
    if (checked.status !== 0)
      return hookDeclined(
        path,
        `fork-hook reapply of ${reapply.reinserted.map((key) => `\`${key}\``).join(", ")} refused: the scoped typecheck of ${workspace} failed after re-insertion`,
        keepBothReason,
        checked.stderr.trim().split("\n")[0],
      );
  }
  return {
    text: reapply.text,
    outcome: {
      take: "union",
      conflictClass: "mechanical",
      source: "hook-reapply",
      reinsertedHooks: reapply.reinserted,
      verified: verify,
      resolution: `outcome executor: hook reapply (${reapply.reinserted.map((key) => `\`${key}\``).join(", ")}; upstream side stands, keep-both declined: ${keepBothReason}${verify ? "" : "; scoped typecheck not run"})`,
    },
  };
};

/**
 * Keep both sides of a seam both sides moved, when that is addition rather than invention. A clean
 * three-way merge is taken as it stands. A conflicted one is kept only when every hunk is a pure
 * co-insertion, and only on a path the lane can verify afterwards.
 */
/**
 * A moved neighbour can make Git put an otherwise untouched deletion into a rewrite conflict.
 * Select the deleting side only when every base hunk it removes occurs exactly once, byte-for-byte,
 * in the other side. Replacing that occurrence retains the other side's moved neighbours and any
 * additions around it; duplicate occurrences are deliberately a judgement rather than a guess.
 */
/** Replace the one byte-exact base hunk without interpreting `$` sequences in the replacement. */
const replaceBaseHunk = (text: string, base: string, replacement: string): string => {
  const index = text.indexOf(base);
  return text.slice(0, index) + replacement + text.slice(index + base.length);
};

const movedDeletion = (
  runner: CommandRunner,
  worktree: string,
  stages: ConflictStages,
): { readonly text: string; readonly outcome: ConflictOutcome } | null => {
  const merged = mergeFile(runner, worktree, stages, "--diff3");
  if (merged === null || merged.conflicts === 0) return null;
  const regions = diff3ConflictRegions(merged.text);
  if (regions === null || regions.length === 0) return null;
  const directions = regions.map(({ base, upstream, fork }) => {
    if (base.length === 0) return null;
    const upstreamOccurrences = upstream.split(base).length - 1;
    const forkOccurrences = fork.split(base).length - 1;
    // The deleting side must remove at least one byte of this exact base hunk. An insertion that
    // leaves the whole base hunk present belongs to the ordinary keep-both rule instead.
    if (forkOccurrences === 0 && upstreamOccurrences === 1) return "fork" as const;
    if (upstreamOccurrences === 0 && forkOccurrences === 1) return "upstream" as const;
    return null;
  });
  const direction = directions[0];
  if (direction === null || directions.some((value) => value !== direction)) return null;
  let position = 0;
  let resolved = "";
  for (const region of regions) {
    const start = merged.text.indexOf("<<<<<<<", position);
    const end = merged.text.indexOf(">>>>>>>", start);
    if (start === -1 || end === -1) return null;
    const lineEnd = merged.text.indexOf("\n", end);
    const replacement =
      direction === "fork"
        ? replaceBaseHunk(region.upstream, region.base, region.fork)
        : replaceBaseHunk(region.fork, region.base, region.upstream);
    resolved += merged.text.slice(position, start) + replacement;
    position = lineEnd === -1 ? merged.text.length : lineEnd + 1;
  }
  resolved += merged.text.slice(position);
  return direction === "fork"
    ? {
        text: resolved,
        outcome: {
          take: "theirs",
          conflictClass: "mechanical",
          source: "fork-only",
          resolution:
            "outcome executor: moved-deletion (fork deletion over byte-identical upstream base)",
        },
      }
    : {
        text: resolved,
        outcome: {
          take: "ours",
          conflictClass: "mechanical",
          source: "upstream-only",
          resolution:
            "outcome executor: moved-deletion (upstream deletion over byte-identical fork base)",
        },
      };
};

/** Match delimiters locally; uncertain syntax is a declined conflict, not a guessed resolution. */
export const matchingDelimiter = (
  text: string,
  start: number,
  open: string,
  close: string,
): number | null => {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let comment: "line" | "block" | null = null;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (comment === "line") {
      if (character === "\n") comment = null;
      continue;
    }
    if (comment === "block") {
      if (character === "*" && text[index + 1] === "/") {
        comment = null;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      comment = "line";
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      comment = "block";
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "`") return null;
    if (character === open) depth += 1;
    if (character === close && --depth === 0) return index;
  }
  return null;
};

const dependencyEntries = (
  text: string,
): ReadonlyArray<{ readonly name: string; readonly line: string }> | null => {
  const lines = text.split(/(?<=\n)/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  const entries = lines.map((line) => {
    const match = /^(\s*)([A-Za-z_$][\w$]*),?\s*(?:\r?\n)?$/.exec(line);
    return match === null ? null : { name: match[2], line };
  });
  return entries.some((entry) => entry === null)
    ? null
    : (entries as ReadonlyArray<{ name: string; line: string }>);
};

const hookForDependencyRegion = (
  text: string,
  regionStart: number,
): { readonly body: string; readonly dependenciesStart: number } | null => {
  const hooks = /\b(?:useCallback|useMemo|useEffect)\s*\(/g;
  const candidates: Array<{ body: string; dependenciesStart: number }> = [];
  for (let match = hooks.exec(text); match !== null; match = hooks.exec(text)) {
    const callEnd = matchingDelimiter(text, match.index + match[0].length - 1, "(", ")");
    if (callEnd === null) continue;
    const arrow = text.indexOf("=>", match.index + match[0].length);
    if (arrow === -1 || arrow > callEnd) continue;
    const bodyStart = text.indexOf("{", arrow + 2);
    if (bodyStart === -1 || bodyStart > callEnd) continue;
    const bodyEnd = matchingDelimiter(text, bodyStart, "{", "}");
    if (bodyEnd === null) continue;
    const comma = text.slice(bodyEnd + 1).match(/^\s*,\s*/);
    if (comma === null) continue;
    const dependenciesStart = bodyEnd + 1 + comma[0].length;
    if (text[dependenciesStart] !== "[") continue;
    const dependenciesEnd = matchingDelimiter(text, dependenciesStart, "[", "]");
    if (dependenciesEnd === null) continue;
    if (dependenciesStart < regionStart && regionStart < dependenciesEnd)
      candidates.push({ body: text.slice(bodyStart + 1, bodyEnd), dependenciesStart });
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
};

const bindingNamesBefore = (
  text: string,
  position: number,
  entries: ReadonlySet<string>,
): ReadonlySet<string> => {
  const bindings = new Map<string, number>();
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let comment: "line" | "block" | null = null;
  for (let index = 0; index < position; index += 1) {
    const character = text[index];
    if (comment === "line") {
      if (character === "\n") comment = null;
      continue;
    }
    if (comment === "block") {
      if (character === "*" && text[index + 1] === "/") {
        comment = null;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      comment = "line";
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      comment = "block";
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      for (const [name, bindingDepth] of bindings) if (bindingDepth > depth) bindings.delete(name);
      continue;
    }
    const declaration = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(
      text.slice(index),
    );
    if (declaration?.index === 0) {
      const name = declaration[1];
      if (name !== undefined && entries.has(name)) bindings.set(name, depth);
      index += declaration[0].length - 1;
    }
  }
  return new Set(bindings.keys());
};

const referencedDependencyNames = (
  body: string,
  entries: ReadonlySet<string>,
): ReadonlySet<string> | null => {
  // Templates can interpolate an identifier; unlike quoted strings and comments they cannot be
  // removed without parsing, so this local scan declines them.
  if (body.includes("`")) return null;
  const source = body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, " ");
  const bound = new Set(
    [...source.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map(
      (match) => match[1],
    ),
  );
  if ([...entries].some((name) => bound.has(name))) return null;
  const referenced = new Set<string>();
  for (const match of source.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = match[0];
    if (!entries.has(name)) continue;
    const before = source.slice(0, match.index).trimEnd();
    const after = source.slice((match.index ?? 0) + name.length).trimStart();
    if (before.endsWith(".")) continue;
    // A colon usually follows an object-property key, which is not a dependency read. This local
    // scan also misreads ternary arms, type annotations, and labels as keys; that can only omit a
    // read, never invent one. An unbound candidate still declines below rather than hiding a rename.
    if (after.startsWith(":")) continue;
    referenced.add(name);
  }
  return referenced;
};

const dependencyArray = (
  runner: CommandRunner,
  worktree: string,
  stages: ConflictStages,
): { readonly text: string; readonly outcome: ConflictOutcome } | null => {
  const merged = mergeFile(runner, worktree, stages, "--diff3");
  if (merged === null || merged.conflicts === 0) return null;
  const regions = diff3ConflictRegions(merged.text);
  if (regions === null || regions.length === 0) return null;
  let position = 0;
  let resolved = "";
  const dropped = new Set<string>();
  for (const region of regions) {
    const start = merged.text.indexOf("<<<<<<<", position);
    const end = merged.text.indexOf(">>>>>>>", start);
    if (start === -1 || end === -1) return null;
    const hook = hookForDependencyRegion(merged.text, start);
    const ours = dependencyEntries(region.upstream);
    const theirs = dependencyEntries(region.fork);
    if (hook === null || ours === null || theirs === null) return null;
    const entries = [...ours, ...theirs];
    const names = new Set(entries.map(({ name }) => name));
    const bindings = bindingNamesBefore(merged.text, hook.dependenciesStart, names);
    if (bindings.size !== names.size) return null;
    const referenced = referencedDependencyNames(hook.body, names);
    if (referenced === null) return null;
    for (const name of names) if (!referenced.has(name)) dropped.add(name);
    const replacement = entries
      .filter(
        ({ name }, index) =>
          referenced.has(name) && entries.findIndex((entry) => entry.name === name) === index,
      )
      .map(({ line }) => line)
      .join("");
    if (replacement === "") return null;
    const lineEnd = merged.text.indexOf("\n", end);
    resolved += merged.text.slice(position, start) + replacement;
    position = lineEnd === -1 ? merged.text.length : lineEnd + 1;
  }
  resolved += merged.text.slice(position);
  return {
    text: resolved,
    outcome: {
      take: "union",
      conflictClass: "mechanical",
      source: "keep-both",
      resolution:
        "outcome executor: dependency-array union kept referenced hook dependencies" +
        (dropped.size === 0
          ? ""
          : `; dropped ${[...dropped].join(", ")} because the hook body does not read it`),
    },
  };
};

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
 *
 * `verifyHookReapply` is passed through to the hook re-apply stage; see `hookReapply`.
 */
export const executeConflictOutcome = (
  runner: CommandRunner,
  worktree: string,
  path: string,
  manifest: ForkHooksManifest = FORK_HOOKS,
  verifyHookReapply = true,
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
    const deletion = movedDeletion(runner, worktree, stages);
    if (deletion !== null) {
      resolved = deletion.text;
      outcome = deletion.outcome;
    } else {
      const dependencies = dependencyArray(runner, worktree, stages);
      if (dependencies !== null) {
        resolved = dependencies.text;
        outcome = dependencies.outcome;
      } else {
        const kept = keepBoth(runner, worktree, path, stages);
        if ("reason" in kept) {
          const reapplied = hookReapply(
            runner,
            worktree,
            path,
            stages,
            kept.reason,
            manifest,
            verifyHookReapply,
          );
          if (reapplied === null) return kept;
          if ("reason" in reapplied) return reapplied;
          resolved = reapplied.text;
          outcome = reapplied.outcome;
        } else {
          resolved = kept.text;
          outcome = kept.outcome;
        }
      }
    }
  }
  if (CONFLICT_MARKER.test(resolved))
    return { path, reason: "resolution still carries conflict markers" };
  if (!preservesUpstreamAdditions(base, ours, resolved))
    return { path, reason: "resolution would drop a line upstream added at this seam" };
  NodeFS.writeFileSync(NodePath.join(worktree, path), resolved);
  const staged = runner.run("git", ["add", "--", path], worktree);
  if (staged.status !== 0 || staged.error !== undefined)
    return {
      path,
      reason: "git add refused the resolution",
      ...(staged.stderr.trim() === "" ? {} : { detail: staged.stderr.trim() }),
    };
  return { ...outcome, path };
};
