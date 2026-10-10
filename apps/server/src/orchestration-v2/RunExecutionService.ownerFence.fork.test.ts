import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
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
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(database),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  IdAllocator.layer,
);
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const sessionId = ProviderSessionId.make("session:owner-fence");
const modelSelection = { instanceId, model: "gpt-5.4" };
const now = DateTime.makeUnsafe("2026-10-07T00:00:00Z");
const lagAt = DateTime.add(now, { seconds: 1 });
const resumeAt = DateTime.add(now, { seconds: 2 });
const parent = ThreadId.make("thread:owner-fence:parent");
const child = ThreadId.make("thread:owner-fence:child");
const parentProvider = ProviderThreadId.make("provider-thread:owner-fence:parent");
const childProvider = ProviderThreadId.make("provider-thread:owner-fence:child");
const taskId = NodeId.make("node:owner-fence:subagent");
const nestedTaskId = NodeId.make("node:owner-fence:nested-subagent");
const childRootId = NodeId.make("node:owner-fence:child-root");
const childCommandId = TurnItemId.make("item:owner-fence:child-command");
const siblingId = TurnItemId.make("item:owner-fence:sibling-command");

function thread(id: ThreadId): OrchestrationV2AppThread {
  return {
    id,
    projectId: ProjectId.make("project:owner-fence"),
    title: "Ownership fence",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: id === parent ? parentProvider : childProvider,
    lineage: {
      parentThreadId: id === parent ? null : parent,
      relationshipToParent: id === parent ? null : "subagent",
      rootThreadId: parent,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function run(ordinal: number): OrchestrationV2Run {
  return {
    id: RunId.make(`run:owner-fence:${ordinal}`),
    threadId: parent,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: parentProvider,
    userMessageId: MessageId.make(`message:owner-fence:${ordinal}`),
    rootNodeId: NodeId.make(`node:owner-fence:root:${ordinal}`),
    activeAttemptId: RunAttemptId.make(`attempt:owner-fence:${ordinal}`),
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}
const old = run(1);
const resumed = run(2);
const rootTurn = (owner: OrchestrationV2Run) => ProviderTurnId.make(`turn:${owner.id}`);

function rootNode(owner: OrchestrationV2Run): OrchestrationV2ExecutionNode {
  return {
    id: owner.rootNodeId!,
    threadId: parent,
    runId: owner.id,
    parentNodeId: null,
    rootNodeId: owner.rootNodeId!,
    kind: "root_turn",
    status: "running",
    countsForRun: true,
    providerThreadId: parentProvider,
    providerTurnId: rootTurn(owner),
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}
function providerThread(owner: OrchestrationV2Run): OrchestrationV2ProviderThread {
  return {
    id: parentProvider,
    driver,
    providerInstanceId: instanceId,
    providerSessionId: sessionId,
    appThreadId: parent,
    ownerNodeId: owner.rootNodeId,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: owner.ordinal,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
}
function attempt(owner: OrchestrationV2Run): OrchestrationV2RunAttempt {
  return {
    id: owner.activeAttemptId!,
    runId: owner.id,
    attemptOrdinal: 1,
    rootNodeId: owner.rootNodeId!,
    providerInstanceId: instanceId,
    providerThreadId: parentProvider,
    providerTurnId: rootTurn(owner),
    reason: "initial",
    status: "running",
    startedAt: now,
    completedAt: null,
  };
}
function scope(owner: OrchestrationV2Run): OrchestrationV2CheckpointScope {
  return {
    id: CheckpointScopeId.make(`scope:${owner.id}`),
    threadId: parent,
    runId: owner.id,
    nodeId: owner.rootNodeId!,
    parentScopeId: null,
    providerThreadId: parentProvider,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/source-only",
    createdAt: now,
  };
}
function task(owner = old, status: "running" | "completed" = "running", at = now) {
  return {
    type: "subagent.updated",
    driver,
    ...(status === "running" ? { parentProviderThreadId: parentProvider } : {}),
    subagent: {
      id: taskId,
      threadId: parent,
      runId: owner.id,
      parentNodeId: owner.rootNodeId!,
      origin: "provider_native",
      createdBy: "agent",
      driver,
      providerInstanceId: instanceId,
      providerThreadId: childProvider,
      childThreadId: child,
      nativeTaskRef: null,
      prompt: "Audit",
      title: "Audit",
      model: null,
      status,
      result: null,
      startedAt: now,
      completedAt: status === "completed" ? at : null,
      updatedAt: at,
    },
  } satisfies Extract<ProviderAdapterV2Event, { type: "subagent.updated" }>;
}
function childNode(status: "running" | "completed" = "running") {
  return {
    type: "node.updated",
    driver,
    node: {
      ...rootNode(old),
      id: childRootId,
      threadId: child,
      runId: null,
      rootNodeId: childRootId,
      countsForRun: false,
      providerThreadId: childProvider,
      providerTurnId: ProviderTurnId.make("turn:owner-fence:child"),
      status,
      completedAt: status === "completed" ? lagAt : null,
    },
  } satisfies Extract<ProviderAdapterV2Event, { type: "node.updated" }>;
}
function command(status: "running" | "completed" | "cancelled" = "running", sibling = false) {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: sibling ? siblingId : childCommandId,
      threadId: sibling ? parent : child,
      runId: sibling ? old.id : null,
      nodeId: sibling ? old.rootNodeId : childRootId,
      providerThreadId: sibling ? parentProvider : childProvider,
      providerTurnId: sibling ? rootTurn(old) : ProviderTurnId.make("turn:owner-fence:child"),
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "command_execution",
      status,
      title: "Background check",
      input: "sleep 300",
      startedAt: now,
      completedAt: status === "running" ? null : lagAt,
      updatedAt: lagAt,
    },
  } satisfies Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>;
}
function terminal(
  owner: OrchestrationV2Run,
  status: "completed" | "cancelled" = "completed",
): ProviderAdapterV2Event {
  return {
    type: "turn.terminal",
    driver,
    providerThreadId: parentProvider,
    providerTurnId: rootTurn(owner),
    runOrdinal: owner.ordinal,
    status,
    failure: null,
    threadDisposition: "reusable",
  };
}

type Delivery = {
  readonly event: ProviderAdapterV2Event;
  readonly processed: Deferred.Deferred<void>;
};

function fixture(gate: "snapshot" | "cascade" | "nested" | "model") {
  return Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const history = yield* EventStore.EventStoreV2;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const closed = yield* Ref.make<ReadonlyArray<RunId>>([]);
    const closures = new Map<RunId, Deferred.Deferred<void>>();
    const subscriptions = new Map<RunId, Queue.Queue<Delivery>>();
    const pause = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    const wrappedSink = Layer.succeed(EventSink.EventSinkV2, {
      ...sink,
      write: (input) =>
        (input.events.some(
          (event) =>
            (gate === "snapshot" &&
              event.type === "subagent.updated" &&
              event.payload.runId === old.id &&
              DateTime.toEpochMillis(event.payload.updatedAt) === DateTime.toEpochMillis(lagAt)) ||
            (gate === "nested" &&
              event.type === "node.updated" &&
              event.payload.id === nestedTaskId &&
              event.runId === old.id &&
              event.payload.status === "completed"),
        )
          ? pause
          : Effect.void
        ).pipe(Effect.andThen(sink.write(input))),
      writeWithEffects: (input) =>
        (gate === "cascade" &&
        input.events.some(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === old.id &&
            event.payload.status === "cancelled",
        )
          ? pause
          : Effect.void
        ).pipe(Effect.andThen(sink.writeWithEffects(input))),
    });
    const modelReads = yield* Ref.make(0);
    const ingestionProjections = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
      ...projections,
      getThread: (id) =>
        gate === "model" && id === child
          ? Ref.getAndUpdate(modelReads, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                (count === 0 ? pause : Effect.void).pipe(Effect.andThen(projections.getThread(id))),
              ),
            )
          : projections.getThread(id),
    });
    const ingestion = ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          wrappedSink,
          ingestionProjections,
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
        ),
      ),
    );
    const execution = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          wrappedSink,
          ingestion,
          IdAllocator.layer,
          McpAppModelContext.layerEmpty,
          ServerSettings.layerTest(),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
        ),
      ),
    );
    const service = yield* RunExecutionService.RunExecutionServiceV2.pipe(
      Effect.provide(execution),
    );
    const seed = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => sink.write({ events });
    yield* seed(
      [parent, child].map((id) => ({
        id: EventId.make(`seed:${id}`),
        type: "thread.created",
        threadId: id,
        occurredAt: now,
        payload: thread(id),
      })),
    );
    const start = (owner: OrchestrationV2Run) =>
      Effect.gen(function* () {
        yield* seed([
          {
            id: EventId.make(`seed:${owner.id}`),
            type: "run.created",
            threadId: parent,
            runId: owner.id,
            occurredAt: now,
            payload: owner,
          },
          {
            id: EventId.make(`seed:node:${owner.id}`),
            type: "node.updated",
            threadId: parent,
            runId: owner.id,
            occurredAt: now,
            payload: rootNode(owner),
          },
          {
            id: EventId.make(`seed:provider:${owner.id}`),
            type: "provider-thread.updated",
            threadId: parent,
            occurredAt: now,
            payload: providerThread(owner),
          },
        ]);
        const queue = yield* Queue.unbounded<Delivery>();
        const closure = yield* Deferred.make<void>();
        subscriptions.set(owner.id, queue);
        closures.set(owner.id, closure);
        yield* service.startRootRun({
          commandId: CommandId.make(`command:${owner.id}`),
          appThread: thread(parent),
          providerSessionId: sessionId,
          session: {
            events: Stream.empty,
            subscribeEvents: Effect.succeed({
              events: Stream.fromQueue(queue).pipe(
                Stream.flatMap(({ event, processed }) =>
                  Stream.succeed(event).pipe(
                    Stream.ensuring(Deferred.succeed(processed, undefined)),
                  ),
                ),
              ),
              close: Ref.update(closed, (current) => [...current, owner.id]).pipe(
                Effect.andThen(Deferred.succeed(closure, undefined)),
              ),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: owner,
          rootNode: rootNode(owner),
          checkpointScope: scope(owner),
          providerThread: providerThread(owner),
          attempt: attempt(owner),
          attemptId: owner.activeAttemptId!,
          providerTurnOrdinal: 1,
          relatedThreadIds: owner.id === old.id ? [child] : [],
          message: {
            messageId: owner.userMessageId,
            text: "Audit",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      });
    const publish = (event: ProviderAdapterV2Event) =>
      Effect.gen(function* () {
        const done = yield* Ref.get(closed);
        const acknowledgements = new Map<RunId, Deferred.Deferred<void>>();
        for (const [owner, queue] of subscriptions) {
          if (done.includes(owner)) continue;
          const processed = yield* Deferred.make<void>();
          yield* Queue.offer(queue, { event, processed });
          acknowledgements.set(owner, processed);
        }
        return acknowledgements;
      });
    const send = (event: ProviderAdapterV2Event) =>
      publish(event).pipe(
        Effect.flatMap((acks) =>
          Effect.all([...acks.values()].map(Deferred.await), { concurrency: "unbounded" }),
        ),
      );
    return { start, publish, send, projections, history, sink, entered, release, closures, closed };
  });
}

it.effect("a gated null-run nested snapshot checks its containing child's owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture("nested");
      const nestedChild = ThreadId.make("thread:owner-fence:nested-child");
      const nestedRow = (status: "running" | "completed") => ({
        ...task(old, status),
        subagent: {
          ...task(old, status).subagent,
          id: nestedTaskId,
          threadId: child,
          runId: null,
          parentNodeId: childRootId,
          providerThreadId: null,
          childThreadId: nestedChild,
        },
      });
      const nestedNode = (status: "running" | "completed") =>
        ({
          ...childNode(status),
          node: {
            ...childNode(status).node,
            id: nestedTaskId,
            kind: "subagent",
            parentNodeId: childRootId,
          },
        }) satisfies Extract<ProviderAdapterV2Event, { type: "node.updated" }>;
      const nestedCard = (status: "running" | "completed") =>
        ({
          type: "turn_item.updated",
          driver,
          turnItem: {
            id: TurnItemId.make("item:owner-fence:nested-card"),
            threadId: child,
            runId: null,
            nodeId: nestedTaskId,
            providerThreadId: childProvider,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            type: "subagent",
            status,
            title: "Nested audit",
            subagentId: nestedTaskId,
            origin: "provider_native",
            driver,
            providerInstanceId: instanceId,
            childThreadId: nestedChild,
            prompt: "Nested audit",
            result: null,
            startedAt: now,
            completedAt: status === "completed" ? now : null,
            updatedAt: now,
          },
        }) satisfies Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>;
      yield* test.start(old);
      for (const event of [
        task(),
        childNode(),
        nestedRow("running"),
        nestedNode("running"),
        nestedCard("running"),
        command("running", true),
        terminal(old),
      ])
        yield* test.send(event);
      yield* test.publish(nestedNode("completed"));
      yield* Deferred.await(test.entered);
      yield* test.publish(nestedRow("completed"));
      yield* test.publish(nestedCard("completed"));
      yield* test.start(resumed);
      let last = new Map<RunId, Deferred.Deferred<void>>();
      for (const event of [
        task(resumed, "running", resumeAt),
        nestedRow("running"),
        nestedNode("running"),
        nestedCard("running"),
      ]) {
        last = yield* test.publish(event);
        yield* Deferred.await(last.get(resumed.id)!);
      }
      const afterResume = yield* test.sink.latestSequence();
      yield* Deferred.succeed(test.release, undefined);
      yield* Deferred.await(last.get(old.id)!);
      const projection = yield* test.projections.getThreadProjection(child);
      assert.equal(projection.nodes.find((node) => node.id === nestedTaskId)?.status, "running");
      assert.equal(projection.subagents.find((row) => row.id === nestedTaskId)?.status, "running");
      assert.equal(projection.subagents.find((row) => row.id === nestedTaskId)?.runId, null);
      assert.equal(
        projection.turnItems.find((item) => item.id === nestedCard("running").turnItem.id)?.status,
        "running",
      );
      const late = yield* test.history.read({ afterSequence: afterResume }).pipe(Stream.runCollect);
      assert.isFalse(
        late.some(({ event }) => event.threadId === child),
        "no lagging nested artifact reaches persistence",
      );
      // A named artifact with neither a row owner nor a containing-thread owner
      // remains permissive; the fence must not invent ownership.
      const unlinked = yield* test.sink.write({
        guardSubagentOwnership: { threadId: parent, runId: old.id },
        events: [
          {
            id: EventId.make("unlinked:node"),
            type: "node.updated",
            threadId: ThreadId.make("thread:owner-fence:unlinked"),
            runId: old.id,
            occurredAt: now,
            payload: {
              ...nestedNode("completed").node,
              id: NodeId.make("node:unlinked"),
              threadId: ThreadId.make("thread:owner-fence:unlinked"),
            },
          },
        ],
      });
      assert.lengthOf(unlinked, 1);
      // The grandchild thread under the null-owned nested row inherits the
      // transferred owner of the child containing that row.
      yield* test.sink.write({
        events: [
          {
            id: EventId.make("seed:grandchild"),
            type: "thread.created",
            threadId: nestedChild,
            occurredAt: now,
            payload: thread(nestedChild),
          },
        ],
      });
      const grandchildWrite = (owner: OrchestrationV2Run) =>
        test.sink.write({
          guardSubagentOwnership: { threadId: parent, runId: owner.id },
          events: [
            {
              id: EventId.make(`grandchild:node:${owner.id}`),
              type: "node.updated",
              threadId: nestedChild,
              occurredAt: now,
              payload: {
                ...childNode("completed").node,
                id: NodeId.make("node:owner-fence:grandchild-root"),
                threadId: nestedChild,
                rootNodeId: NodeId.make("node:owner-fence:grandchild-root"),
              },
            },
            {
              id: EventId.make(`grandchild:model:${owner.id}`),
              type: "thread.model-selection-updated",
              threadId: nestedChild,
              occurredAt: now,
              payload: {
                ...thread(nestedChild),
                modelSelection: { instanceId, model: `model:${owner.id}` },
              },
            },
          ],
        });
      assert.lengthOf(yield* grandchildWrite(old), 0, "the old run cannot write the grandchild");
      assert.lengthOf(yield* grandchildWrite(resumed), 2);
      yield* test.send(command("completed", true));
      yield* Deferred.await(test.closures.get(old.id)!);
      for (const event of [
        nestedRow("completed"),
        nestedCard("completed"),
        task(resumed, "completed", resumeAt),
        terminal(resumed),
      ])
        yield* test.send(event);
      yield* Deferred.await(test.closures.get(resumed.id)!);
    }),
  ).pipe(Effect.provide(persistence)),
);

