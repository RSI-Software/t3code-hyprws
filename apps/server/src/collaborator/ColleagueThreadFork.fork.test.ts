import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ColleagueForkThreadInputFork,
  type OrchestrationV2ProviderSession,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION } from "../orchestration-v2/testkit/fixtures/shared.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ColleagueThreadFork from "./ColleagueThreadFork.fork.ts";

const driver = ProviderDriverKind.make("claudeAgent");

interface SentTurn {
  readonly text: string;
  readonly nativeThreadId: string | null;
}

/** Records each turn's prompt and the native thread it ran on, then completes the turn. */
function recordingAdapter(sent: Ref.Ref<ReadonlyArray<SentTurn>>) {
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
        const unused = (detail: string) =>
          Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            yield* Ref.update(sent, (turns) => [
              ...turns,
              {
                text: turn.message.text,
                nativeThreadId: turn.providerThread.nativeThreadRef?.nativeId ?? null,
              },
            ]);
            const at = yield* DateTime.now;
            const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.runOrdinal}`);
            yield* PubSub.publish(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native-turn:${turn.runOrdinal}`,
                  strength: "strong",
                },
                ordinal: turn.runOrdinal,
                status: "completed",
                startedAt: at,
                completedAt: at,
              },
            });
            yield* PubSub.publish(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThread.id,
              providerTurnId,
              runOrdinal: turn.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
          });
        return {
          instanceId: CLAUDE_MODEL_SELECTION.instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (input) =>
            Effect.map(DateTime.now, (createdAt) => ({
              id: input.existingProviderThread?.id ?? ProviderThreadId.make(`pt:${input.threadId}`),
              driver,
              providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${input.threadId}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              contextUsage: null,
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            })),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          forkThread: () => unused("forkThread"),
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

const threadId = ThreadId.make("thread:colleague-fork");
const input = (
  messages: ColleagueForkThreadInputFork["messages"],
): ColleagueForkThreadInputFork => ({
  threadId,
  projectId: ProjectId.make("project:colleague-fork"),
  title: "Plan the launch (fork)",
  modelSelection: CLAUDE_MODEL_SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
  origin: { environmentId: EnvironmentId.make("alex"), threadId: ThreadId.make("thread:alex") },
  hostName: "Alex",
  originTitle: "Plan the launch",
  messages,
  partial: false,
});

const scenario = (
  name: string,
  body: (forked: {
    readonly send: (text: string) => Effect.Effect<ReadonlyArray<SentTurn>>;
    readonly fork: (input: ColleagueForkThreadInputFork) => Effect.Effect<void>;
    readonly projection: () => ReturnType<
      Orchestrator.OrchestratorV2["Service"]["getThreadProjection"]
    > extends Effect.Effect<infer A, infer _E, infer _R>
      ? Effect.Effect<A>
      : never;
  }) => Effect.Effect<
    void,
    PlatformError.PlatformError,
    FileSystem.FileSystem | ServerConfig.ServerConfig
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(name);
      const sent = yield* Ref.make<ReadonlyArray<SentTurn>>([]);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const forks = yield* ColleagueThreadFork.ColleagueThreadForkFork;
        const send = (text: string) =>
          Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`colleague-fork:send:${text}`),
              threadId,
              messageId: MessageId.make(`colleague-fork:message:${text}`),
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
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
            return yield* Ref.get(sent);
          }).pipe(Effect.orDie);
        yield* body({
          send,
          fork: (forkInput) => forks.fork(forkInput).pipe(Effect.orDie),
          projection: () => orchestrator.getThreadProjection(threadId).pipe(Effect.orDie),
        });
      }).pipe(
        Effect.provide(
          ColleagueThreadFork.layerFromRuntime.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                ServerConfig.layerTest(cwd, { prefix: "t3-colleague-fork-" }),
                DocumentText.layer,
              ).pipe(Layer.provideMerge(NodeServices.layer)),
            ),
            Layer.provideMerge(
              layerWithRegistry(
                {
                  name,
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: { type: "readOnly" },
                  },
                },
                ProviderAdapterRegistry.layerFromAdapters([recordingAdapter(sent)]),
              ),
            ),
          ),
        ),
      );
    }),
  );

const at = (minute: number) => `2026-11-27T09:0${minute}:00.000Z`;

