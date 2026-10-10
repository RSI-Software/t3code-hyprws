import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
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
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as RunExecutionService from "./RunExecutionService.ts";

const identity: RunExecutionService.ProviderEventRouteIdentity = {
  threadId: ThreadId.make("thread:resumed-child"),
  runId: RunId.make("run:resumed-child:new"),
  attemptId: RunAttemptId.make("attempt:resumed-child:new"),
  providerThreadId: ProviderThreadId.make("provider-thread:resumed-child:parent"),
};
const oldIdentity = {
  ...identity,
  runId: RunId.make("run:resumed-child:old"),
  attemptId: RunAttemptId.make("attempt:resumed-child:old"),
};
const childThreadId = ThreadId.make("thread:resumed-child:child");
const subagentId = NodeId.make("node:resumed-child:subagent");
const rootProviderTurnId = ProviderTurnId.make("provider-turn:resumed-child:root");
const initial = (owner = identity, ownsChild = false) =>
  RunExecutionService.makeProviderEventRoutingState({
    identity: owner,
    providerTurnId: rootProviderTurnId,
    ...(ownsChild ? { relatedThreadIds: [childThreadId] } : {}),
  });

function subagentEvent(
  overrides: Partial<OrchestrationV2Subagent> = {},
  parentProviderThreadId: ProviderThreadId | undefined = identity.providerThreadId,
): Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> {
  return {
    type: "subagent.updated",
    driver: ProviderDriverKind.make("claudeAgent"),
    ...(parentProviderThreadId === undefined ? {} : { parentProviderThreadId }),
    subagent: {
      id: subagentId,
      threadId: identity.threadId,
      runId: identity.runId,
      parentNodeId: NodeId.make("node:resumed-child:parent"),
      origin: "provider_native",
      createdBy: "agent",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      providerThreadId: null,
      childThreadId,
      nativeTaskRef: null,
      prompt: "Resume the audit",
      title: "Audit",
      model: null,
      status: "running",
      result: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-10-06T18:03:00Z"),
      ...overrides,
    },
  };
}

