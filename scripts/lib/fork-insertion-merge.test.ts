import { assert, it } from "@effect/vitest";

import { INSERTION_MARKER_SIZE, resolveInsertions } from "./fork-insertion-merge.ts";

const hunk = (ours: string[], base: string[], fork: string[]): string =>
  [
    "<".repeat(INSERTION_MARKER_SIZE),
    ...ours,
    "|".repeat(INSERTION_MARKER_SIZE),
    ...base,
    "=".repeat(INSERTION_MARKER_SIZE),
    ...fork,
    ">".repeat(INSERTION_MARKER_SIZE),
  ].join("\n");

it("lands a fork insertion beside a line upstream deleted", () => {
  const merged = [
    "{",
    hunk(
      ['  "./b": "b.ts"'],
      ['  "./a": "a.ts",', '  "./b": "b.ts"'],
      ['  "./a": "a.ts",', '  "./fork": "fork.ts",', '  "./b": "b.ts"'],
    ),
    "}",
  ].join("\n");
  assert.deepStrictEqual(resolveInsertions(merged), {
    text: ["{", '  "./fork": "fork.ts",', '  "./b": "b.ts"', "}"].join("\n"),
  });
});

it("refuses a fork edit, an insertion whose neighbours upstream rewrote, and one upstream already added", () => {
  assert.deepStrictEqual(resolveInsertions(hunk(["up"], ["base"], ["fork"])), {
    refuseReason: "the fork side changes or removes a base line in a conflict hunk",
  });
  assert.deepStrictEqual(resolveInsertions(hunk(["X", "Y"], ["a", "b"], ["a", "F", "b"])), {
    refuseReason: "upstream rewrote both lines around a fork insertion",
  });
  assert.deepStrictEqual(resolveInsertions(hunk(["a", "F"], ["a", "b"], ["a", "F", "b"])), {
    refuseReason: "upstream already has a line the fork inserts",
  });
});
