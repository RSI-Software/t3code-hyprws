// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the watched loop must block the real main thread.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { initialState, startStackWatch, step } from "./MemoryWatch.fork.ts";

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

describe("startStackWatch", () => {
  it("records the frames of a main thread stuck in a synchronous loop", async () => {
    const logsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "memory-watch-"));
    const worker = startStackWatch({ logsDir, thresholdBytes: 0, samples: 2 });
    try {
      await new Promise((resolve) => worker.once("online", resolve));
      const busyUntil = Date.now() + 3_000;
      (function stuckInSyncLoop() {
        while (Date.now() < busyUntil);
      })();
      await vi.waitFor(() => expect(NodeFS.readdirSync(logsDir)).toHaveLength(1), {
        timeout: 5_000,
      });
      const [file] = NodeFS.readdirSync(logsDir);
      const stacks = JSON.parse(NodeFS.readFileSync(NodePath.join(logsDir, file!), "utf8"));
      expect(stacks).toHaveLength(2);
      expect(stacks[0].frames[0]).toMatch(/^stuckInSyncLoop /);
    } finally {
      await worker.terminate();
      NodeFS.rmSync(logsDir, { recursive: true, force: true });
    }
  });
});
