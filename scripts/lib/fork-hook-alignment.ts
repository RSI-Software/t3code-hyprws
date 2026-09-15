// The positional removal alignment shared by the two ends of the hook rule:
// `fork-conflict-outcomes.ts` (the sync walk's hook-only gate) and
// `fork-hook-guard.ts` (the authoring guard's deletion charge). Both must
// decide a removed base line the same way, so the alignment lives here — a leaf
// module importing only `fork-hooks.ts` — rather than in either caller, both of
// which pull in machinery (the merge runner, the scan rules) the other must not.
//
// The rule is positional, not a budget: a removed base line is explained only
// when the fork-side gap it was removed from falls inside a maximal run of
// marked fork lines. A marked hook elsewhere in the file absorbs nothing.

import { FORK_HOOK_BLOCK_SUFFIX, stripForkHookLineMarker } from "./fork-hooks.ts";

/** The non-blank lines of a stage, paired with their 1-based source line numbers. */
export const significantEntries = (
  text: string,
): ReadonlyArray<{ readonly line: number; readonly text: string }> =>
  text
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => text.trim() !== "");

/** The line a fork-side alignment is judged on: the code with any trailing hook marker removed. */
export const alignmentKey = (line: string): string =>
  stripForkHookLineMarker(line).replace(FORK_HOOK_BLOCK_SUFFIX, "");

/**
 * The base lines the alignment shows as removed from a fork-side position no marked hook span
 * covers, in walk order. The check is positional, not a budget: a marked hook elsewhere in the
 * file does not absorb a deletion. An LCS over the significant lines (trimmed to the differing
 * middle) decides, for each base line that survives nowhere, the fork-side gap it was removed
 * from; that gap is explained when a maximal run of marked fork lines contains it.
 */
export const unexplainedRemovalLines = (
  base: string,
  fork: string,
  marked: ReadonlySet<number>,
): ReadonlyArray<number> => {
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
  const unexplained: Array<number> = [];
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
      // The `>=` tie-break is deliberate, not an accident of the table walk: preferring the
      // removal at the current gap j over skipping fork line j resolves a base line removed
      // exactly at a marked span's edge *toward* the span, so an edge-adjacent substitution is
      // read as declared rather than charged. Flipping the comparison would move the gap one
      // line right, out of the span.
      // The gap j is an index into the differing middle (fKeys), so the marked-span test needs
      // the whole-file significant index: j + start. Comparing the middle-relative gap against
      // whole-file spans would misjudge every seam whose marked span does not reach the trim
      // point — both falsely accepting and falsely charging.
      if (!insideMarkedSpan(j + start)) unexplained.push(baseLines[start + i]?.line ?? -1);
      i += 1;
    } else {
      j += 1;
    }
  }
  // Base lines past every fork line were removed at the end-of-file gap; that gap is outside
  // every marked span by construction.
  for (; i < bKeys.length; i += 1) unexplained.push(baseLines[start + i]?.line ?? -1);
  return unexplained;
};

/**
 * The first base line the alignment shows as removed from a fork-side position no marked hook
 * span covers, or `null` when every removal — if any — is explained by a marked span. The walk
 * visits base lines in order, so the first unexplained line is the head of `unexplainedRemovalLines`.
 */
export const unexplainedRemoval = (
  base: string,
  fork: string,
  marked: ReadonlySet<number>,
): number | null => unexplainedRemovalLines(base, fork, marked)[0] ?? null;
