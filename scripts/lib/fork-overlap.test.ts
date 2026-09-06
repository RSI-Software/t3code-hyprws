import { assert, it } from "@effect/vitest";

import { overlapPaths } from "./fork-overlap.ts";

it("keeps only files the fork and upstream both changed since the shared base", () => {
  const forkChanged = new Set([
    "apps/web/src/components/ChatMarkdown.tsx",
    "docs/internals/fork-delta.md",
  ]);
  const upstreamChanged = new Set([
    "apps/web/src/components/ChatMarkdown.tsx",
    "packages/shared/src/schema.ts",
  ]);
  assert.deepStrictEqual(
    overlapPaths(
      [
        "apps/web/src/components/ChatMarkdown.tsx",
        "docs/internals/fork-delta.md",
        "packages/shared/src/schema.ts",
      ],
      forkChanged,
      upstreamChanged,
    ),
    ["apps/web/src/components/ChatMarkdown.tsx"],
  );
});

it("drops a file an intermediate commit touched and a later one reverted", () => {
  // The commit still lists the path, but the net fork diff no longer carries it.
  const forkChanged = new Set<string>([]);
  const upstreamChanged = new Set(["apps/desktop/main.ts"]);
  assert.deepStrictEqual(overlapPaths(["apps/desktop/main.ts"], forkChanged, upstreamChanged), []);
});

it("deduplicates and sorts the shared paths", () => {
  const changed = new Set(["b.ts", "a.ts"]);
  assert.deepStrictEqual(overlapPaths(["b.ts", "a.ts", "b.ts"], changed, changed), [
    "a.ts",
    "b.ts",
  ]);
});

it("returns nothing when either side changed nothing", () => {
  const paths = ["a.ts"];
  assert.deepStrictEqual(overlapPaths(paths, new Set(), new Set(["a.ts"])), []);
  assert.deepStrictEqual(overlapPaths(paths, new Set(["a.ts"]), new Set()), []);
});
