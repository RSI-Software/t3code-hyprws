// Fork-only (upstream-fixes): a conversation fork's notice reaches every native thread that
// serves the fork, including after a first `/compact` and after a native-thread replacement.
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION } from "./fixtures/shared.ts";
import { layerWithRegistry } from "./ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const projectId = ProjectId.make("project:fork-notice");
const sourceId = ThreadId.make("thread:fork-notice-source");
const forkId = ThreadId.make("thread:fork-notice-fork");
const NOTICE = "[T3 Code conversation fork:";

interface SentTurn {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly nativeThreadId: string | null;
}

/** Records what each turn sends; resume fails while `failResume` is set, forcing a fresh native thread. */
function makeAdapter(sent: Ref.Ref<ReadonlyArray<SentTurn>>, failResume: Ref.Ref<boolean>) {
  const generation = { value: 0 };
  return {
    instanceId: CLAUDE_MODEL_SELECTION.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: CLAUDE_MODEL_SELECTION.model,
          capabilities: ClaudeProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const nativeThread = (threadId: ThreadId, existing?: OrchestrationV2ProviderThread) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            const nativeId = `native:${threadId}:${generation.value++}`;
            return {
              id: existing?.id ?? ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              contextUsage: null,
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            } satisfies OrchestrationV2ProviderThread;
          });
        const startTurn = (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            yield* Ref.update(sent, (turns) => [
              ...turns,
              {
                threadId: turnInput.threadId,
                text: turnInput.message.text,
                nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
              },
            ]);
            const at = yield* DateTime.now;
            const providerTurnId = ProviderTurnId.make(
              `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
            );
            const turnEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
              {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turnInput.providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                    strength: "strong",
                  },
                  ordinal: turnInput.runOrdinal,
                  status: "completed",
                  startedAt: at,
                  completedAt: at,
                },
              },
              {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: TurnItemId.make(`turn-item:${turnInput.threadId}:${turnInput.runOrdinal}`),
                  threadId: turnInput.threadId,
                  runId: turnInput.runId,
                  nodeId: turnInput.rootNodeId,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: turnInput.runOrdinal * 100 + 1,
                  status: "completed",
                  title: null,
                  startedAt: at,
                  completedAt: at,
                  updatedAt: at,
                  type: "assistant_message",
                  messageId: MessageId.make(
                    `message:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                  ),
                  text: `response ${turnInput.runOrdinal}`,
                  streaming: false,
                },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                runOrdinal: turnInput.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              },
            ];
            for (const event of turnEvents) yield* PubSub.publish(events, event);
          });
        const unused = (detail: string) =>
          Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
        return {
          instanceId: CLAUDE_MODEL_SELECTION.instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (input) => nativeThread(input.threadId, input.existingProviderThread),
          resumeThread: ({ providerThread }) =>
            Effect.flatMap(Ref.getAndSet(failResume, false), (fail) =>
              fail ? unused("simulated native resume failure") : Effect.succeed(providerThread),
            ),
          forkThread: (input) => nativeThread(input.targetThreadId),
          startTurn,
          compactThread: startTurn,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unused("readThreadSnapshot"),
          rollbackThread: () => unused("rollbackThread"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
}

const scenario = (
  name: string,
  body: (input: {
    readonly send: (threadId: ThreadId, text: string) => Effect.Effect<void>;
    readonly sentTo: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<SentTurn>>;
    readonly replaceNativeThread: (legacy: boolean) => Effect.Effect<void>;
  }) => Effect.Effect<void>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const sent = yield* Ref.make<ReadonlyArray<SentTurn>>([]);
      const failResume = yield* Ref.make(false);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const ordinals = new Map<ThreadId, number>();
        const send = Effect.fn("ConversationForkNoticeTest.send")(function* (
          threadId: ThreadId,
          text: string,
        ) {
          const ordinal = (ordinals.get(threadId) ?? 0) + 1;
          ordinals.set(threadId, ordinal);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${threadId}:send:${ordinal}`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:${ordinal}`),
            createdBy: "user",
            creationSource: "web",
            text,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "start_immediately" },
          });
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.threadId === threadId &&
                event.payload.ordinal === ordinal &&
                (event.payload.status === "completed" || event.payload.status === "failed"),
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
            "completed",
          );
        });
        // The next turn's resume fails, so T3 starts a new native thread. `legacy` strips native
        // identity from accepted attempts, as rows written before attempts recorded it.
        const replaceNativeThread = Effect.fn("ConversationForkNoticeTest.replace")(function* (
          legacy: boolean,
        ) {
          const fork = yield* orchestrator.getThreadProjection(forkId);
          const providerSessionId = fork.providerThreads.at(0)?.providerSessionId;
          if (providerSessionId == null) return yield* Effect.die("fork has no provider session");
          yield* orchestrator.dispatch({
            type: "provider-session.detach",
            commandId: CommandId.make("fork-notice:detach"),
            threadId: forkId,
            providerSessionId,
          });
          yield* worker.drain();
          if (legacy)
            yield* sink.write({
              events: fork.attempts.map(
                ({ nativeThreadId: _nativeThreadId, ...legacy }, index) => ({
                  id: EventId.make(`fork-notice:legacy-attempt:${index}`),
                  type: "run-attempt.updated" as const,
                  threadId: forkId,
                  occurredAt: fork.thread.createdAt,
                  payload: legacy,
                }),
              ),
            });
          yield* Ref.set(failResume, true);
        });

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("fork-notice:create"),
          threadId: sourceId,
          projectId,
          createdBy: "user",
          creationSource: "web",
          title: "Fork notice source",
          modelSelection: CLAUDE_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* send(sourceId, "Source request");
        const sourceRunId: RunId = (yield* orchestrator.getThreadProjection(sourceId)).runs[0]!.id;
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("fork-notice:fork"),
          sourceThreadId: sourceId,
          targetThreadId: forkId,
          sourcePoint: { type: "run", runId: sourceRunId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* body({
          send: (threadId, text) => Effect.orDie(send(threadId, text)),
          sentTo: (threadId) =>
            Ref.get(sent).pipe(
              Effect.map((turns) => turns.filter((turn) => turn.threadId === threadId)),
            ),
          replaceNativeThread: (legacy) => Effect.orDie(replaceNativeThread(legacy)),
        });
      }).pipe(
        Effect.provide(
          layerWithRegistry(
            {
              name,
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
              },
            },
            ProviderAdapterRegistry.layerFromAdapters([makeAdapter(sent, failResume)]),
          ),
        ),
      );
    }),
  );