it.effect("a gated old model sync cannot overwrite the resumed child's model", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture("model");
      yield* test.start(old);
      const oldModel = { ...task(), subagent: { ...task().subagent, model: "old-child-model" } };
      const oldAck = yield* test.publish(oldModel);
      // The old subagent row is committed. Pause the initial model read before
      // taking the thread lock, so the newer subscriber can finish its own sync.
      yield* Deferred.await(test.entered);
      const before = yield* test.projections.getThreadProjection(parent);
      assert.equal(before.subagents.find((row) => row.id === taskId)?.model, "old-child-model");
      yield* test.start(resumed);
      const newModel = {
        ...task(resumed, "running", resumeAt),
        subagent: { ...task(resumed, "running", resumeAt).subagent, model: "resumed-child-model" },
      };
      const newAck = yield* test.publish(newModel);
      yield* Deferred.await(newAck.get(resumed.id)!);
      assert.equal(
        (yield* test.projections.getThread(child)).modelSelection.model,
        "resumed-child-model",
      );
      const afterResume = yield* test.sink.latestSequence();
      yield* Deferred.succeed(test.release, undefined);
      yield* Deferred.await(oldAck.get(old.id)!);
      yield* Deferred.await(newAck.get(old.id)!);
      assert.equal(
        (yield* test.projections.getThread(child)).modelSelection.model,
        "resumed-child-model",
      );
      const late = yield* test.history.read({ afterSequence: afterResume }).pipe(Stream.runCollect);
      assert.isFalse(
        late.some(
          ({ event }) =>
            event.type === "thread.model-selection-updated" && event.threadId === child,
        ),
        "the delayed derived model write is not appended",
      );
      yield* test.publish(terminal(old));
      yield* Deferred.await(test.closures.get(old.id)!);
      yield* test.send(task(resumed, "completed", resumeAt));
      yield* test.publish(terminal(resumed));
      yield* Deferred.await(test.closures.get(resumed.id)!);
    }),
  ).pipe(Effect.provide(persistence)),
);

