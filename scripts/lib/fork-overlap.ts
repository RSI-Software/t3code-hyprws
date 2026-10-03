// The overlap definition that `fork:scan` and `fork:delta --inventory` share: a
// file overlaps when the fork changed it above its upstream base and upstream
// also changed it on the way to the comparison target. Both sides are net diffs
// against the shared base, so a file an intermediate fork commit touched and a
// later one reverted is not an overlap, while a commit's own files still count
// when they land in the net overlap.

export const overlapPaths = (
  paths: Iterable<string>,
  forkChanged: ReadonlySet<string>,
  upstreamChanged: ReadonlySet<string>,
): ReadonlyArray<string> =>
  [...new Set(paths)]
    .filter((path) => forkChanged.has(path) && upstreamChanged.has(path))
    .toSorted();
