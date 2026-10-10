import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
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
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const sessionId = ProviderSessionId.make("session:transfer");
const now = DateTime.makeUnsafe("2026-10-06T18:03:00Z");
const parent = ThreadId.make("thread:transfer:parent");
const parentProvider = ProviderThreadId.make("provider-thread:transfer:parent");
const old = {
  threadId: parent,
  providerThreadId: parentProvider,
  runId: RunId.make("run:transfer:old"),
  attemptId: RunAttemptId.make("attempt:transfer:old"),
};
const resumed = {
  ...old,
  runId: RunId.make("run:transfer:resumed"),
  attemptId: RunAttemptId.make("attempt:transfer:resumed"),
};
const oldRootTurn = ProviderTurnId.make("provider-turn:transfer:old-root");
const newRootTurn = ProviderTurnId.make("provider-turn:transfer:new-root");
const ids = (name: string) => ({
  node: NodeId.make(`node:transfer:${name}`),
  child: ThreadId.make(`thread:transfer:${name}`),
  provider: ProviderThreadId.make(`provider-thread:transfer:${name}`),
  turn: ProviderTurnId.make(`provider-turn:transfer:${name}`),
  item: TurnItemId.make(`item:transfer:${name}`),
});
const target = ids("target");
const sibling = ids("sibling");

function subagent(task = target, owner = old, status: "running" | "completed" = "running") {
  return {
    type: "subagent.updated",
    driver,
    parentProviderThreadId: parentProvider,
    subagent: {
      id: task.node,
      threadId: parent,
      runId: owner.runId,
      parentNodeId: NodeId.make(`node:${owner.runId}:root`),
      origin: "provider_native",
      createdBy: "agent",
      driver,
      providerInstanceId: instanceId,
      providerThreadId: task.provider,
      childThreadId: task.child,
      nativeTaskRef: null,
      prompt: "Audit",
      title: "Audit",
      model: null,
      status,
      result: null,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      updatedAt: now,
    },
  } satisfies Extract<ProviderAdapterV2Event, { type: "subagent.updated" }>;
}

function providerThread(task = target, updatedAt = now) {
  return {
    type: "provider_thread.updated",
    driver,
    providerThread: {
      id: task.provider,
      driver,
      providerInstanceId: instanceId,
      providerSessionId: sessionId,
      appThreadId: task.child,
      ownerNodeId: task.node,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt,
    },
  } satisfies Extract<ProviderAdapterV2Event, { type: "provider_thread.updated" }>;
}

function providerTurn(task = target, status: "running" | "completed" = "running") {
  return {
    type: "provider_turn.updated",
    driver,
    threadId: task.child,
    providerTurn: {
      id: task.turn,
      providerThreadId: task.provider,
      nodeId: task.node,
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
    },
  } satisfies Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }>;
}

function item(task = target, status: "running" | "completed" = "running", owner = old) {
  const row = subagent(task, owner).subagent;
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: task.item,
      threadId: parent,
      runId: owner.runId,
      nodeId: task.node,
      providerThreadId: parentProvider,
      providerTurnId: oldRootTurn,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "subagent",
      status,
      title: row.title,
      subagentId: task.node,
      origin: row.origin,
      driver,
      providerInstanceId: instanceId,
      childThreadId: task.child,
      prompt: row.prompt,
      result: null,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      updatedAt: now,
    },
  } satisfies Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>;
}

function childCommand(status: "running" | "completed") {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: TurnItemId.make("item:transfer:child-command"),
      threadId: target.child,
      runId: null,
      nodeId: target.node,
      providerThreadId: target.provider,
      providerTurnId: target.turn,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      type: "command_execution",
      status,
      title: "Background check",
      input: "sleep 300",
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      updatedAt: now,
    },
  } satisfies Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>;
}

function terminal(owner = old): ProviderAdapterV2Event {
  return {
    type: "turn.terminal",
    driver,
    providerThreadId: parentProvider,
    providerTurnId: owner === old ? oldRootTurn : newRootTurn,
    runOrdinal: owner === old ? 1 : 2,
    status: "completed",
    failure: null,
    threadDisposition: "reusable",
  };
}

function marker() {
  return {
    type: "message.updated",
    driver,
    message: {
      id: MessageId.make("message:transfer:old-marker"),
      threadId: parent,
      runId: old.runId,
      nodeId: NodeId.make(`node:${old.runId}:root`),
      role: "user",
      text: "Sibling still owns the old subscription",
      attachments: [],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
    },
  } satisfies ProviderAdapterV2Event;
}

