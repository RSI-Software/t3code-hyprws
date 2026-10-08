import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import {
  allowsInitialConversationTitleFork,
  appendConversationForkContextFork,
  conversationForkContextFork,
  withoutConversationForkNoticeFork,
} from "./conversationFork.fork.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const sourceId = ThreadId.make("fork-isolation-source");
const forkId = ThreadId.make("fork-isolation-target");
const cutoffRunId = RunId.make("fork-isolation-cutoff");
const providerThreadId = ProviderThreadId.make("fork-isolation-native-thread");
const projectId = ProjectId.make("fork-isolation-project");
const sourceChildId = NodeId.make("fork-isolation-source-child");
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = layerWithRegistry(
  { name: "conversation-fork-isolation" },
  ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Effects remain paused for fork-state assertions"),
    },
  ]),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
const layer = Layer.mergeAll(
  layerOrchestrator,
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
);

it.effect.each([false, true])(
  "preserves a fork title on the first send (manual rename: %s) and resets source controls",
  (rename) =>
    Effect.gen(function* () {
      const threads = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const now = yield* DateTime.now;
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceId,
        projectId,
        title: "Source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: "feature/shared",
        worktreePath: "/tmp/shared-fork-checkout",
        createdBy: "user",
        creationSource: "web",
      });
      const original = (yield* threads.getThreadProjection(sourceId)).thread;
      const linkedPr = {
        projectId,
        repository: "RSI-Software/t3code-hyprws",
        number: 42,
        url: "https://github.com/RSI-Software/t3code-hyprws/pull/42",
      };
      const source: OrchestrationV2AppThread = {
        ...original,
        linkedPullRequest: linkedPr,
        branchPullRequest: linkedPr,
        pullRequests: [
          {
            host: "github.com",
            repository: linkedPr.repository,
            number: 42,
            url: linkedPr.url,
            source: "manual",
            linkedAt: DateTime.formatIso(now),
            snapshot: null,
            stack: null,
            watch: {
              startedAt: DateTime.formatIso(now),
              headSha: "abc",
              failedChecks: [],
              passed: false,
              passedChecks: [],
              remarksThrough: DateTime.formatIso(now),
              remarkIds: [],
              conflicting: false,
              wakes: 0,
            },
          },
        ],
        issues: [
          {
            host: "github.com",
            repository: linkedPr.repository,
            number: 43,
            url: "https://github.com/RSI-Software/t3code-hyprws/issues/43",
            source: "agent",
            linkedAt: DateTime.formatIso(now),
            snapshot: null,
          },
        ],
        limitRecovery: { runId: cutoffRunId, resetAt: DateTime.formatIso(now), autoResume: true },
        pinnedAt: now,
        pinOrderKey: "a0",
        activeOrderKey: "a1",
        autoSettleDisabledAt: now,
        unsettledAt: now,
        titleRegeneration: { requestId: CommandId.make("source-title-request"), startedAt: now },
        rollbackRequestId: CommandId.make("source-rollback"),
        rollbackFailure: {
          requestId: CommandId.make("source-rollback"),
          message: "Source failure",
        },
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("source-controls"),
            type: "thread.metadata-updated",
            threadId: sourceId,
            occurredAt: now,
            payload: source,
          },
          {
            id: EventId.make("source-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("codex"),
                nativeId: "native-source",
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("source-run"),
            type: "run.created",
            threadId: sourceId,
            runId: cutoffRunId,
            occurredAt: now,
            payload: {
              id: cutoffRunId,
              threadId: sourceId,
              ordinal: 1,
              providerInstanceId: instanceId,
              modelSelection,
              providerThreadId,
              userMessageId: MessageId.make("historical-source-message"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              queuePosition: null,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: EventId.make("source-child"),
            type: "subagent.updated",
            threadId: sourceId,
            runId: cutoffRunId,
            nodeId: sourceChildId,
            occurredAt: now,
            payload: {
              id: sourceChildId,
              threadId: sourceId,
              runId: cutoffRunId,
              parentNodeId: NodeId.make("fork-isolation-source-root"),
              origin: "app_owned",
              createdBy: "agent",
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: instanceId,
              providerThreadId: null,
              childThreadId: null,
              nativeTaskRef: null,
              prompt: "Source-owned child work",
              title: "Source child",
              model: null,
              completionWake: "always",
              completionDelivery: { state: "claimed", observedByRunId: null },
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          },
        ],
      });
      const sourceBefore = (yield* threads.getThreadProjection(sourceId)).thread;
      yield* threads.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-source"),
        sourceThreadId: sourceId,
        targetThreadId: forkId,
        sourcePoint: { type: "run", runId: cutoffRunId },
        title: "Chosen fork title",
        createdBy: "user",
        creationSource: "mobile",
      });
      const forkProjection = yield* threads.getThreadProjection(forkId);
      // Children stay owned by the source; the fork cannot wake or resume them.
      assert.deepEqual(forkProjection.subagents, []);
      const fork = forkProjection.thread;
      assert.equal(fork.branch, source.branch);
      assert.equal(fork.worktreePath, source.worktreePath);
      assert.deepEqual(fork.modelSelection, source.modelSelection);
      assert.equal(fork.runtimeMode, source.runtimeMode);
      assert.equal(fork.interactionMode, source.interactionMode);
      assert.isNull(fork.linkedPullRequest);
      assert.deepEqual(fork.pullRequests, []);
      assert.deepEqual(fork.issues ?? [], []);
      assert.isNull(fork.branchPullRequest);
      for (const field of [
        "limitRecovery",
        "pinnedAt",
        "pinOrderKey",
        "activeOrderKey",
        "autoSettleDisabledAt",
        "unsettledAt",
        "titleRegeneration",
        "rollbackFailure",
      ] as const)
        assert.isNull(fork[field]);
      assert.isUndefined(fork.rollbackRequestId);
      assert.isUndefined(fork.checkoutMove);
      assert.deepEqual(fork.forkedFrom, { type: "run", threadId: sourceId, runId: cutoffRunId });
      assert.equal(fork.lineage.parentThreadId, sourceId);
      const expectedTitle = rename ? "Manual fork title" : "Chosen fork title";
      if (rename)
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename-fork"),
          threadId: forkId,
          title: expectedTitle,
        });
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send-fork"),
        threadId: forkId,
        messageId: MessageId.make("fork-first-message"),
        text: "hello.",
        titleSeed: "hello.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const after = yield* threads.getThreadProjection(forkId);
      assert.equal(after.thread.title, expectedTitle);
      assert.isNull(after.thread.titleRegeneration);
      const titleEffects = (yield* outbox.listByCommandId(CommandId.make("send-fork"))).filter(
        (effect) => effect.request.type === "thread-title.generate",
      );
      assert.deepEqual(titleEffects, []);
      const sourceAfter = yield* threads.getThreadProjection(sourceId);
      assert.deepEqual(sourceAfter.thread, sourceBefore);
      assert.deepEqual(
        sourceAfter.subagents.map((child) => child.id),
        [sourceChildId],
      );
      // A child the fork spawns is the fork's; a source-owned child cannot be resumed from it.
      const forkRun = after.runs[0]!;
      const delegate = (round: string, continueTaskId?: NodeId) =>
        threads.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`fork-delegate-${round}`),
          parentThreadId: forkId,
          parentRunId: forkRun.id,
          parentNodeId: forkRun.rootNodeId!,
          task: "Fork-owned child work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          ...(continueTaskId === undefined ? {} : { continueTaskId }),
          createdBy: "agent",
          creationSource: "mcp",
        });
      yield* delegate("spawn");
      const forkChildren = (yield* threads.getThreadProjection(forkId)).subagents;
      assert.equal(forkChildren.length, 1);
      assert.equal(forkChildren[0]!.threadId, forkId);
      assert.deepEqual(
        (yield* threads.getThreadProjection(sourceId)).subagents.map((child) => child.id),
        [sourceChildId],
      );
      const resumeSourceChild = yield* delegate("resume-source", sourceChildId).pipe(Effect.flip);
      assert.include(
        String(resumeSourceChild.cause),
        "is not an app-owned delegated task of thread",
      );
      const notice = conversationForkContextFork(after.thread, true);
      assert.equal(conversationForkContextFork(after.thread, false), "");
      for (const id of [sourceId, forkId, cutoffRunId]) assert.include(notice, id);
      assert.include(notice, "historical source activity");
      assert.include(notice, "shares the source checkout");
      assert.include(appendConversationForkContextFork("Portable history", notice, false), notice);
      assert.equal(appendConversationForkContextFork("", notice, true), "");
      // Replays compare the turn text recorded before the notice existed.
      assert.equal(
        withoutConversationForkNoticeFork(`${notice}\n\nUser message:\nhello.`),
        "hello.",
      );
      assert.equal(
        withoutConversationForkNoticeFork(`Portable history\n\n${notice}\n\nUser message:\nhello.`),
        "Portable history\n\nUser message:\nhello.",
      );
      // A subagent thread records its parent node in forkedFrom but is no conversation fork.
      const subagentThread: OrchestrationV2AppThread = {
        ...after.thread,
        lineage: { ...after.thread.lineage, relationshipToParent: "subagent" },
        forkedFrom: { type: "node", nodeId: sourceChildId },
      };
      assert.equal(conversationForkContextFork(subagentThread, true), "");
      assert.isTrue(allowsInitialConversationTitleFork(subagentThread));
    }).pipe(Effect.provide(layer)),
);
