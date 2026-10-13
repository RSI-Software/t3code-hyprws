import { expect, it } from "@effect/vitest";
import {
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

// Fork: a thread waiting on a pending runtime request must return from
// waitForThread with pendingRequestCount instead of blocking until the run
// turns terminal, while settlement keeps waiting for the run itself
// (RSI-Software/t3code-hyprws#1640).

const projectId = ProjectId.make("project:thread-wait-request");
const threadId = ThreadId.make("thread:thread-wait-request");
const runId = RunId.make("run:thread-wait-request");

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const projection = (
  status: OrchestrationV2Run["status"],
  runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest> = [],
) =>
  ({
    thread: { id: threadId, projectId, deletedAt: null },
    runs: [{ id: runId, ordinal: 1, status }],
    runtimeRequests,
  }) as unknown as OrchestrationV2ThreadProjection;

const request = (status: OrchestrationV2RuntimeRequest["status"]) =>
  ({
    id: "request:thread-wait-request:1",
    status,
  }) as OrchestrationV2RuntimeRequest;

const stored = (sequence: number, event: object) =>
  ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;

const layerTest = (options: {
  readonly getThreadRecords: Effect.Effect<OrchestrationV2ThreadProjection>;
  readonly events?: Partial<
    Record<"run.updated" | "runtime-request.updated", Queue.Queue<OrchestrationV2StoredEvent>>
  >;
  readonly subscribed: Deferred.Deferred<void>;
  readonly dispatched?: Array<string>;
}) =>
  ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadEventSequence: () => Effect.succeed(0),
        restartContinuationPending: () => Effect.succeed(false),
        // Each stream keeps one event type; a type without a queue never fires.
        streamStoredEventsFrom: (input) => {
          const eventType = input?.eventType;
          const queue =
            eventType === "run.updated" || eventType === "runtime-request.updated"
              ? options.events?.[eventType]
              : undefined;
          if (queue === undefined) return Stream.never;
          return Stream.fromEffect(Deferred.succeed(options.subscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromQueue(queue)),
          );
        },
        getThreadRecords: () => options.getThreadRecords,
        dispatch: (command) =>
          Effect.sync(() => {
            options.dispatched?.push(command.type);
            return { sequence: 1, storedEvents: [] } as never;
          }),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );

it.effect("returns a still-active run immediately while a request already pends", () =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    let subscriptions = 0;
    const records = Effect.sync(() => {
      subscriptions += 1;
      return projection("running", [request("pending")]);
    });
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(
        layerTest({
          getThreadRecords: records,
          events: {
            "runtime-request.updated": yield* Queue.unbounded<OrchestrationV2StoredEvent>(),
          },
          subscribed,
        }),
      ),
    );

    const result = yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60_000 });

    expect(result).toMatchObject({
      timedOut: false,
      pendingRequestCount: 1,
      run: { id: runId, status: "running" },
    });
    // The pending request was visible before subscribing, so no stream ran.
    expect(subscriptions).toBe(1);
  }),
);

it.effect("wakes on a runtime-request event alone and returns the pending count", () =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let requests: ReadonlyArray<OrchestrationV2RuntimeRequest> = [];
    let reads = 0;
    const records = Effect.sync(() => {
      reads += 1;
      return projection("running", requests);
    });
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(
        layerTest({
          getThreadRecords: records,
          events: { "runtime-request.updated": events },
          subscribed,
        }),
      ),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);

    requests = [request("pending")];
    yield* Queue.offer(
      events,
      stored(1, { type: "runtime-request.updated", payload: { id: "request:1" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      pendingRequestCount: 1,
      run: { id: runId, status: "running" },
    });
    // The initial read plus one for the request event; no run update arrived.
    expect(reads).toBe(2);
  }),
);

it.effect("keeps waiting when the request resolves without ending the run", () =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let requests: ReadonlyArray<OrchestrationV2RuntimeRequest> = [];
    let reads = 0;
    const woke = yield* Deferred.make<void>();
    const records = Effect.gen(function* () {
      reads += 1;
      if (reads === 2) yield* Deferred.succeed(woke, undefined);
      return projection("running", requests);
    });
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(
        layerTest({
          getThreadRecords: records,
          events: { "runtime-request.updated": events },
          subscribed,
        }),
      ),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 1 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);

    // The wake re-read sees the request resolved, so the wait continues until
    // the timeout; the final read decides the count.
    requests = [request("resolved")];
    yield* Queue.offer(
      events,
      stored(1, { type: "runtime-request.updated", payload: { id: "request:1" } }),
    );
    yield* Deferred.await(woke);
    yield* TestClock.adjust(Duration.millis(1));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: true,
      pendingRequestCount: 0,
      run: { id: runId, status: "running" },
    });
  }),
);

it.effect("a timeout that lands on a pending request still returns as needed input", () =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let requests: ReadonlyArray<OrchestrationV2RuntimeRequest> = [];
    const records = Effect.sync(() => projection("running", requests));
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(
        layerTest({
          getThreadRecords: records,
          events: { "runtime-request.updated": events },
          subscribed,
        }),
      ),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 1 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);

    // The request lands while the timeout is winning the race and no stream
    // wake runs; the final read still reports needed input, not a timeout.
    requests = [request("pending")];
    yield* TestClock.adjust(Duration.millis(1));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      pendingRequestCount: 1,
      run: { id: runId, status: "running" },
    });
  }),
);

it.effect("a terminal run still returns first, with the pending count beside it", () =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    let subscriptions = 0;
    const records = Effect.sync(() => {
      subscriptions += 1;
      return projection("completed", [request("pending")]);
    });
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(
        layerTest({
          getThreadRecords: records,
          events: {
            "runtime-request.updated": yield* Queue.unbounded<OrchestrationV2StoredEvent>(),
          },
          subscribed,
        }),
      ),
    );

    const result = yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60_000 });

    expect(result).toMatchObject({
      timedOut: false,
      pendingRequestCount: 1,
      run: { id: runId, status: "completed" },
    });
  }),
);

it.effect("settlement waits out a pending request and settles when the run completes", () =>
  Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    const requests = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const runs = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let status: OrchestrationV2Run["status"] = "running";
    let threadRequests: ReadonlyArray<OrchestrationV2RuntimeRequest> = [request("pending")];
    let reads = 0;
    const woke = yield* Deferred.make<void>();
    const records = Effect.gen(function* () {
      reads += 1;
      if (reads === 2) yield* Deferred.succeed(woke, undefined);
      return projection(status, threadRequests);
    });
    const dispatched: Array<string> = [];
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(
        layerTest({
          getThreadRecords: records,
          events: { "runtime-request.updated": requests, "run.updated": runs },
          subscribed,
          dispatched,
        }),
      ),
    );
    const fiber = yield* service
      .settleAfterRun({ projectId, threadId, runId })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);

    // A request already pends at start; settlement must not return for it.
    expect(dispatched).toEqual([]);
    threadRequests = [];
    yield* Queue.offer(
      requests,
      stored(1, { type: "runtime-request.updated", payload: { id: "request:1" } }),
    );
    yield* Deferred.await(woke);
    status = "completed";
    yield* Queue.offer(runs, stored(2, { type: "run.updated", payload: { id: runId } }));
    yield* Fiber.join(fiber);

    expect(dispatched).toEqual(["thread.settle"]);
  }),
);