describe("conversation fork notice", () => {
  // Checkpointing runs git against a real workspace.
  it.live("follows a first /compact on a fresh native thread, leaving the command unchanged", () =>
    scenario("fork-notice-compact", ({ send, sentTo, replaceNativeThread }) =>
      Effect.gen(function* () {
        // A fork's first /compact compacts its inherited history, so the notice waits for "First".
        yield* send(forkId, "/compact");
        yield* send(forkId, "First");
        yield* replaceNativeThread(false);
        yield* send(forkId, "/compact");
        yield* send(forkId, "After compact");
        yield* send(forkId, "Later");
        const [inherited, first, compact, next, later] = yield* sentTo(forkId);
        assert.equal(inherited!.text, "/compact");
        assert.equal(first!.nativeThreadId, inherited!.nativeThreadId);
        assert.include(first!.text, NOTICE);
        assert.notEqual(compact!.nativeThreadId, first!.nativeThreadId);
        assert.equal(compact!.text, "/compact");
        assert.equal(next!.nativeThreadId, compact!.nativeThreadId);
        assert.include(next!.text, NOTICE);
        assert.include(next!.text, `Current thread ID: ${forkId}`);
        assert.notInclude(later!.text, NOTICE);
      }),
    ),
  );

  it.live("reaches a replacement native thread despite legacy accepted attempts", () =>
    scenario("fork-notice-replacement", ({ send, sentTo, replaceNativeThread }) =>
      Effect.gen(function* () {
        yield* send(forkId, "First");
        yield* replaceNativeThread(true);
        yield* send(forkId, "On the replacement");
        yield* send(forkId, "Later");
        const [first, replacement, later] = yield* sentTo(forkId);
        assert.include(first!.text, NOTICE);
        assert.notEqual(replacement!.nativeThreadId, first!.nativeThreadId);
        assert.include(replacement!.text, NOTICE);
        assert.equal(later!.nativeThreadId, replacement!.nativeThreadId);
        assert.notInclude(later!.text, NOTICE);
      }),
    ),
  );
});
