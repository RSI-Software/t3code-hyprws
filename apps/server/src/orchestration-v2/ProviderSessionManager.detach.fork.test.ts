import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  type RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import type {
  ProviderAdapterV2,
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const sessionId = ProviderSessionId.make("session:detach");
const modelSelection = { instanceId, model: "gpt-5.4" };
const makeLayer = (shared: boolean) => {
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    sessions: {
      ...CodexProviderCapabilitiesV2.sessions,
      supportsMultipleProviderThreadsPerSession: shared,
    },
  };
  const adapter = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
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
          interruptTurn: () => Effect.void,
          unloadThread: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        } as ProviderAdapterV2SessionRuntime;
      }),
  } satisfies ProviderAdapterV2["Service"];
  const database = SqlitePersistence.layerMemory;
  return Layer.mergeAll(
    ProjectionStore.layer.pipe(Layer.provide(database)),
    layerWithRegistry(
      { name: `detach-${shared}` },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  );
};

const createThread = (threadId: ThreadId, openSession = true) =>
  Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:detach"),
      title: "Detach",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    if (openSession)
      yield* (yield* ProviderSessionManager.ProviderSessionManagerV2).open({
        threadId,
        providerSessionId: sessionId,
        modelSelection,
        runtimePolicy: {
          cwd: process.cwd(),
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      });
  });

const request = (
  threadId: ThreadId,
  name: string,
  capability: OrchestrationV2RuntimeRequest["responseCapability"],
  runId: RunId | null = null,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const id = RuntimeRequestId.make(name);
    const nodeId = NodeId.make(`node:${name}`);
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make(`node:${name}`),
          type: "node.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: id,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(name),
          type: "runtime-request.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: capability,
            createdAt: now,
            resolvedAt: null,
          },
        },
        {
          id: EventId.make(`item:${name}`),
          type: "turn-item.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${name}`),
            threadId,
            nodeId,
            runId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId: id,
            questions: [],
          },
        },
      ],
    });
    return id;
  });

const tool = (threadId: ThreadId, name: string, ownerSession = sessionId) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make(`provider:${name}`);
    const id = TurnItemId.make(`tool:${name}`);
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make(`provider:${name}`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: ownerSession,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`tool:${name}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id,
            threadId,
            nodeId: null,
            runId: null,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "running",
            title: "Handoff",
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "dynamic_tool",
            toolName: "t3_worktree_handoff",
            input: {},
            output: null,
          },
        },
      ],
    });
    return id;
  });

it.effect.each([false, true])(
  "detach cancels only this thread's live questions (shared=%s)",
  (shared) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:detach");
      const otherId = ThreadId.make("thread:other");
      yield* createThread(threadId);
      if (shared) yield* createThread(otherId);
      const live = yield* request(threadId, "live", { type: "live", providerSessionId: sessionId });
      const message = yield* request(threadId, "async", { type: "message" });
      const replacement = yield* request(threadId, "replacement", {
        type: "live",
        providerSessionId: ProviderSessionId.make("new"),
      });
      const handoff = yield* tool(threadId, "handoff");
      const replacementTool = yield* tool(threadId, "replacement", ProviderSessionId.make("new"));
      if (shared) yield* request(otherId, "other", { type: "live", providerSessionId: sessionId });
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      yield* manager.detach({ threadId, providerSessionId: sessionId });
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const result = yield* projections.getThreadProjection(threadId);
      assert.equal(result.turnItems.find((i) => i.id === handoff)?.status, "interrupted");
      assert.equal(result.turnItems.find((i) => i.id === replacementTool)?.status, "running");
      assert.equal(result.runtimeRequests.find((r) => r.id === live)?.status, "cancelled");
      assert.equal(result.nodes.find((n) => n.runtimeRequestId === live)?.status, "cancelled");
      assert.equal(
        result.runtimeRequests.find((r) => r.id === live)?.responseCapability.type,
        "not_resumable",
      );
      assert.equal(
        result.turnItems.find(
          (item) => item.type === "user_input_request" && item.requestId === live,
        )?.status,
        "cancelled",
      );
      for (const id of [message, replacement])
        assert.equal(result.runtimeRequests.find((r) => r.id === id)?.status, "pending");
      if (shared) {
        assert.equal(
          (yield* projections.getThreadProjection(otherId)).runtimeRequests[0]?.status,
          "pending",
        );
      }
    }).pipe(Effect.provide(makeLayer(shared))),
);

const send = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "Work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("Stop retires a question left by an already failed run", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:failed-question");
    yield* createThread(threadId, false);
    yield* send(threadId);
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const before = yield* orchestrator.getThreadProjection(threadId);
    const run = before.runs[0]!;
    const now = yield* DateTime.now;
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make("failed-run"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "failed", completedAt: now },
        },
      ],
    });
    const stranded = yield* request(
      threadId,
      "stranded",
      { type: "live", providerSessionId: sessionId },
      run.id,
    );
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop-stranded"),
      threadId,
    });
    const result = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(result.runtimeRequests.find((r) => r.id === stranded)?.status, "cancelled");
    assert.equal(result.nodes.find((n) => n.runtimeRequestId === stranded)?.status, "cancelled");
    assert.equal(
      result.turnItems.find((i) => i.type === "user_input_request" && i.requestId === stranded)
        ?.status,
      "cancelled",
    );
    assert.equal(result.runs[0]?.status, "failed");
  }).pipe(Effect.provide(makeLayer(false))),
);

it.effect.each(["manual_shutdown", "runtime_error"] as const)(
  "release reports deliberate interruption before stream closure (%s)",
  (reason) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(`thread:release-${reason}`);
      yield* createThread(threadId);
      yield* send(threadId);
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const runtime = yield* manager.open({
        threadId,
        providerSessionId: sessionId,
        modelSelection,
        runtimePolicy: {
          cwd: process.cwd(),
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      });
      const subscribe = runtime.subscribeEvents;
      assert.isDefined(subscribe);
      if (subscribe === undefined) return;
      const subscription = yield* subscribe;
      const run = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId))
        .runs[0]!;
      const now = yield* DateTime.now;
      const providerThreadId = ProviderThreadId.make("provider:release");
      const providerTurnId = ProviderTurnId.make("turn:release");
      const runAttemptId = RunAttemptId.make("attempt:release");
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("running"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...run, status: "running", activeAttemptId: runAttemptId },
          },
          {
            id: EventId.make("provider"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: sessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "active",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("turn"),
            type: "provider-turn.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerTurnId,
              providerThreadId,
              nodeId: run.rootNodeId!,
              runAttemptId,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        ],
      });
      const pendingTool = yield* tool(threadId, "release-tool");
      yield* manager.release({ providerSessionId: sessionId, reason });
      const afterRelease = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
        threadId,
      );
      assert.equal(
        afterRelease.turnItems.find((item) => item.id === pendingTool)?.status,
        reason === "runtime_error" ? "failed" : "interrupted",
      );
      const received = yield* Effect.exit(subscription.events.pipe(Stream.runHead));
      if (reason === "runtime_error") {
        assert.isTrue(Exit.isFailure(received));
      } else {
        assert.isTrue(Exit.isSuccess(received));
        if (Exit.isFailure(received) || Option.isNone(received.value)) return;
        assert.deepEqual(received.value.value, {
          type: "turn.terminal",
          driver,
          providerThreadId,
          providerTurnId,
          runOrdinal: run.ordinal,
          status: "interrupted",
          failure: null,
          threadDisposition: "reusable",
        });
      }
    }).pipe(Effect.provide(makeLayer(false))),
);
