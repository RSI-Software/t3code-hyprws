// fork-hook: upstream-fixes/release-detach-fault-tests
// Fork-owned harness: mirrors the upstream ProviderSessionManager.test.ts
// composition with fault-injection knobs (flaky release writes, flaky
// thread-record reads) so deliberate teardown is tested against transient
// SQL faults. Lives in a sibling file because upstream test files only
// accept appends.

import * as NetAddress from "effect/net/NetAddress";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import type {
  ProviderAdapterV2,
  ProviderAdapterV2Event,
  ProviderAdapterV2RuntimePolicy,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpServer } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(layerTestDatabase),
);
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);

interface FlakyReleaseWrites {
  /** Which release writes fail right now. */
  readonly failing: Ref.Ref<"none" | "session" | "session-and-requests">;
  /** Receives one item per failed write. */
  readonly failures: Queue.Queue<void>;
}

// Fails release writes with a defect, the way a failed SQL commit surfaces.
const layerFlakyReleaseEventSink = (flaky: FlakyReleaseWrites) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) =>
          Effect.gen(function* () {
            const failing = yield* Ref.get(flaky.failing);
            const fails = input.events.some(
              (event) =>
                (failing !== "none" &&
                  event.type === "provider-session.updated" &&
                  (event.payload.status === "stopped" || event.payload.status === "error")) ||
                (failing === "session-and-requests" && event.type === "runtime-request.updated"),
            );
            if (!fails) return yield* delegate.write(input);
            yield* Queue.offer(flaky.failures, undefined);
            return yield* Effect.die(new Error("simulated commit failure"));
          }),
      });
    }),
  ).pipe(Layer.provide(layerTestEventSink));

interface FlakyProjectionReads {
  /** When armed, the next thread-record lookup fails like a transient SQL read. */
  readonly armed: Ref.Ref<boolean>;
  readonly failures: Queue.Queue<void>;
}

// Fails thread-record lookups with a typed read error, one fault per arm.
const layerFlakyProjectionReads = (flaky: FlakyProjectionReads) =>
  Layer.effect(
    ProjectionStore.ProjectionStoreV2,
    Effect.gen(function* () {
      const delegate = yield* ProjectionStore.ProjectionStoreV2;
      const getThreadRecords: ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"] = (
        threadId,
        fields,
        filter,
      ) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(flaky.armed, false)) {
            yield* Queue.offer(flaky.failures, undefined);
            return yield* Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }));
          }
          return yield* delegate.getThreadRecords(threadId, fields, filter);
        });
      return ProjectionStore.ProjectionStoreV2.of({ ...delegate, getThreadRecords });
    }),
  ).pipe(Layer.provide(layerTestStores));

const instanceId = ProviderInstanceId.make("codex");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const modelSelection: ModelSelection = { instanceId, model: "gpt-5.4" };
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapterV2RuntimePolicy;

interface TestProviderRuntimeState {
  readonly closeCount: number;
  readonly unloadedNativeThreadIds: ReadonlyArray<string>;
  readonly interruptedTurnIds: ReadonlyArray<string>;
}