function childEvents(): ReadonlyArray<ProviderAdapterV2Event> {
  const nodeId = NodeId.make("node:resumed-child:child-root");
  const now = DateTime.makeUnsafe("2026-10-06T18:03:00Z");
  return [
    {
      type: "node.updated",
      driver: ProviderDriverKind.make("claudeAgent"),
      node: {
        id: nodeId,
        threadId: childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    },
    {
      type: "message.updated",
      driver: ProviderDriverKind.make("claudeAgent"),
      message: {
        id: MessageId.make("message:resumed-child:prompt"),
        threadId: childThreadId,
        runId: null,
        nodeId,
        role: "user",
        text: "Resume the audit",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      type: "turn_item.updated",
      driver: ProviderDriverKind.make("claudeAgent"),
      turnItem: {
        id: TurnItemId.make("item:resumed-child:prompt"),
        threadId: childThreadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 101,
        type: "user_message",
        status: "completed",
        title: null,
        messageId: MessageId.make("message:resumed-child:prompt"),
        text: "Resume the audit",
        attachments: [],
        createdBy: "agent",
        creationSource: "provider",
        inputIntent: "turn_start",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      },
    },
  ];
}

const route = RunExecutionService.routeProviderEvent;

describe("validated native subagent resume routing", () => {
  it.each(["failed", "completed", "running"] as const)(
    "transfers a %s child to the resuming run",
    (priorStatus) => {
      const [, beforeResume] = route(
        subagentEvent({ runId: oldIdentity.runId, status: priorStatus }),
        identity,
        initial(),
      );
      assert.isFalse(beforeResume.ownedThreadIds.has(childThreadId));
      const [accepted, resumed] = route(subagentEvent(), identity, beforeResume);
      assert.isTrue(accepted);
      for (const event of childEvents()) assert.isTrue(route(event, identity, resumed)[0]);
    },
  );

  it("routes child app events to exactly one of two live runs after reassignment", () => {
    const reassignment = subagentEvent();
    const [oldAccepted, oldState] = route(reassignment, oldIdentity, initial(oldIdentity, true));
    const [newAccepted, newState] = route(reassignment, identity, initial());
    assert.isFalse(oldAccepted, "old run must not store the reassignment");
    assert.isTrue(newAccepted);
    assert.isFalse(oldState.ownedThreadIds.has(childThreadId));
    assert.isTrue(oldState.ownedThreadIds.has(identity.threadId));
    for (const event of childEvents()) {
      const acceptance = [
        route(event, oldIdentity, oldState)[0],
        route(event, identity, newState)[0],
      ];
      assert.deepEqual(acceptance, [false, true]);
    }
  });

  const rejected = [
    ["another run", subagentEvent({ runId: oldIdentity.runId })],
    ["null run", subagentEvent({ runId: null })],
    ["wrong parent", subagentEvent({ threadId: ThreadId.make("thread:unrelated") })],
    [
      "wrong provider session",
      subagentEvent({}, ProviderThreadId.make("provider-thread:unrelated")),
    ],
    [
      "missing evidence",
      {
        type: "subagent.updated",
        driver: ProviderDriverKind.make("claudeAgent"),
        subagent: subagentEvent().subagent,
      },
    ],
    ["null child", subagentEvent({ childThreadId: null })],
    ...(["completed", "failed", "cancelled", "idle"] as const).map(
      (status) => [status, subagentEvent({ status })] as const,
    ),
  ] satisfies ReadonlyArray<readonly [string, ProviderAdapterV2Event]>;
  it.each(rejected)("does not adopt on %s", (_name, event) => {
    const [, state] = route(event, identity, initial());
    assert.isFalse(state.ownedThreadIds.has(childThreadId));
    for (const child of childEvents()) assert.isFalse(route(child, identity, state)[0]);
  });

  it("cannot use ownership of a child provider thread as parent evidence", () => {
    const childProviderThreadId = ProviderThreadId.make("provider-thread:resumed-child:child");
    const state = {
      ...initial(),
      ownedProviderThreadIds: new Set([identity.providerThreadId, childProviderThreadId]),
    };
    const [, after] = route(subagentEvent({}, childProviderThreadId), identity, state);
    assert.isFalse(after.ownedThreadIds.has(childThreadId));
  });

  it("preserves adoption through app_thread.created for same-run launch and resume", () => {
    const created = {
      type: "app_thread.created",
      driver: ProviderDriverKind.make("claudeAgent"),
      appThread: {
        id: childThreadId,
        lineage: { parentThreadId: identity.threadId, relationshipToParent: "subagent" },
      },
    } as ProviderAdapterV2Event;
    const [accepted, launched] = route(created, identity, initial());
    assert.isTrue(accepted);
    const [, resumed] = route(subagentEvent(), identity, launched);
    for (const event of childEvents()) assert.isTrue(route(event, identity, resumed)[0]);
  });

  it("does not revoke on a null run, wrong parent, or missing/mismatched evidence", () => {
    for (const event of [
      subagentEvent({ runId: null }),
      subagentEvent({ threadId: ThreadId.make("thread:unrelated") }),
      {
        type: "subagent.updated",
        driver: ProviderDriverKind.make("claudeAgent"),
        subagent: subagentEvent().subagent,
      } as const,
      subagentEvent({}, ProviderThreadId.make("provider-thread:unrelated")),
    ]) {
      const [, state] = route(event, oldIdentity, initial(oldIdentity, true));
      assert.isTrue(state.ownedThreadIds.has(childThreadId));
    }
  });

  it("validates Codex reopen evidence against its parent, not its child provider thread", () => {
    const event = subagentEvent({
      driver: ProviderDriverKind.make("codex"),
      providerThreadId: ProviderThreadId.make("provider-thread:codex-child"),
    });
    const [, resumed] = route(
      { ...event, driver: ProviderDriverKind.make("codex") },
      identity,
      initial(),
    );
    for (const child of childEvents()) assert.isTrue(route(child, identity, resumed)[0]);
  });
});

function runOldRunLifecycleScenario(
  events: ReadonlyArray<ProviderAdapterV2Event>,
  onFinalEvents: (events: ReadonlyArray<OrchestrationV2DomainEvent>) => Effect.Effect<void> = () =>
    Effect.void,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      const stored = yield* Ref.make<ReadonlyArray<ProviderAdapterV2Event>>([]);
      const layer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: ({ events }) => onFinalEvents(events).pipe(Effect.as([])),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: ({ event }) =>
                Ref.update(stored, (events) => [...events, event]).pipe(Effect.as([])),
            }),
            McpAppModelContext.layerEmpty,
            ServerSettings.layerTest(),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* RunExecutionService.RunExecutionServiceV2;
        yield* service.startRootRun({
          commandId: CommandId.make("command:resumed-child"),
          appThread: { id: oldIdentity.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make("session:resumed-child"),
          session: {
            events: Stream.empty,
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable(events).pipe(Stream.concat(Stream.never)),
              close: Deferred.succeed(closed, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: oldIdentity.runId,
            threadId: oldIdentity.threadId,
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          } as OrchestrationV2Run,
          rootNode: {
            id: NodeId.make("node:resumed-child:parent"),
          } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make("checkpoint:resumed-child"),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: oldIdentity.providerThreadId,
            driver: ProviderDriverKind.make("claudeAgent"),
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: oldIdentity.attemptId,
            providerTurnId: rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: oldIdentity.attemptId,
          providerTurnOrdinal: 1,
          relatedThreadIds: [childThreadId],
          message: {
            messageId: MessageId.make("message:resumed-child:parent"),
            text: "Launch",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
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
        yield* Deferred.await(closed);
      }).pipe(Effect.provide(layer));
      return yield* Ref.get(stored);
    }),
  );
}