// Checkpointing runs git against a real workspace.
it.live("a forked thread's first message starts a fresh session holding the copied history", () =>
  scenario("colleague-fork-history", ({ send, fork, projection }) =>
    Effect.gen(function* () {
      yield* fork(
        input([
          { role: "user", text: "Remember the code word PELICAN.", createdAt: at(1) },
          { role: "assistant", text: "Noted: PELICAN.", createdAt: at(2) },
        ]),
      );
      // A retried fork writes nothing twice.
      yield* fork(input([{ role: "user", text: "A late copy", createdAt: at(3) }]));
      const forked = yield* projection();
      assert.equal(forked.thread.historyOrigin, "v1_import");
      assert.deepEqual(
        forked.visibleTurnItems.map(({ item }) =>
          item.type === "system_notice" ? item.colleagueOriginFork?.threadId : item.type,
        ),
        [ThreadId.make("thread:alex"), "user_message", "assistant_message"],
      );

      const [first] = yield* send("What was the code word?");
      assert.equal(first?.nativeThreadId, `native:${threadId}`);
      assert.include(first?.text ?? "", "Remember the code word PELICAN.");
      assert.include(first?.text ?? "", "Noted: PELICAN.");
      assert.isTrue((first?.text ?? "").endsWith("What was the code word?"));
    }),
  ),
);

it.live(
  "a person's copied line shows their words under their name; the agent reads who wrote it",
  () =>
    scenario("colleague-fork-authors", ({ send, fork, projection }) =>
      Effect.gen(function* () {
        yield* fork(
          input([
            { role: "user", text: "Ship it?", createdAt: at(1) },
            {
              role: "user",
              text: "Friday",
              createdAt: at(2),
              author: "Jordan",
              replyTo: { name: "Alex", text: "When?" },
            },
          ]),
        );
        const [, own, reply] = (yield* projection()).visibleTurnItems.map(({ item }) => item);
        assert.equal(own?.type === "user_message" ? own.text : null, "Ship it?");
        assert.isUndefined(own?.type === "user_message" ? own.context : null);
        assert.deepEqual(reply?.type === "user_message" ? reply.context?.collaboratorFork : null, {
          name: "Jordan",
          text: "Friday",
          replyTo: { name: "Alex", text: "When?" },
        });
        const [first] = yield* send("Recap");
        assert.include(first?.text ?? "", "[Jordan wrote the message below, in reply to Alex.]");
      }),
    ),
);

it.live("with no copy, the new thread only links to the original and says so", () =>
  scenario("colleague-fork-linked", ({ send, fork, projection }) =>
    Effect.gen(function* () {
      yield* fork(input([]));
      const forked = yield* projection();
      assert.notEqual(forked.thread.historyOrigin, "v1_import");
      const [notice] = forked.visibleTurnItems.map(({ item }) => item);
      assert.equal(notice?.type, "system_notice");
      assert.include(
        notice?.type === "system_notice" ? notice.message : "",
        "this thread starts empty and only links to the original",
      );
      const [first] = yield* send("Start fresh");
      assert.equal(first?.text, "Start fresh");
    }),
  ),
);

it.live("a fork claims the images it copied here and names the ones it could not", () =>
  scenario("colleague-fork-attachments", ({ fork, projection }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const pendingId = createPendingAttachmentId();
      yield* fs.makeDirectory(attachmentsDir, { recursive: true });
      yield* fs.writeFileString(`${attachmentsDir}/${pendingId}.png`, "png");
      yield* fork({
        ...input([
          {
            role: "user",
            text: "Here is the plan.\n\n[Not copied: spec.pdf]",
            createdAt: at(1),
            attachments: [
              {
                type: "image",
                id: ChatAttachmentId.make(pendingId),
                name: "plan.png",
                mimeType: "image/png",
                sizeBytes: 3,
              },
            ],
          },
        ]),
        missingAttachments: ["spec.pdf"],
      });
      const [notice, message] = (yield* projection()).visibleTurnItems.map(({ item }) => item);
      assert.include(
        notice?.type === "system_notice" ? notice.message : "",
        "Not copied from Alex: spec.pdf.",
      );
      const [image] = message?.type === "user_message" ? message.attachments : [];
      assert.equal(image?.name, "plan.png");
      assert.notEqual(image?.id, pendingId);
      const stored = image && resolveAttachmentPath({ attachmentsDir, attachment: image });
      assert.equal(stored ? yield* fs.readFileString(stored) : null, "png");
    }),
  ),
);