const layerTestMcpRegistry = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-p-sm-fork")),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const layerTest = (input: {
  readonly state: Ref.Ref<TestProviderRuntimeState>;
  readonly idleTimeoutMs: number;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly flakyReleaseWrites?: FlakyReleaseWrites;
  readonly flakyProjectionReads?: FlakyProjectionReads;
  /** Succeeded once the adapter's unloadThread runs; awaits deferred teardown. */
  readonly teardownDone?: Deferred.Deferred<void>;
}) => {
  const capabilities = input.capabilities ?? CodexProviderCapabilitiesV2;
  const adapter = {
    instanceId,
    driver: CODEX_DRIVER,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
        // The provider process dies with the session scope.
        yield* Effect.addFinalizer(() =>
          Ref.update(input.state, (current) => ({
            ...current,
            closeCount: current.closeCount + 1,
          })),
        );
        return {
          instanceId,
          driver: CODEX_DRIVER,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver: CODEX_DRIVER,
            providerInstanceId: instanceId,
            status: "ready" as const,
            cwd: process.cwd(),
            model: modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: () => Effect.die("unused"),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: () => Effect.die("unused"),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerTurnId }) =>
            Effect.gen(function* () {
              yield* Ref.update(input.state, (current) => ({
                ...current,
                interruptedTurnIds: [...current.interruptedTurnIds, providerTurnId],
              }));
            }),
          unloadThread: ({ providerThread }) =>
            Effect.gen(function* () {
              yield* Ref.update(input.state, (current) => ({
                ...current,
                unloadedNativeThreadIds: [
                  ...current.unloadedNativeThreadIds,
                  providerThread.nativeThreadRef?.nativeId ?? "",
                ],
              }));
              if (input.teardownDone !== undefined) {
                yield* Deferred.succeed(input.teardownDone, undefined);
              }
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        } as ProviderAdapterV2SessionRuntime;
      }),
  } satisfies ProviderAdapterV2["Service"];
  const layerConfiguredEventSink =
    input.flakyReleaseWrites === undefined
      ? layerTestEventSink
      : layerFlakyReleaseEventSink(input.flakyReleaseWrites);
  // The decorated store is merged last so only the manager's lookups fault.
  const layerConfiguredStores =
    input.flakyProjectionReads === undefined
      ? layerTestStores
      : Layer.merge(layerTestStores, layerFlakyProjectionReads(input.flakyProjectionReads));
  const layerProviderEventIngestorTest = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerConfiguredEventSink,
        IdAllocator.layer,
        layerTestStores,
        ThreadCommandExecutor.layer,
      ),
    ),
  );
  return Layer.mergeAll(
    layerTestStores,
    layerConfiguredEventSink,
    IdAllocator.layer,
    layerTestMcpRegistry,
    McpProviderSessions.layer,
    ProviderSessionManager.layerWithOptions({ idleTimeoutMs: input.idleTimeoutMs }).pipe(
      Layer.provide(
        Layer.mergeAll(
          ProviderAdapterRegistry.layerFromAdapters([adapter]).pipe(
            Layer.provideMerge(McpProviderSessions.layer),
          ),
          layerConfiguredEventSink,
          IdAllocator.layer,
          layerProviderEventIngestorTest,
          layerTestMcpRegistry,
          layerConfiguredStores,
          ServerSettings.layerTest(),
        ),
      ),
    ),
  ).pipe(Layer.provide(NodeServices.layer));
};

function makeThreadCreatedEvent(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
}) {
  return Effect.gen(function* () {
    const projectId = yield* input.idAllocator.allocate.project({
      fixtureName: "provider-session-manager-fork",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId,
      title: "Provider session manager fork",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      id: yield* input.idAllocator.allocate.event({ threadId: input.threadId }),
      type: "thread.created" as const,
      threadId: input.threadId,
      occurredAt: input.now,
      payload: thread,
    };
  });
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly nativeThreadId?: string;
}): OrchestrationV2ProviderThread {
  const nativeThreadId = input.nativeThreadId ?? "native-thread";
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId,
    }),
    driver: CODEX_DRIVER,
    providerInstanceId: instanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CODEX_DRIVER,
      nativeId: nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function makePendingRuntimeRequestEvents(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}) {
  return Effect.gen(function* () {
    const requestId = yield* input.idAllocator.allocate.runtimeRequest({
      driver: CODEX_DRIVER,
      nativeRequestId: "pending-approval",
    });
    const nodeId = input.idAllocator.derive.approvalNode({ requestId });
    const node = {
      id: nodeId,
      threadId: input.threadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "approval_request" as const,
      status: "waiting" as const,
      countsForRun: false,
      providerThreadId: input.providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: input.now,
      completedAt: null,
    };
    const request = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: {
        driver: CODEX_DRIVER,
        nativeId: "pending-approval",
        strength: "strong" as const,
      },
      kind: "command" as const,
      status: "pending" as const,
      responseCapability: {
        type: "live" as const,
        providerSessionId: input.providerSessionId,
      },
      createdAt: input.now,
      resolvedAt: null,
    };
    const events = [
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "node.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: node,
      },
      {
        id: yield* input.idAllocator.allocate.event({
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        }),
        type: "runtime-request.updated" as const,
        threadId: input.threadId,
        nodeId,
        driver: CODEX_DRIVER,
        occurredAt: input.now,
        payload: request,
      },
    ] satisfies ReadonlyArray<OrchestrationV2DomainEvent>;
    return { events, requestId, nodeId };
  });
}

