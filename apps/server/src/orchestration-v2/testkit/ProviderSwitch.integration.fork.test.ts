import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { forkSupersedes } from "../../../../../scripts/lib/fork-supersedes.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

forkSupersedes({
  upstream:
    "apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts > interrupts the handoff tool call that releases its own session",
  reason:
    "Deliberate handoff interrupts the provider turn and completes its run instead of reporting a provider failure; tool cleanup and the absence of stranded background work still hold.",
  commit: "27f465f50f80890335229c00bea09dee0df739f2",
});
it.live("completes the handoff run and interrupts its tool when it releases its own session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const key = "handoff-cuts-off-tool-call";
      const worktreePath = yield* checkpointWorkspace(key);
      const toolCallId = TurnItemId.make(`turn-item:${key}`);
      const threadId = ThreadId.make(`thread:${key}`);
      const driver = ProviderDriverKind.make("claudeAgent");
      const instanceId = CLAUDE_MODEL_SELECTION.instanceId;
      const capabilities = ClaudeProviderCapabilitiesV2;
      const unused = () =>
        Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail: "unused" }));
      const adapter = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: (input) =>
          Effect.gen(function* () {
            const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            const now = yield* DateTime.now;
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
                model: CLAUDE_MODEL_SELECTION.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              backgroundTasksEndWithProcess: true,
              events: Stream.fromPubSub(events),
              ensureThread: (request) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${key}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: request.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: key, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (request) =>
                Effect.gen(function* () {
                  const providerTurnId = ProviderTurnId.make(`provider-turn:${key}`);
                  const startedAt = yield* DateTime.now;
                  yield* PubSub.publish(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: request.providerThread.id,
                      nodeId: request.rootNodeId,
                      runAttemptId: request.attemptId,
                      nativeTurnRef: null,
                      ordinal: request.runOrdinal,
                      status: "running",
                      startedAt,
                      completedAt: null,
                    },
                  });
                  yield* PubSub.publish(events, {
                    type: "turn_item.updated",
                    driver,
                    turnItem: {
                      id: toolCallId,
                      threadId: request.threadId,
                      runId: request.runId,
                      nodeId: request.rootNodeId,
                      providerThreadId: request.providerThread.id,
                      providerTurnId,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 1,
                      status: "running",
                      title: null,
                      startedAt,
                      completedAt: null,
                      updatedAt: startedAt,
                      type: "dynamic_tool",
                      toolName: "mcp__t3-code__t3_worktree_handoff",
                      input: {},
                    },
                  });
                }),
              steerTurn: () => Effect.void,
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: unused,
              rollbackThread: unused,
              forkThread: unused,
            } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
          }),
      } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const awaitEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${key}:create`),
          threadId,
          projectId: ProjectId.make(`project:${key}`),
          title: "Tool call releases its session",
          modelSelection: CLAUDE_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const toolCallRunning = yield* awaitEvent(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === toolCallId &&
            event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${key}:message`),
          threadId,
          messageId: MessageId.make(`message:${key}`),
          text: "Release this session",
          attachments: [],
          modelSelection: CLAUDE_MODEL_SELECTION,
          dispatchMode: { type: "start_immediately" },
        });
        yield* Fiber.join(toolCallRunning);
        const runCompleted = yield* awaitEvent(
          (event) => event.type === "run.updated" && event.payload.status === "completed",
        );
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`command:${key}:release`),
          threadId,
          branch: `t3/${key}`,
          worktreePath,
          expectedWorktreePath: null,
        });
        yield* worker.drain();
        yield* Fiber.join(runCompleted);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const toolCall = projection.turnItems.find((item) => item.id === toolCallId);
        assert.equal(toolCall?.status, "interrupted");
        assert.isNotNull(toolCall?.completedAt);
        assert.equal(projection.runs.at(-1)?.status, "completed");
        assert.deepEqual(
          derivePendingBackgroundWork({
            latestRun: projection.runs.at(-1),
            providerThreads: projection.providerThreads,
            turnItems: projection.turnItems,
            activeProviderThreadId: projection.thread.activeProviderThreadId,
            runs: projection.runs,
          }),
          [],
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: key },
            ProviderAdapterRegistry.layerFromAdapters([adapter]),
          ),
        ),
      );
    }),
  ),
);
