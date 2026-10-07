import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Rounds end before any provider starts"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistence.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  layerWithRegistry(
    { name: "delegated-rounds" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect("a delegated task continues on the same child, one result per round", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const parentThreadId = ThreadId.make("thread:rounds-parent");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-rounds-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:rounds"),
      title: "Rounds parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-rounds-parent"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:rounds-parent"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* projections.getThreadProjection(parentThreadId)).runs[0]!;
    const delegate = (round: string, continueTaskId?: NodeId) =>
      orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make(`delegate-${round}`),
        parentThreadId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: `Brief for ${round}`,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        ...(continueTaskId === undefined ? {} : { continueTaskId }),
        createdBy: "agent",
        creationSource: "mcp",
      });
    const refusal = (round: string, continueTaskId: NodeId) =>
      delegate(round, continueTaskId).pipe(
        Effect.flip,
        Effect.map((error) => String(error.cause)),
      );
    const readParent = projections.getThreadProjection(parentThreadId);
    const resultTransfers = readParent.pipe(
      Effect.map((parent) =>
        parent.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
      ),
    );
    // finalize reacts to the terminal run on the event stream, after the
    // interrupt commits; the stream replays from the given sequence, so the
    // result transfer cannot be missed.
    const endRound = (childThreadId: ThreadId, runId: RunId, round: string) =>
      Effect.gen(function* () {
        const after = yield* eventSink.latestSequence();
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`interrupt-${round}`),
          threadId: childThreadId,
          runId,
        });
        yield* eventSink
          .stream({
            threadId: parentThreadId,
            afterSequence: after,
            eventType: "context-transfer.created",
          })
          .pipe(Stream.take(1), Stream.runDrain);
      });

    yield* delegate("round-1");
    const opened = (yield* readParent).subagents[0]!;
    const childThreadId = opened.childThreadId!;
    const round1Run = (yield* projections.getThreadProjection(childThreadId)).runs[0]!;
    yield* endRound(childThreadId, round1Run.id, "round-1");

    const afterRound1 = yield* readParent;
    const node = afterRound1.nodes.find((candidate) => candidate.id === opened.id);
    const turnItem = afterRound1.turnItems.find(
      (candidate) => candidate.type === "subagent" && candidate.subagentId === opened.id,
    );
    assert.equal(afterRound1.subagents[0]!.status, "interrupted");
    assert.equal((yield* resultTransfers).length, 1);
    // task_status acknowledges the round it reads; the next round still wakes.
    yield* orchestrator.dispatch({
      type: "delegated_task.completion-delivery.acknowledge",
      commandId: CommandId.make("acknowledge-round-1"),
      parentThreadId,
      taskId: opened.id,
      observedByRunId: parentRun.id,
    });

    yield* delegate("round-2", opened.id);
    const reopened = (yield* readParent).subagents[0]!;
    assert.equal(reopened.id, opened.id);
    assert.equal(reopened.status, "running");
    assert.equal(reopened.runId, parentRun.id);
    assert.isNull(reopened.result);
    assert.deepEqual(reopened.completionDelivery, { state: "pending", observedByRunId: null });
    const child = yield* projections.getThreadProjection(childThreadId);
    const round2Run = child.runs.find((run) => run.ordinal === 2)!;
    assert.ok(
      child.messages.some(
        (message) => message.runId === round2Run.id && message.senderThreadId === parentThreadId,
      ),
    );
    assert.include(yield* refusal("round-2-again", opened.id), "still running a round");

    yield* endRound(childThreadId, round2Run.id, "round-2");
    const afterRound2 = yield* readParent;
    const transfers = yield* resultTransfers;
    assert.equal(afterRound2.subagents[0]!.status, "interrupted");
    assert.equal(afterRound2.subagents[0]!.completionDelivery?.state, "claimed");
    assert.deepEqual(
      transfers.map((transfer) => transfer.sourcePoint.runId),
      [round1Run.id, round2Run.id],
    );
    assert.deepEqual(
      afterRound2.nodes.find((candidate) => candidate.id === opened.id),
      node,
    );
    assert.deepEqual(
      afterRound2.turnItems.find(
        (candidate) => candidate.type === "subagent" && candidate.subagentId === opened.id,
      ),
      turnItem,
    );

    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("release-child"),
      threadId: childThreadId,
    });
    assert.include(yield* refusal("round-3-released", opened.id), "was released");
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("retain-child"),
      threadId: childThreadId,
    });
    yield* delegate("round-3", opened.id);
    assert.equal((yield* readParent).subagents[0]!.status, "running");

    assert.include(
      yield* refusal("unknown", NodeId.make("node:unknown")),
      "not an app-owned delegated task",
    );
  }).pipe(Effect.provide(testLayer)),
);