it.effect("ProviderSessionManagerV2 release tears down despite a failed interrupts lookup", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make<TestProviderRuntimeState>({
      closeCount: 0,
      unloadedNativeThreadIds: [],
      interruptedTurnIds: [],
    });
    const flaky: FlakyProjectionReads = {
      armed: yield* Ref.make(false),
      failures: yield* Queue.unbounded<void>(),
    };
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-p-sm-fork-release-interrupts-fault");
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: instanceId,
        threadId,
      });
      const providerThread = makeProviderThread({ idAllocator, threadId, providerSessionId, now });
      yield* eventSink.write({
        events: [yield* makeThreadCreatedEvent({ idAllocator, threadId, now })],
      });
      const pendingRequest = yield* makePendingRuntimeRequestEvents({
        idAllocator,
        threadId,
        providerSessionId,
        providerThread,
        now,
      });
      yield* eventSink.write({ events: pendingRequest.events });
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

      // A deliberate release must tear down even when the interrupted-turn
      // lookup fails: subscribers, scope close, and release records all run.
      yield* Ref.set(flaky.armed, true);
      yield* manager.release({ providerSessionId, reason: "manual_shutdown" });
      yield* Queue.take(flaky.failures);

      const after = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(after.providerSessions.at(-1)?.status, "stopped");
      const request = after.runtimeRequests.at(-1);
      assert.equal(request?.status, "cancelled");
      assert.equal(request?.responseCapability.type, "not_resumable");
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
    });
    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyProjectionReads: flaky })),
    );
  }),
);

it.effect(
  "ProviderSessionManagerV2 detach retries a failed request cleanup and keeps the shared session live",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<TestProviderRuntimeState>({
        closeCount: 0,
        unloadedNativeThreadIds: [],
        interruptedTurnIds: [],
      });
      const flaky: FlakyReleaseWrites = {
        failing: yield* Ref.make<"none" | "session" | "session-and-requests">("none"),
        failures: yield* Queue.unbounded<void>(),
      };
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadA = ThreadId.make("thread-p-sm-fork-detach-cleanup-retry-a");
        const threadB = ThreadId.make("thread-p-sm-fork-detach-cleanup-retry-b");
        const providerSessionId = yield* idAllocator.allocate.providerSession({
          providerInstanceId: instanceId,
          threadId: threadA,
        });
        const providerThreadA = makeProviderThread({
          idAllocator,
          threadId: threadA,
          providerSessionId,
          now,
        });
        const providerThreadB = makeProviderThread({
          idAllocator,
          threadId: threadB,
          providerSessionId,
          now,
          nativeThreadId: "native-thread-b",
        });
        const stranded = yield* makePendingRuntimeRequestEvents({
          idAllocator,
          threadId: threadA,
          providerSessionId,
          providerThread: providerThreadA,
          now,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadA, now }),
            yield* makeThreadCreatedEvent({ idAllocator, threadId: threadB, now }),
            {
              id: yield* idAllocator.allocate.event({ threadId: threadA, providerSessionId }),
              type: "provider-thread.updated" as const,
              threadId: threadA,
              occurredAt: now,
              payload: providerThreadA,
            },
            ...stranded.events,
          ],
        });
        yield* manager.open({
          threadId: threadA,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: threadB,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });

        // The cleanup write fails, but the detach still succeeds, unloads the
        // thread's native state, and leaves the shared session live.
        yield* Ref.set(flaky.failing, "session-and-requests");
        yield* manager.detach({ providerSessionId, threadId: threadA });
        yield* Queue.take(flaky.failures);
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["native-thread"]);
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));

        // Work that starts after the cutoff is not touched by the retry.
        yield* Ref.set(flaky.failing, "none");
        const replacement = yield* makePendingRuntimeRequestEvents({
          idAllocator,
          threadId: threadB,
          providerSessionId,
          providerThread: providerThreadB,
          now: DateTime.add(now, { seconds: 5 }),
        });
        yield* eventSink.write({ events: replacement.events });
        const cleaned = yield* eventSink
          .stream({
            threadId: threadA,
            afterSequence: yield* eventSink.latestSequence({ threadId: threadA }),
            eventType: "runtime-request.updated",
          })
          .pipe(Stream.runHead, Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(cleaned);

        const settled = yield* projectionStore.getThreadProjection(threadA);
        assert.equal(settled.runtimeRequests.at(-1)?.status, "cancelled");
        const kept = yield* projectionStore.getThreadProjection(threadB);
        assert.notEqual(kept.providerSessions.at(-1)?.status, "stopped");
        assert.equal(kept.runtimeRequests.at(-1)?.status, "pending");
      });
      yield* effect.pipe(
        Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyReleaseWrites: flaky })),
      );
    }),
);