it.effect("fences gated parent representations without changing root gates or carried items", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture("snapshot");
      yield* test.start(old);
      yield* test.send(task());
      yield* test.send(childNode());
      yield* test.start(resumed);
      const card = (owner: OrchestrationV2Run, status: "running" | "completed") =>
        ({
          id: EventId.make(`card:${owner.id}:${status}`),
          type: "turn-item.updated",
          threadId: parent,
          runId: owner.id,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("item:owner-fence:card"),
            threadId: parent,
            runId: owner.id,
            nodeId: taskId,
            providerThreadId: parentProvider,
            providerTurnId: rootTurn(owner),
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            type: "subagent",
            status,
            title: "Audit",
            subagentId: taskId,
            origin: "provider_native",
            driver,
            providerInstanceId: instanceId,
            childThreadId: child,
            prompt: "Audit",
            result: null,
            startedAt: now,
            completedAt: status === "completed" ? now : null,
            updatedAt: now,
          },
        }) satisfies Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }>;
      // Carryover retains its originating run; being ingested by a newer root
      // does not itself constitute a handoff.
      const carried = yield* test.sink.write({
        guardSubagentOwnership: { threadId: parent, runId: resumed.id },
        events: [card(old, "completed")],
      });
      assert.lengthOf(carried, 1);
      for (const invalid of [
        {
          ...task(resumed, "running", resumeAt),
          parentProviderThreadId: ProviderThreadId.make("wrong-parent-session"),
        },
        {
          ...task(resumed, "running", resumeAt),
          subagent: { ...task(resumed).subagent, threadId: ThreadId.make("wrong-parent") },
        },
        task(resumed, "completed", resumeAt),
      ]) {
        yield* test.send(invalid);
        const projection = yield* test.projections.getThreadProjection(parent);
        assert.equal(
          projection.subagents.find((row) => row.id === taskId)?.runId,
          old.id,
          "invalid evidence cannot claim persisted ownership",
        );
      }
      yield* test.send(task(resumed, "running", resumeAt));
      const parentNode = {
        id: EventId.make("parent-node:current"),
        type: "node.updated",
        threadId: parent,
        runId: resumed.id,
        occurredAt: now,
        payload: {
          ...rootNode(resumed),
          id: taskId,
          parentNodeId: resumed.rootNodeId,
          kind: "subagent",
          countsForRun: false,
        },
      } satisfies Extract<OrchestrationV2DomainEvent, { type: "node.updated" }>;
      yield* test.sink.write({
        guardSubagentOwnership: { threadId: parent, runId: resumed.id },
        events: [parentNode, card(resumed, "running")],
      });
      const gated = yield* test.sink.writeIfRunCurrent({
        threadId: parent,
        runId: old.id,
        activeAttemptId: old.activeAttemptId!,
        expectedStatus: "running",
        guardSubagentOwnership: { threadId: parent, runId: old.id },
        events: [
          {
            ...parentNode,
            id: EventId.make("parent-node:stale"),
            runId: old.id,
            payload: { ...parentNode.payload, runId: old.id, status: "completed" },
          },
          card(old, "completed"),
          {
            id: EventId.make("child-node:stale"),
            type: "node.updated",
            threadId: child,
            runId: old.id,
            occurredAt: now,
            payload: childNode("completed").node,
          },
          {
            id: EventId.make("root-node:valid"),
            type: "node.updated",
            threadId: parent,
            runId: old.id,
            occurredAt: now,
            payload: { ...rootNode(old), status: "waiting" },
          },
        ],
      });
      assert.isTrue(
        gated.committed,
        "the original run-current gate remains authoritative for root writes",
      );
      assert.lengthOf(gated.storedEvents, 1, "only the legitimate root update is appended");
      const projection = yield* test.projections.getThreadProjection(parent);
      assert.equal(projection.nodes.find((node) => node.id === taskId)?.runId, resumed.id);
      assert.equal(projection.nodes.find((node) => node.id === taskId)?.status, "running");
      assert.equal(
        projection.turnItems.find((item) => item.id === TurnItemId.make("item:owner-fence:card"))
          ?.runId,
        resumed.id,
      );
      assert.equal(
        projection.turnItems.find((item) => item.id === TurnItemId.make("item:owner-fence:card"))
          ?.status,
        "running",
      );
      assert.equal(projection.nodes.find((node) => node.id === old.rootNodeId)?.status, "waiting");
      yield* test.sink.write({
        guardSubagentOwnership: { threadId: parent, runId: resumed.id },
        events: [card(resumed, "completed")],
      });
      for (const event of [terminal(old), task(resumed, "completed", resumeAt), terminal(resumed)])
        yield* test.send(event);
      yield* Deferred.await(test.closures.get(old.id)!);
      yield* Deferred.await(test.closures.get(resumed.id)!);
    }),
  ).pipe(Effect.provide(persistence)),
);

