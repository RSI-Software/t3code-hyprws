// fork-hook: upstream-fixes/interrupt-request-cleanup
// Fork-owned: the client's Stop rides run.interrupt (holdQueue), so that path
// must retire questions stranded by ended runs and runless work, exactly like
// thread.stop does. Lives in a sibling file because upstream test files only
// accept appends.

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
  type RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: runs stay unstarted, so an interrupt ends them without a provider.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      layerWithRegistry(
        { name: "thread-stop-fork" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop-fork"),
      title: "Interrupt stranded questions",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

/** Seeds a pending approval question stranded by `runId` (or runless). */
const seedStrandedApproval = (input: {
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly nodeId: NodeId;
  readonly itemId: TurnItemId;
  readonly runId: RunId | null;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const driver = ProviderDriverKind.make("codex");
    const base = {
      threadId: input.threadId,
      driver,
      occurredAt: input.now,
    };
    const node = {
      id: input.nodeId,
      threadId: input.threadId,
      runId: input.runId,
      parentNodeId: null,
      rootNodeId: input.nodeId,
      kind: "approval_request" as const,
      status: "waiting" as const,
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: input.requestId,
      checkpointScopeId: null,
      startedAt: input.now,
      completedAt: null,
    };
    const request = {
      id: input.requestId,
      nodeId: input.nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command" as const,
      status: "pending" as const,
      responseCapability: {
        type: "live" as const,
        providerSessionId: ProviderSessionId.make("session:thread-stop-fork-stranded"),
      },
      createdAt: input.now,
      resolvedAt: null,
    };
    const item = {
      id: input.itemId,
      threadId: input.threadId,
      runId: input.runId,
      nodeId: input.nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "waiting" as const,
      title: null,
      startedAt: input.now,
      completedAt: null,
      updatedAt: input.now,
      type: "approval_request" as const,
      requestId: input.requestId,
      requestKind: "command" as const,
    };
    yield* input.projections.apply({
      ...base,
      id: EventId.make(`${input.nodeId}:node`),
      type: "node.updated",
      nodeId: input.nodeId,
      payload: node,
    });
    yield* input.projections.apply({
      ...base,
      id: EventId.make(`${input.nodeId}:request`),
      type: "runtime-request.updated",
      nodeId: input.nodeId,
      payload: request,
    });
    yield* input.projections.apply({
      ...base,
      id: EventId.make(`${input.nodeId}:item`),
      type: "turn-item.updated",
      nodeId: input.nodeId,
      payload: item,
    });
  });

it.effect(
  "run.interrupt retires stranded failed-run and runless questions alongside the target",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:interrupt-stranded-questions-fork");
      yield* createThread(threadId);
      yield* send(threadId, "first");
      const now = yield* DateTime.now;
      // The first run failed, leaving its approval question stranded.
      const firstRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* projections.apply({
        id: EventId.make("event:interrupt-stranded:first-run-failed"),
        type: "run.updated",
        threadId,
        runId: firstRun.id,
        occurredAt: now,
        payload: { ...firstRun, status: "failed", completedAt: now },
      });
      yield* seedStrandedApproval({
        projections,
        threadId,
        requestId: RuntimeRequestId.make("request:stranded-failed-run"),
        nodeId: NodeId.make("node:stranded-failed-run"),
        itemId: TurnItemId.make("item:stranded-failed-run"),
        runId: firstRun.id,
        now,
      });
      yield* seedStrandedApproval({
        projections,
        threadId,
        requestId: RuntimeRequestId.make("request:stranded-runless"),
        nodeId: NodeId.make("node:stranded-runless"),
        itemId: TurnItemId.make("item:stranded-runless"),
        runId: null,
        now,
      });
      yield* send(threadId, "second");
      const targetRun = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;

      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("interrupt-stranded-fork"),
        threadId,
        runId: targetRun.id,
        holdQueue: true,
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["failed", "interrupted"],
      );
      const cancelled = projection.runtimeRequests.filter(
        (request) => request.status === "cancelled",
      );
      assert.deepEqual(
        cancelled.map((request) => request.id).sort(),
        [
          RuntimeRequestId.make("request:stranded-failed-run"),
          RuntimeRequestId.make("request:stranded-runless"),
        ].sort(),
      );
      for (const request of cancelled) {
        assert.equal(request.responseCapability.type, "not_resumable");
      }
      const cancelledNodes = projection.nodes.filter((node) =>
        cancelled.some((request) => request.nodeId === node.id),
      );
      assert.deepEqual(cancelledNodes.map((node) => node.status).sort(), [
        "cancelled",
        "cancelled",
      ]);
      const cancelledItems = projection.turnItems.filter(
        (item) =>
          item.type === "approval_request" &&
          cancelled.some((request) => request.id === item.requestId),
      );
      assert.deepEqual(cancelledItems.map((item) => item.status).sort(), [
        "cancelled",
        "cancelled",
      ]);
    }).pipe(Effect.provide(layerTest)),
);