type Delivery = {
  readonly event: ProviderAdapterV2Event;
  readonly processed: Deferred.Deferred<void>;
};

// Two independent subscriptions on the same mocked provider runtime. The
// inner stream finalizer acknowledges consumption, including the last event
// before takeUntil closes a subscription, without sleeps or polling.
function twoSubscriptions(
  inherited: ReadonlyArray<RunExecutionService.InheritedBackgroundTurnItemRoute> = [],
  relatedThreadIds: ReadonlyArray<ThreadId> = [target.child, sibling.child],
  oldPendingBackgroundWork?: Effect.Effect<boolean>,
) {
  return Effect.gen(function* () {
    const persisted = yield* Ref.make<ReadonlyArray<OrchestrationV2StoredEvent>>([]);
    const closed = yield* Ref.make<ReadonlyArray<RunId>>([]);
    const oldClosed = yield* Deferred.make<void>();
    const newClosed = yield* Deferred.make<void>();
    const oldQueue = yield* Queue.unbounded<Delivery>();
    const newQueue = yield* Queue.unbounded<Delivery>();
    const write = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Ref.modify(persisted, (current) => {
        const stored = events.map((event, index) => ({
          sequence: current.length + index + 1,
          commandId: null,
          event,
        }));
        return [stored, [...current, ...stored]];
      });
    const sink = Layer.mock(EventSink.EventSinkV2)({
      write: ({ events }) => write(events),
      writeWithEffects: ({ events }) => write(events),
      writeIfRunCurrent: ({ events }) =>
        write(events).pipe(Effect.map((storedEvents) => ({ committed: true, storedEvents }))),
      writeIfProviderThreadOwner: ({ events }) =>
        write(events).pipe(Effect.map((storedEvents) => ({ committed: true, storedEvents }))),
    });
    const normalization = ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sink,
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getPendingNativeUserInputs: () =>
              Effect.succeed({ nodes: [], turnItems: [], runtimeRequests: [] }),
          }),
          Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
        ),
      ),
    );
    const layer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sink,
          normalization,
          IdAllocator.layer,
          McpAppModelContext.layerEmpty,
          ServerSettings.layerTest(),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
        ),
      ),
    );
    const service = yield* RunExecutionService.RunExecutionServiceV2.pipe(Effect.provide(layer));
    for (const owner of [old, resumed]) {
      const queue = owner === old ? oldQueue : newQueue;
      yield* service.startRootRun({
        commandId: CommandId.make(`command:${owner.runId}`),
        appThread: { id: parent } as OrchestrationV2AppThread,
        providerSessionId: sessionId,
        session: {
          ...(owner === old && oldPendingBackgroundWork !== undefined
            ? {
                hasPendingBackgroundWorkForThread: () => oldPendingBackgroundWork,
              }
            : {}),
          events: Stream.empty,
          subscribeEvents: Effect.succeed({
            events: Stream.fromQueue(queue).pipe(
              Stream.flatMap(({ event, processed }) =>
                Stream.succeed(event).pipe(Stream.ensuring(Deferred.succeed(processed, undefined))),
              ),
            ),
            close: Ref.update(closed, (current) => [...current, owner.runId]).pipe(
              Effect.andThen(Deferred.succeed(owner === old ? oldClosed : newClosed, undefined)),
            ),
          }),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: owner.runId,
          threadId: parent,
          ordinal: owner === old ? 1 : 2,
          providerInstanceId: instanceId,
        } as OrchestrationV2Run,
        rootNode: { id: NodeId.make(`node:${owner.runId}:root`) } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`scope:${owner.runId}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          ...providerThread().providerThread,
          id: parentProvider,
          appThreadId: parent,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: owner.attemptId,
          providerTurnId: owner === old ? oldRootTurn : newRootTurn,
        } as OrchestrationV2RunAttempt,
        attemptId: owner.attemptId,
        providerTurnOrdinal: 1,
        relatedThreadIds: owner === old ? relatedThreadIds : [],
        loadInheritedBackgroundTurnItems: () => Effect.succeed(owner === old ? inherited : []),
        message: {
          messageId: MessageId.make(`message:${owner.runId}`),
          text: "Audit",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
        },
      });
    }
    const publish = (event: ProviderAdapterV2Event) =>
      Effect.gen(function* () {
        const ended = yield* Ref.get(closed);
        const deliveries = [];
        for (const [owner, queue] of [
          [old, oldQueue],
          [resumed, newQueue],
        ] as const) {
          if (ended.includes(owner.runId)) continue;
          const processed = yield* Deferred.make<void>();
          yield* Queue.offer(queue, { event, processed });
          deliveries.push(Deferred.await(processed));
        }
        yield* Effect.all(deliveries, { concurrency: "unbounded" });
      });
    return { publish, persisted, closed, oldClosed, newClosed };
  });
}

it.effect(
  "transfers Codex provider/runtime ownership and all child pins while preserving a live sibling",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* twoSubscriptions();
        for (const event of [
          subagent(),
          item(),
          providerThread(),
          providerTurn(),
          childCommand("running"),
          subagent(sibling),
          item(sibling),
          providerThread(sibling),
          providerTurn(sibling),
          terminal(),
        ])
          yield* test.publish(event);
        assert.deepEqual(yield* Ref.get(test.closed), []);
        yield* test.publish(subagent(target, resumed));
        const before = (yield* Ref.get(test.persisted)).length;
        const continued = {
          ...target,
          turn: ProviderTurnId.make("provider-turn:transfer:continued"),
        };
        const request = {
          type: "runtime_request.updated",
          driver,
          runtimeRequest: {
            id: RuntimeRequestId.make("request:transfer:child"),
            nodeId: target.node,
            providerTurnId: target.turn,
            nativeRequestRef: null,
            kind: "dynamic_tool_call",
            status: "pending",
            responseCapability: { type: "live", providerSessionId: sessionId },
            createdAt: now,
            resolvedAt: null,
          },
        } satisfies ProviderAdapterV2Event;
        const afterTransfer = [
          providerThread(target, DateTime.add(now, { seconds: 1 })),
          providerTurn(),
          providerTurn(continued),
          request,
          {
            ...request,
            threadId: target.child,
            runtimeRequest: {
              ...request.runtimeRequest,
              id: RuntimeRequestId.make("request:transfer:continued-child"),
              providerTurnId: continued.turn,
            },
          },
          childCommand("completed"),
        ];
        for (const event of afterTransfer) yield* test.publish(event);
        const transferred = (yield* Ref.get(test.persisted))
          .slice(before)
          .map((stored) => stored.event);
        assert.deepEqual(
          transferred.map((event) => event.type),
          [
            "provider-thread.updated",
            "provider-turn.updated",
            "provider-turn.updated",
            "runtime-request.updated",
            "runtime-request.updated",
            "turn-item.updated",
          ],
        );
        for (const event of transferred)
          assert.equal(
            event.runId,
            resumed.runId,
            "only the resuming run persists transferred child events",
          );
        yield* test.publish(marker());
        for (const event of [
          providerTurn(sibling, "completed"),
          subagent(sibling, old, "completed"),
          item(sibling, "completed"),
        ])
          yield* test.publish(event);
        yield* Deferred.await(test.oldClosed);
        const oldEvents = (yield* Ref.get(test.persisted)).map((stored) => stored.event);
        assert.lengthOf(
          oldEvents.filter(
            (event) => event.type === "message.updated" && event.payload.id === marker().message.id,
          ),
          1,
        );
        for (const event of oldEvents.filter(
          (event) =>
            (event.type === "provider-turn.updated" && event.payload.id === sibling.turn) ||
            (event.type === "subagent.updated" && event.payload.id === sibling.node) ||
            (event.type === "turn-item.updated" && event.payload.id === sibling.item),
        ))
          assert.equal(event.runId, old.runId);
        assert.lengthOf(
          oldEvents.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.id === sibling.turn &&
              event.payload.status === "completed",
          ),
          1,
        );
        assert.deepEqual(yield* Ref.get(test.closed), [old.runId]);
        for (const event of [
          providerTurn(target, "completed"),
          providerTurn(continued, "completed"),
          subagent(target, resumed, "completed"),
          terminal(resumed),
        ])
          yield* test.publish(event);
        yield* Deferred.await(test.newClosed);
        assert.deepEqual(yield* Ref.get(test.closed), [old.runId, resumed.runId]);
      }),
    ),
);

function selectedInheritedSubagents() {
  const prior = { ...old, runId: RunId.make("run:transfer:prior") };
  const inherited = RunExecutionService.selectInheritedBackgroundTurnItems({
    threadId: parent,
    currentProviderThreadId: parentProvider,
    currentRunOrdinal: 2,
    runs: [
      {
        id: prior.runId,
        threadId: parent,
        ordinal: 1,
        status: "interrupted",
      } as OrchestrationV2Run,
    ],
    turnItems: [item(target, "running", prior).turnItem, item(sibling, "running", prior).turnItem],
  });
  return { prior, inherited };
}

it.effect.each([true, false])(
  "releases inherited subagent pins and routes (owns child threads: %s)",
  (ownsChildren) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { prior, inherited } = selectedInheritedSubagents();
        const test = yield* twoSubscriptions(
          inherited,
          ownsChildren ? [target.child, sibling.child] : [],
        );
        yield* test.publish(terminal());
        yield* test.publish(subagent(target, resumed));
        const before = (yield* Ref.get(test.persisted)).length;
        yield* test.publish(item(target, "running", prior));
        assert.lengthOf(
          yield* Ref.get(test.persisted),
          before,
          "revocation removes inherited routing as well as the pin",
        );
        yield* test.publish(marker());
        yield* test.publish(item(sibling, "completed", prior));
        yield* Deferred.await(test.oldClosed);
        assert.deepEqual(yield* Ref.get(test.closed), [old.runId]);
        const events = (yield* Ref.get(test.persisted)).map((stored) => stored.event);
        assert.lengthOf(
          events.filter(
            (event) => event.type === "message.updated" && event.payload.id === marker().message.id,
          ),
          1,
        );
        assert.lengthOf(
          events.filter(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.id === sibling.item &&
              event.payload.status === "completed",
          ),
          1,
        );
        yield* test.publish(subagent(target, resumed, "completed"));
        yield* test.publish(terminal(resumed));
        yield* Deferred.await(test.newClosed);
      }),
    ),
);

it.effect.each(["parent", "provider session"] as const)(
  "keeps inherited-only pins and routes on a transfer with the wrong %s",
  (mismatch) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { prior, inherited } = selectedInheritedSubagents();
        const test = yield* twoSubscriptions(inherited, []);
        yield* test.publish(terminal());
        const transfer = subagent(target, resumed);
        yield* test.publish(
          mismatch === "parent"
            ? {
                ...transfer,
                subagent: {
                  ...transfer.subagent,
                  threadId: ThreadId.make("thread:transfer:wrong-parent"),
                },
              }
            : {
                ...transfer,
                parentProviderThreadId: ProviderThreadId.make(
                  "provider-thread:transfer:wrong-parent",
                ),
              },
        );
        yield* test.publish(item(sibling, "completed", prior));
        yield* test.publish(marker());
        assert.deepEqual(
          yield* Ref.get(test.closed),
          [],
          "the inherited target must still pin the old subscription before any item replay",
        );
        assert.lengthOf(
          (yield* Ref.get(test.persisted)).filter(
            ({ event }) =>
              event.type === "message.updated" && event.payload.id === marker().message.id,
          ),
          1,
        );
        const before = (yield* Ref.get(test.persisted)).length;
        yield* test.publish(item(target, "running", prior));
        const stale = (yield* Ref.get(test.persisted)).slice(before).map((stored) => stored.event);
        assert.lengthOf(stale, 1, "invalid evidence must preserve the target's inherited route");
        assert.equal(stale[0]?.type, "turn-item.updated");
        assert.equal(stale[0]?.runId, prior.runId);
        yield* test.publish(transfer);
        yield* Deferred.await(test.oldClosed);
        assert.deepEqual(
          yield* Ref.get(test.closed),
          [old.runId],
          "valid transfer releases the final inherited-only pin",
        );
        yield* test.publish(subagent(target, resumed, "completed"));
        yield* test.publish(terminal(resumed));
        yield* Deferred.await(test.newClosed);
      }),
    ),
);

it.effect(
  "does not recheck ingestion lifecycle for a transfer when the subscriber holds no target work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const probes = yield* Ref.make(0);
        const pending = yield* Ref.make(true);
        const test = yield* twoSubscriptions(
          [],
          [],
          Ref.update(probes, (count) => count + 1).pipe(Effect.andThen(Ref.get(pending))),
        );
        yield* test.publish(terminal());
        assert.equal(yield* Ref.get(probes), 1);
        yield* test.publish(subagent(target, resumed));
        assert.equal(
          yield* Ref.get(probes),
          1,
          "unheld transfer must not trigger a stop/roster check",
        );
        assert.deepEqual(yield* Ref.get(test.closed), []);
        yield* Ref.set(pending, false);
        yield* test.publish(marker());
        yield* Deferred.await(test.oldClosed);
        assert.equal(yield* Ref.get(probes), 2);
        yield* test.publish(subagent(target, resumed, "completed"));
        yield* test.publish(terminal(resumed));
        yield* Deferred.await(test.newClosed);
      }),
    ),
);

it.each(["node", "provider-thread", "carried", "shared-root", "conflicting-row"] as const)(
  "releases only child provider identities learned through %s evidence",
  (evidence) => {
    const task = evidence === "shared-root" ? { ...target, provider: parentProvider } : target;
    let state = RunExecutionService.makeProviderEventRoutingState({
      identity: old,
      providerTurnId: oldRootTurn,
      relatedThreadIds: [target.child, sibling.child],
      relatedProviderThreadIds: evidence === "carried" ? [task.provider] : [],
    });
    const apply = (event: ProviderAdapterV2Event) => {
      const [accepted, next] = RunExecutionService.routeProviderEvent(event, old, state);
      assert.isTrue(accepted);
      state = next;
    };
    apply(providerThread(sibling));
    apply(providerTurn(sibling));
    if (evidence === "provider-thread") {
      apply(providerThread(task));
    } else if (evidence !== "carried") {
      apply({
        type: "node.updated",
        driver,
        node: {
          id: task.node,
          threadId: task.child,
          runId: null,
          parentNodeId: null,
          rootNodeId: task.node,
          kind: "root_turn",
          status: "running",
          countsForRun: false,
          providerThreadId: task.provider,
          providerTurnId: task.turn,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
    }
    const turn = providerTurn(task);
    // A provider-only snapshot must retain its association even before node
    // evidence arrives. Shared root sessions instead name the child explicitly.
    apply(
      evidence === "shared-root"
        ? turn
        : { type: turn.type, driver, providerTurn: turn.providerTurn },
    );
    const transfer = subagent(task, resumed);
    const [accepted, after] = RunExecutionService.routeProviderEvent(
      evidence === "conflicting-row"
        ? { ...transfer, subagent: { ...transfer.subagent, providerThreadId: sibling.provider } }
        : transfer,
      old,
      state,
    );
    assert.isFalse(accepted);
    const accepts = (event: ProviderAdapterV2Event) =>
      RunExecutionService.routeProviderEvent(event, old, after)[0];
    if (evidence !== "shared-root") {
      const update = providerThread(task);
      assert.isFalse(
        accepts({ ...update, providerThread: { ...update.providerThread, appThreadId: null } }),
      );
    }
    assert.isFalse(accepts({ type: turn.type, driver, providerTurn: turn.providerTurn }));
    assert.isFalse(
      accepts({
        type: "runtime_request.updated",
        driver,
        runtimeRequest: {
          id: RuntimeRequestId.make("request:transfer:late"),
          nodeId: task.node,
          providerTurnId: task.turn,
          nativeRequestRef: null,
          kind: "dynamic_tool_call",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: sessionId },
          createdAt: now,
          resolvedAt: null,
        },
      }),
    );
    const root = providerThread({ ...task, provider: parentProvider });
    assert.isTrue(
      accepts({ ...root, providerThread: { ...root.providerThread, appThreadId: null } }),
    );
    assert.isTrue(
      accepts({
        type: "provider_turn.updated",
        driver,
        providerTurn: { ...turn.providerTurn, id: oldRootTurn, providerThreadId: parentProvider },
      }),
    );
    assert.isTrue(accepts(providerThread(sibling)));
    assert.isTrue(accepts(providerTurn(sibling)));
  },
);

describe("settled transfer cannot leave a child ownerless", () => {
  it.each(["completed", "failed", "cancelled", "interrupted", "idle"] as const)(
    "does not revoke or adopt a %s reassignment",
    (status) => {
      const event = subagent(target, resumed);
      const settled = { ...event, subagent: { ...event.subagent, status } };
      const [oldAccepted, oldState] = RunExecutionService.routeProviderEvent(
        settled,
        old,
        RunExecutionService.makeProviderEventRoutingState({
          identity: old,
          providerTurnId: oldRootTurn,
          relatedThreadIds: [target.child],
        }),
      );
      const [, newState] = RunExecutionService.routeProviderEvent(
        settled,
        resumed,
        RunExecutionService.makeProviderEventRoutingState({
          identity: resumed,
          providerTurnId: newRootTurn,
        }),
      );
      assert.isFalse(oldAccepted);
      assert.isTrue(RunExecutionService.routeProviderEvent(providerThread(), old, oldState)[0]);
      assert.isFalse(
        RunExecutionService.routeProviderEvent(providerThread(), resumed, newState)[0],
      );
    },
  );
});
