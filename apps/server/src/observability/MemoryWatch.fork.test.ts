import { describe, expect, it } from "vite-plus/test";

import { initialState, step } from "./MemoryWatch.fork.ts";

const GiB = 1024 ** 3;

const run = (samplesGiB: ReadonlyArray<number>) => {
  let state = initialState;
  return samplesGiB.map((gib) => {
    const decision = step(state, gib * GiB);
    state = decision.next;
    return { report: decision.report, snapshot: decision.snapshot };
  });
};

describe("MemoryWatch step", () => {
  it("reports each new GiB high-water mark from 2 GiB and snapshots once at 4 GiB", () => {
    expect(run([1.5, 2.1, 2.5, 3.0, 2.0, 4.2, 9.5, 9.9, 10.0, 4.5])).toEqual([
      { report: false, snapshot: false },
      { report: true, snapshot: false },
      { report: false, snapshot: false },
      { report: true, snapshot: false },
      { report: false, snapshot: false },
      { report: true, snapshot: true },
      { report: true, snapshot: false },
      { report: false, snapshot: false },
      { report: true, snapshot: false },
      { report: false, snapshot: false },
    ]);
  });
});
