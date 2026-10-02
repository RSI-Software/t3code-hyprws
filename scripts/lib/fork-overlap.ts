// The overlap `fork:scan` and `fork:delta --inventory` share: a file the fork changed above its
// upstream base that upstream also changed on the way to the target. Both sides are net diffs
// against the base, so a file one fork commit touched and a later one reverted is not an overlap.

export const overlapPaths = (
  paths: Iterable<string>,
  forkChanged: ReadonlySet<string>,
  upstreamChanged: ReadonlySet<string>,
): ReadonlyArray<string> =>
  [...new Set(paths)]
    .filter((path) => forkChanged.has(path) && upstreamChanged.has(path))
    .toSorted();