// Seeds a shared session whose detached thread owns a running native turn.
const seedSharedTurn = (input: {
  readonly eventSink: EventSink.EventSinkV2["Service"];
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly manager: ProviderSessionManager.ProviderSessionManagerV2["Service"];
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const providerSessionId = yield* input.idAllocator.allocate.providerSession({
      providerInstanceId: instanceId,
      threadId: input.threadId,
    });
    const providerThread = makeProviderThread({
      idAllocator: input.idAllocator,
      threadId: input.threadId,
      providerSessionId,
      now: input.now,
    });
    const turnId = ProviderTurnId.make(`provider-turn:${input.threadId}`);
    yield* input.eventSink.write({
      events: [
        yield* makeThreadCreatedEvent({
          idAllocator: input.idAllocator,
          threadId: input.threadId,
          now: input.now,
        }),
        {
          id: yield* input.idAllocator.allocate.event({
            threadId: input.threadId,
            providerSessionId,
          }),
          type: "provider-thread.updated" as const,
          threadId: input.threadId,
          occurredAt: input.now,
          payload: providerThread,
        },
        {
          id: yield* input.idAllocator.allocate.event({
            threadId: input.threadId,
            providerSessionId,
          }),
          type: "provider-turn.updated" as const,
          threadId: input.threadId,
          occurredAt: input.now,
          payload: {
            id: turnId,
            providerThreadId: providerThread.id,
            nodeId: NodeId.make(`node:${input.threadId}`),
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running" as const,
            startedAt: input.now,
            completedAt: null,
          },
        },
      ],
    });
    yield* input.manager.open({
      threadId: input.threadId,
      providerSessionId,
      modelSelection,
      runtimePolicy,
    });
    return { providerSessionId, turnId } as const;
  });

// fork-hook: upstream-fixes/detach-teardown-retry
// A typed thread-record failure removes the attachment without reading the
// thread's native work: the retry must survive its own read failing once and
// then still interrupt the turn and unload.
it.effect(
  "ProviderSessionManagerV2 detach retries native teardown across typed read failures",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<TestProviderRuntimeState>({
        closeCount: 0,
        unloadedNativeThreadIds: [],
        interruptedTurnIds: [],
      });
      const flaky: FlakyProjectionReads = {
        armed: yield* Ref.make(false),
        failures: yield* Queue.unbounded<void>(),
      };
      const teardownDone = yield* Deferred.make<void>();
      const effect = Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread-p-sm-fork-teardown-retry");
        const { providerSessionId, turnId } = yield* seedSharedTurn({
          eventSink,
          idAllocator,
          manager,
          threadId,
          now,
        });

        // The detach's inline lookup fails, so the interrupt and unload defer
        // to the attachment-locked retry instead of stranding native work.
        yield* Ref.set(flaky.armed, true);
        yield* manager.detach({ providerSessionId, threadId });
        yield* Queue.take(flaky.failures);
        assert.deepEqual((yield* Ref.get(state)).interruptedTurnIds, []);

        // The retry's own read fails once; the shared schedule retries it.
        yield* Ref.set(flaky.armed, true);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(flaky.failures);
        assert.deepEqual((yield* Ref.get(state)).interruptedTurnIds, []);

        yield* TestClock.adjust("2 seconds");
        yield* Deferred.await(teardownDone);
        const after = yield* Ref.get(state);
        assert.deepEqual(after.interruptedTurnIds, [turnId]);
        assert.deepEqual(after.unloadedNativeThreadIds, ["native-thread"]);
        // The shared session itself stays live for other threads.
        assert.isTrue(Option.isSome(yield* manager.get(providerSessionId)));
      });
      yield* effect.pipe(
        Effect.provide(
          layerTest({ state, idleTimeoutMs: 60_000, flakyProjectionReads: flaky, teardownDone }),
        ),
      );
    }),
);

// A same-thread replacement that re-attaches before the retry owns the turn:
// the attachment-locked guard must leave its native work completely alone.
it.effect("ProviderSessionManagerV2 deferred teardown skips a same-thread replacement", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make<TestProviderRuntimeState>({
      closeCount: 0,
      unloadedNativeThreadIds: [],
      interruptedTurnIds: [],
    });
    const flaky: FlakyProjectionReads = {
      armed: yield* Ref.make(false),
      failures: yield* Queue.unbounded<void>(),
    };
    const effect = Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread-p-sm-fork-teardown-replacement");
      const { providerSessionId } = yield* seedSharedTurn({
        eventSink,
        idAllocator,
        manager,
        threadId,
        now,
      });

      yield* Ref.set(flaky.armed, true);
      yield* manager.detach({ providerSessionId, threadId });
      yield* Queue.take(flaky.failures);
      // The thread's next turn attaches first: it owns the native work now.
      yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });

      yield* TestClock.adjust("2 seconds");
      const after = yield* Ref.get(state);
      assert.deepEqual(after.interruptedTurnIds, []);
      assert.deepEqual(after.unloadedNativeThreadIds, []);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.providerTurns.at(-1)?.status, "running");
    });
    yield* effect.pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, flakyProjectionReads: flaky })),
    );
  }),
);
