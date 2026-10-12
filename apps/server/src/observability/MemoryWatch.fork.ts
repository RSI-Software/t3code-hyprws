// @effect-diagnostics nodeBuiltinImport:off - the stack watch must run on its own Node thread.
import * as NodeWorkerThreads from "node:worker_threads";

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

// Runs on a worker thread, so it still samples when the main thread is stuck
// in a synchronous loop that starves every timer, log, and signal handler.
// The inspector interrupts running JavaScript, so each pause shows the frames
// that are executing right then.
const STACK_WATCH_SOURCE = `
const { workerData } = process.getBuiltinModule("node:worker_threads");
const inspector = process.getBuiltinModule("node:inspector");
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const { logsDir, thresholdBytes, samples } = workerData;
const stacks = [];
let session;
// The interval also keeps this thread alive; inspector callbacks do not.
const timer = setInterval(() => {
  if (session === undefined) {
    if (process.memoryUsage.rss() < thresholdBytes) return;
    session = new inspector.Session();
    session.connectToMainThread();
    session.on("Debugger.paused", ({ params }) => {
      stacks.push({
        at: new Date().toISOString(),
        rssBytes: process.memoryUsage.rss(),
        frames: params.callFrames.map(
          (frame) =>
            (frame.functionName || "<anonymous>") + " " + frame.url + ":" +
            (frame.location.lineNumber + 1) + ":" + (frame.location.columnNumber + 1),
        ),
      });
      session.post("Debugger.resume");
      if (stacks.length < samples) return;
      clearInterval(timer);
      const name = "server-" + process.pid + "-" + new Date().toISOString().replaceAll(":", "-") + ".stacks.json";
      fs.writeFileSync(path.join(logsDir, name), JSON.stringify(stacks, null, 2), { mode: 0o600 });
      session.disconnect();
    });
    session.post("Debugger.enable");
  }
  session.post("Debugger.pause");
}, 1000);
`;

/**
 * Starts a worker that, once the process passes `thresholdBytes` RSS, pauses
 * the main thread `samples` times a second apart and writes the stacks to
 * `server-<pid>-<time>.stacks.json` in `logsDir`.
 */
export const startStackWatch = (input: {
  readonly logsDir: string;
  readonly thresholdBytes: number;
  readonly samples: number;
}) => {
  const worker = new NodeWorkerThreads.Worker(STACK_WATCH_SOURCE, {
    eval: true,
    workerData: input,
  });
  worker.unref();
  return worker;
};

/**
 * Logs the server's memory breakdown at each new high-water mark, so a leak leaves a durable
 * record of which pool grew. `external` and `arrayBuffers` grow outside the V8 heap limit; a
 * heap snapshot names what retains them. A burst from a blocked event loop never reaches those,
 * so a worker records the main thread's stacks instead.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { logsDir } = yield* ServerConfig.ServerConfig;
    yield* Effect.acquireRelease(
      Effect.sync(() => startStackWatch({ logsDir, thresholdBytes: SNAPSHOT_BYTES, samples: 3 })),
      (worker) => Effect.promise(() => worker.terminate()),
    );
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