function trackedSubagentItem(
  status: "running" | "completed" = "running",
  subagentNodeId = subagentId,
) {
  const task = subagentEvent({ runId: oldIdentity.runId, id: subagentNodeId }).subagent;
  return {
    type: "turn_item.updated",
    driver: task.driver,
    turnItem: {
      id: TurnItemId.make(`turn-item:${task.id}`),
      threadId: task.threadId,
      runId: task.runId,
      nodeId: task.id,
      providerThreadId: identity.providerThreadId,
      providerTurnId: rootProviderTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status,
      title: task.title,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      updatedAt: task.updatedAt,
      type: "subagent",
      subagentId: task.id,
      origin: task.origin,
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      childThreadId: task.childThreadId,
      prompt: task.prompt,
      result: task.result,
    },
  } satisfies Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>;
}
const oldRootTerminal: ProviderAdapterV2Event = {
  type: "turn.terminal",
  driver: ProviderDriverKind.make("claudeAgent"),
  providerThreadId: oldIdentity.providerThreadId,
  providerTurnId: rootProviderTurnId,
  runOrdinal: 1,
  status: "completed",
  failure: null,
  threadDisposition: "reusable",
};
const oldRunMarker: ProviderAdapterV2Event = {
  ...(childEvents()[1] as Extract<ProviderAdapterV2Event, { type: "message.updated" }>),
  message: {
    ...(childEvents()[1] as Extract<ProviderAdapterV2Event, { type: "message.updated" }>).message,
    threadId: oldIdentity.threadId,
    runId: oldIdentity.runId,
  },
};

it.effect.each([false, true])(
  "releases old ingestion after reassignment (tracked item: %s)",
  (trackItem) =>
    Effect.gen(function* () {
      const stored = yield* runOldRunLifecycleScenario([
        subagentEvent({ runId: oldIdentity.runId }),
        ...(trackItem ? [trackedSubagentItem()] : []),
        oldRootTerminal,
        subagentEvent(),
        ...childEvents(),
      ]);
      assert.deepEqual(
        stored.map((event) => event.type),
        ["subagent.updated", ...(trackItem ? ["turn_item.updated"] : []), "turn.terminal"],
      );
    }),
);

const invalidRevocations = [
  [
    "missing evidence",
    {
      type: "subagent.updated",
      driver: ProviderDriverKind.make("claudeAgent"),
      subagent: subagentEvent().subagent,
    },
  ],
  ["wrong evidence", subagentEvent({}, ProviderThreadId.make("provider-thread:unrelated"))],
  ["wrong parent", subagentEvent({ threadId: ThreadId.make("thread:unrelated") })],
] satisfies ReadonlyArray<readonly [string, ProviderAdapterV2Event]>;

it.effect.each(
  invalidRevocations.flatMap(([name, event]) =>
    (["row", "item"] as const).map((held) => ({ name, event, held })),
  ),
)("keeps $held tracking on invalid revocation: $name", ({ event, held }) =>
  Effect.gen(function* () {
    const settleOther =
      held === "row"
        ? trackedSubagentItem("completed")
        : subagentEvent({ runId: oldIdentity.runId, status: "completed" });
    const stored = yield* runOldRunLifecycleScenario([
      subagentEvent({ runId: oldIdentity.runId }),
      trackedSubagentItem(),
      oldRootTerminal,
      event,
      settleOther,
      oldRunMarker,
      subagentEvent(),
    ]);
    assert.include(
      stored,
      oldRunMarker,
      "invalid reassignment released tracking before its valid replacement",
    );
    assert.notInclude(stored, event);
  }),
);