it.effect.each(["completed", "running"] as const)(
  "a gated old %s snapshot cannot overwrite a persisted resume",
  (status) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture("snapshot");
        yield* test.start(old);
        for (const event of [
          task(),
          childNode(),
          command(),
          command("running", true),
          terminal(old),
        ])
          yield* test.send(event);
        // Normalize/authorize the old snapshot first, then suspend immediately
        // before its real SQLite write. The transfer happens on the other queue.
        yield* test.publish(task(old, status, lagAt));
        yield* Deferred.await(test.entered);
        yield* test.publish(childNode("completed"));
        yield* test.publish(command("cancelled"));
        yield* test.start(resumed);
        let lastNew = new Map<RunId, Deferred.Deferred<void>>();
        for (const event of [task(resumed, "running", resumeAt), childNode(), command()]) {
          lastNew = yield* test.publish(event);
          yield* Deferred.await(lastNew.get(resumed.id)!);
        }
        const afterResume = yield* test.sink.latestSequence();
        yield* Deferred.succeed(test.release, undefined);
        yield* Deferred.await(lastNew.get(old.id)!);
        const childProjection = yield* test.projections.getThreadProjection(child);
        assert.equal(
          childProjection.nodes.find((node) => node.id === childRootId)?.status,
          "running",
        );
        assert.equal(
          childProjection.turnItems.find((item) => item.id === childCommandId)?.status,
          "running",
        );
        const parentProjection = yield* test.projections.getThreadProjection(parent);
        assert.equal(
          parentProjection.subagents.find((row) => row.id === taskId)?.runId,
          resumed.id,
        );
        assert.equal(
          parentProjection.subagents.find((row) => row.id === taskId)?.status,
          "running",
        );
        const late = yield* test.history
          .read({ afterSequence: afterResume })
          .pipe(Stream.runCollect);
        assert.isFalse(
          late.some(
            ({ event }) =>
              event.threadId === child &&
              (event.type === "node.updated" || event.type === "turn-item.updated"),
          ),
          "no stale child snapshot or cancellation reaches persistence",
        );
        yield* test.send(command("completed", true));
        yield* Deferred.await(test.closures.get(old.id)!);
        for (const event of [
          task(resumed, "completed", resumeAt),
          command("completed"),
          terminal(resumed),
        ])
          yield* test.send(event);
        yield* Deferred.await(test.closures.get(resumed.id)!);
      }),
    ).pipe(Effect.provide(persistence)),
);

