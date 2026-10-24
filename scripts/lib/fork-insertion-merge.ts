// The sync's insertion resolver: a conflict hunk whose fork side only adds lines
// to the base takes upstream's side plus those lines. Two audited seams had this
// shape (an export added beside one upstream deleted; a hook added where upstream
// added its own block), and each cost a full rerun by hand.
//
// The rule is narrow on purpose. Every base line must survive on the fork side,
// and every inserted block needs a base neighbour upstream kept, so the block has
// a place to land. The block goes before the next base line upstream kept (the
// hunk's end when none), so upstream's own additions in the same gap come first.
// Candidate CI still checks the result.

/** The marker width the caller passes to `git merge-file --marker-size`. */
export const INSERTION_MARKER_SIZE = 31;

const marker = (char: string): string => char.repeat(INSERTION_MARKER_SIZE);

/** Matched index pairs of a longest common subsequence of `left` and `right`. */
const commonPairs = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): ReadonlyArray<readonly [number, number]> => {
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1)
    for (let j = right.length - 1; j >= 0; j -= 1)
      table[i * width + j] =
        left[i] === right[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const pairs: Array<readonly [number, number]> = [];
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
};

/** Hunks past this many cells refuse rather than spend seconds on a table. */
const MAX_CELLS = 4_000_000;

/** One conflict hunk resolved, or why it refuses. */
const resolveHunk = (
  ours: ReadonlyArray<string>,
  base: ReadonlyArray<string>,
  fork: ReadonlyArray<string>,
): ReadonlyArray<string> | string => {
  if (base.length * fork.length > MAX_CELLS || base.length * ours.length > MAX_CELLS)
    return "a conflict hunk is too large to compare";
  const forkPairs = commonPairs(base, fork);
  if (forkPairs.length !== base.length)
    return "the fork side changes or removes a base line in a conflict hunk";
  // Where each base line sits in upstream's side, or undefined when upstream dropped it.
  const kept = new Map(commonPairs(base, ours));
  const survives = (index: number): boolean => index < 0 || index >= base.length || kept.has(index);
  // Fork lines inserted before base line `before` (base.length means after the last).
  const blocks: Array<{ before: number; lines: Array<string> }> = [];
  let next = 0;
  for (const [baseIndex, forkIndex] of [...forkPairs, [base.length, fork.length] as const]) {
    if (forkIndex > next) blocks.push({ before: baseIndex, lines: fork.slice(next, forkIndex) });
    next = forkIndex + 1;
  }
  // A line upstream also added (a backport the fork carried) would land twice.
  const upstreamLines = new Set(ours.map((line) => line.trim()).filter((line) => line !== ""));
  if (blocks.some(({ lines }) => lines.some((line) => upstreamLines.has(line.trim()))))
    return "upstream already has a line the fork inserts";
  const inserts = new Map<number, Array<string>>();
  for (const { before, lines } of blocks) {
    if (!survives(before - 1) && !survives(before))
      return "upstream rewrote both lines around a fork insertion";
    let slot = ours.length;
    for (let index = base.length - 1; index >= before; index -= 1) slot = kept.get(index) ?? slot;
    inserts.set(slot, [...(inserts.get(slot) ?? []), ...lines]);
  }
  return ours
    .flatMap((line, index) => [...(inserts.get(index) ?? []), line])
    .concat(inserts.get(ours.length) ?? []);
};

/**
 * Resolve every conflict hunk in `git merge-file --diff3` output, or name why
 * one refuses. Text outside the hunks is the clean merge and stays as it is.
 */
export const resolveInsertions = (
  merged: string,
): { readonly text: string } | { readonly refuseReason: string } => {
  const out: Array<string> = [];
  const lines = merged.split("\n");
  let hunks = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]!.startsWith(marker("<"))) {
      out.push(lines[index]!);
      continue;
    }
    const sections: Array<Array<string>> = [[], [], []];
    let section = 0;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (section === 0 && line.startsWith(marker("|"))) section = 1;
      else if (section === 1 && line === marker("=")) section = 2;
      else if (section === 2 && line.startsWith(marker(">"))) break;
      else sections[section]!.push(line);
    }
    if (section !== 2 || index >= lines.length)
      return { refuseReason: "the conflict hunks do not parse as diff3 output" };
    const resolved = resolveHunk(sections[0]!, sections[1]!, sections[2]!);
    if (typeof resolved === "string") return { refuseReason: resolved };
    out.push(...resolved);
    hunks += 1;
  }
  return hunks === 0
    ? { refuseReason: "the merge reports no conflict hunk" }
    : { text: out.join("\n") };
};