it.effect("revocation leaves another subagent's tracked turn item untouched", () =>
  Effect.gen(function* () {
    const otherId = NodeId.make("node:other-subagent");
    const otherRunning = trackedSubagentItem("running", otherId);
    const otherCompleted = trackedSubagentItem("completed", otherId);
    const stored = yield* runOldRunLifecycleScenario([
      subagentEvent({ runId: oldIdentity.runId }),
      trackedSubagentItem(),
      otherRunning,
      oldRootTerminal,
      subagentEvent(),
      oldRunMarker,
      otherCompleted,
    ]);
    assert.include(stored, oldRunMarker);
    assert.include(stored, otherCompleted);
  }),
);

function trackedSubagentSnapshot(
  task: OrchestrationV2Subagent,
): ReadonlyArray<ProviderAdapterV2Event> {
  const childThreadId = task.childThreadId!;
  const childRootId = NodeId.make(`${task.id}:child-root`);
  const baseNode = (childEvents()[0] as Extract<ProviderAdapterV2Event, { type: "node.updated" }>)
    .node;
  const item = trackedSubagentItem("running", task.id);
  return [
    {
      type: "app_thread.created",
      driver: task.driver,
      appThread: {
        id: childThreadId,
        lineage: { parentThreadId: task.threadId, relationshipToParent: "subagent" },
      },
    } as ProviderAdapterV2Event,
    { type: "subagent.updated", driver: task.driver, subagent: task },
    { ...item, turnItem: { ...item.turnItem, childThreadId } },
    {
      type: "node.updated",
      driver: task.driver,
      node: {
        ...baseNode,
        id: task.id,
        threadId: task.threadId,
        runId: task.runId,
        parentNodeId: task.parentNodeId,
        rootNodeId: task.parentNodeId ?? task.id,
        kind: "subagent",
      },
    },
    {
      type: "node.updated",
      driver: task.driver,
      node: { ...baseNode, id: childRootId, rootNodeId: childRootId, threadId: childThreadId },
    },
    {
      type: "turn_item.updated",
      driver: task.driver,
      turnItem: {
        id: TurnItemId.make(`${task.id}:child-item`),
        threadId: childThreadId,
        runId: null,
        nodeId: childRootId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 102,
        status: "running",
        title: null,
        startedAt: baseNode.startedAt,
        completedAt: null,
        updatedAt: task.updatedAt,
        type: "reasoning",
        text: "Working",
        streaming: false,
      },
    },
  ];
}

it.effect.each(["interrupted", "cancelled"] as const)(
  "does not cascade into a reassigned child when the old root ends %s",
  (status) =>
    Effect.gen(function* () {
      const finalEvents = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const reassigned = subagentEvent({ runId: oldIdentity.runId }).subagent;
      const retained = subagentEvent({
        runId: oldIdentity.runId,
        id: NodeId.make("node:retained-subagent"),
        childThreadId: ThreadId.make("thread:retained-child"),
      }).subagent;
      const reassignment = subagentEvent();
      const stored = yield* runOldRunLifecycleScenario(
        [
          ...trackedSubagentSnapshot(reassigned),
          ...trackedSubagentSnapshot(retained),
          reassignment,
          { ...oldRootTerminal, status },
        ],
        (events) => Ref.update(finalEvents, (current) => [...current, ...events]),
      );
      assert.notInclude(stored, reassignment, "old run must reject the reassignment for storage");
      const cascade = yield* Ref.get(finalEvents);
      assert.isFalse(
        cascade.some(
          (event) =>
            event.threadId === reassigned.childThreadId ||
            event.nodeId === reassigned.id ||
            (event.type === "turn-item.updated" &&
              event.payload.id === trackedSubagentItem().turnItem.id),
        ),
        "old-run termination must not re-seize the resumed subagent or terminalize its child",
      );
      const retainedEvents = cascade.filter(
        (event) => event.threadId === retained.childThreadId || event.nodeId === retained.id,
      );
      assert.deepEqual(retainedEvents.map((event) => event.type).toSorted(), [
        "node.updated",
        "node.updated",
        "subagent.updated",
        "turn-item.updated",
        "turn-item.updated",
      ]);
      for (const event of retainedEvents) {
        assert.equal(event.runId, oldIdentity.runId);
        assert.isTrue("status" in event.payload);
        if ("status" in event.payload) assert.equal(event.payload.status, status);
      }
    }),
);