it.effect("a gated old settle cascade cannot cancel resumed child work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture("cascade");
      yield* test.start(old);
      for (const event of [task(), childNode(), command()]) yield* test.send(event);
      const oldFinal = yield* test.publish(terminal(old, "cancelled"));
      yield* Deferred.await(test.entered);
      yield* test.start(resumed);
      for (const event of [task(resumed, "running", resumeAt), childNode(), command()]) {
        const acks = yield* test.publish(event);
        yield* Deferred.await(acks.get(resumed.id)!);
      }
      const afterResume = yield* test.sink.latestSequence();
      yield* Deferred.succeed(test.release, undefined);
      yield* Deferred.await(oldFinal.get(old.id)!);
      yield* Deferred.await(test.closures.get(old.id)!);
      const childProjection = yield* test.projections.getThreadProjection(child);
      assert.equal(
        childProjection.nodes.find((node) => node.id === childRootId)?.status,
        "running",
      );
      assert.equal(
        childProjection.turnItems.find((item) => item.id === childCommandId)?.status,
        "running",
      );
      const parentProjection = yield* test.projections.getThreadProjection(parent);
      assert.equal(parentProjection.subagents.find((row) => row.id === taskId)?.runId, resumed.id);
      assert.equal(parentProjection.subagents.find((row) => row.id === taskId)?.status, "running");
      const late = yield* test.history.read({ afterSequence: afterResume }).pipe(Stream.runCollect);
      assert.isFalse(
        late.some(
          ({ event }) =>
            event.threadId === child &&
            (event.type === "node.updated" || event.type === "turn-item.updated"),
        ),
        "old cascade must not append child cancellations",
      );
      assert.equal(
        parentProjection.runs.find((row) => row.id === old.id)?.status,
        "cancelled",
        "the old root's legitimate finalization is unaffected",
      );
      for (const event of [
        task(resumed, "completed", resumeAt),
        command("completed"),
        terminal(resumed),
      ])
        yield* test.send(event);
      yield* Deferred.await(test.closures.get(resumed.id)!);
    }),
  ).pipe(Effect.provide(persistence)),
);
