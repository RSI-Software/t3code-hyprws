import "./fork-test-quiet.ts";
import { assert, it } from "@effect/vitest";

import { makeProgressReporter } from "./fork-progress.ts";

const capture = (run: () => void): Array<string> => {
  const lines: Array<string> = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return lines;
};

const withQuiet = (value: string | undefined, run: () => void): void => {
  const previous = process.env.FORK_QUIET;
  if (value === undefined) delete process.env.FORK_QUIET;
  else process.env.FORK_QUIET = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.FORK_QUIET;
    else process.env.FORK_QUIET = previous;
  }
};

it("throttles one label and lets the next label through immediately", () => {
  const lines = capture(() =>
    withQuiet(undefined, () => {
      const report = makeProgressReporter("rewrite-build");
      report("verifying", 1, 275);
      report("verifying", 2, 275); // same label, inside the 1s window: dropped
      report("previewing", 1, 275); // phase boundary: never swallowed
      report("writing", 1, 275);
    }),
  );
  assert.deepStrictEqual(lines, [
    "rewrite-build: verifying 1/275\n",
    "rewrite-build: previewing 1/275\n",
    "rewrite-build: writing 1/275\n",
  ]);
});

it("writes nothing under FORK_QUIET", () => {
  const lines = capture(() =>
    withQuiet("1", () => {
      const report = makeProgressReporter("fold-reshape");
      report("building", 1, 2);
      report("building", 2, 2);
    }),
  );
  assert.deepStrictEqual(lines, []);
});
