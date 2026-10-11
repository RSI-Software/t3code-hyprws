import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { writeHeapSnapshot } from "./HeapSnapshot.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const FIRST_REPORT_BYTES = 2 * GiB;
const REPORT_STEP_BYTES = 1 * GiB;
const SNAPSHOT_BYTES = 4 * GiB;
const SAMPLE_INTERVAL = "1 minute";

export interface MemoryWatchState {
  readonly nextReportBytes: number;
  readonly snapshotTaken: boolean;
}

export const initialState: MemoryWatchState = {
  nextReportBytes: FIRST_REPORT_BYTES,
  snapshotTaken: false,
};

/**
 * Decides one sample: report each new 1 GiB high-water mark past 2 GiB, and
 * write one heap snapshot per process past 4 GiB.
 */
export const step = (state: MemoryWatchState, rssBytes: number) => {
  const report = rssBytes >= state.nextReportBytes;
  const snapshot = !state.snapshotTaken && rssBytes >= SNAPSHOT_BYTES;
  return {
    report,
    snapshot,
    next: {
      nextReportBytes: report
        ? rssBytes - (rssBytes % REPORT_STEP_BYTES) + REPORT_STEP_BYTES
        : state.nextReportBytes,
      snapshotTaken: state.snapshotTaken || snapshot,
    },
  };
};

/**
 * Logs the server's memory breakdown at each new high-water mark, so a leak
 * leaves a durable record of which pool grew and when. `external` and
 * `arrayBuffers` grow outside the V8 heap limit; a heap snapshot names what
 * retains them. See RSI-Software/t3code-hyprws#1717.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { logsDir } = yield* ServerConfig.ServerConfig;
    let state = initialState;
    const tick = Effect.gen(function* () {
      const usage = process.memoryUsage();
      const decision = step(state, usage.rss);
      state = decision.next;
      if (decision.report) {
        yield* Effect.logWarning(`server memory reached ${Math.round(usage.rss / MiB)} MiB`, {
          rssMb: Math.round(usage.rss / MiB),
          heapUsedMb: Math.round(usage.heapUsed / MiB),
          heapTotalMb: Math.round(usage.heapTotal / MiB),
          externalMb: Math.round(usage.external / MiB),
          arrayBuffersMb: Math.round(usage.arrayBuffers / MiB),
        });
      }
      if (decision.snapshot) {
        yield* writeHeapSnapshot(logsDir);
      }
    });
    yield* Effect.sleep(SAMPLE_INTERVAL).pipe(
      Effect.andThen(tick),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
