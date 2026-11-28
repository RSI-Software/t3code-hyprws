// Fork-only (colleague-collab): forks a colleague's thread onto this machine from the client's copy
// of it. The new thread holds the copied messages as run-less `v1_import` history, which upstream
// hands to the first run's fresh provider session as context. A notice names the original. The
// client uploads each message's images and files here first; the fork claims them for the thread.
import {
  type ChatAttachment,
  ColleagueForkThreadErrorFork,
  type ColleagueForkThreadInputFork,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationMessageContext,
  type OrchestrationV2DomainEvent,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as AttachmentClaims from "../orchestration-v2/AttachmentClaims.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { layerEventSink } from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { replyQuote } from "./CollaboratorMessages.fork.ts";

export class ColleagueThreadForkFork extends Context.Service<
  ColleagueThreadForkFork,
  {
    readonly fork: (
      input: ColleagueForkThreadInputFork,
    ) => Effect.Effect<void, ColleagueForkThreadErrorFork>;
  }
>()("t3/collaborator/ColleagueThreadFork.fork/ColleagueThreadForkFork") {}

const PREFIX = "colleague-fork";

/** The notice at the top of the new thread: where it came from, and what of it arrived. */
const originNoticeFork = (
  input: Pick<
    ColleagueForkThreadInputFork,
    "hostName" | "originTitle" | "messages" | "partial" | "missingAttachments"
  >,
) => {
  const from = `Forked from ${input.hostName}'s thread "${input.originTitle}".`;
  if (input.messages.length === 0) {
    return `${from} This device had no copy of it, so this thread starts empty and only links to the original.`;
  }
  const missing = input.missingAttachments ?? [];
  return [
    from,
    input.partial ? "Its oldest messages were not in this device's copy." : "",
    missing.length === 0 ? "" : `Not copied from ${input.hostName}: ${missing.join(", ")}.`,
  ]
    .filter((part) => part !== "")
    .join(" ");
};

type ForkMessage = ColleagueForkThreadInputFork["messages"][number];

/**
 * A copied user message as a shared thread holds one: the agent reads who wrote it, and people see
 * the author's own words under their name, as in the original.
 */
const attributedFork = (message: ForkMessage) => {
  const { author, replyTo, text } = message;
  if (message.role !== "user" || (author === undefined && replyTo === undefined)) {
    return { text, context: undefined };
  }
  const reply =
    replyTo === undefined
      ? ""
      : `, in reply to this message from ${replyTo.name}: ${replyQuote(replyTo.text)}`;
  const context: OrchestrationMessageContext = {
    version: 1,
    records: [],
    collaboratorFork: {
      name: author ?? "",
      text,
      ...(author === undefined ? { host: true as const } : {}),
      ...(replyTo === undefined ? {} : { replyTo }),
    },
  };
  return {
    text: author === undefined ? text : `[${author} wrote the message below${reply}.]\n\n${text}`,
    context,
  };
};

/**
 * The events that write the copied history into `threadId`, the notice first. `attachments` holds
 * each message's claimed attachments, by index.
 */
const historyEventsFork = (
  threadId: ThreadId,
  input: ColleagueForkThreadInputFork,
  attachments: ReadonlyArray<ReadonlyArray<ChatAttachment>>,
  at: DateTime.Utc,
): ReadonlyArray<OrchestrationV2DomainEvent> => {
  const base = {
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: "completed" as const,
    title: null,
  };
  const noticeId = TurnItemId.make(`${PREFIX}:notice:${threadId}`);
  const notice: OrchestrationV2DomainEvent = {
    id: EventId.make(noticeId),
    type: "turn-item.updated",
    threadId,
    occurredAt: at,
    payload: {
      ...base,
      id: noticeId,
      ordinal: 0,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "system_notice",
      message: originNoticeFork(input),
      colleagueOriginFork: input.origin,
    },
  };
  return [
    notice,
    ...input.messages.flatMap((message, index): ReadonlyArray<OrchestrationV2DomainEvent> => {
      const suffix = String(index).padStart(6, "0");
      const messageId = MessageId.make(`${PREFIX}:${threadId}:${suffix}`);
      const itemId = TurnItemId.make(`${PREFIX}:turn-item:${threadId}:${suffix}`);
      const sentAt = DateTime.makeUnsafe(message.createdAt);
      const times = { startedAt: sentAt, completedAt: sentAt, updatedAt: sentAt };
      const common = { ...base, ...times, id: itemId, ordinal: index + 1, messageId };
      const { text, context } = attributedFork(message);
      const withContext = context === undefined ? {} : { context };
      return [
        {
          id: EventId.make(`${PREFIX}:message:${threadId}:${suffix}`),
          type: "message.updated",
          threadId,
          occurredAt: sentAt,
          payload: {
            id: messageId,
            threadId,
            runId: null,
            nodeId: null,
            role: message.role,
            text,
            ...withContext,
            attachments: attachments[index] ?? [],
            streaming: false,
            createdBy: message.role === "user" ? "user" : "agent",
            creationSource: "server",
            createdAt: sentAt,
            updatedAt: sentAt,
          },
        },
        {
          id: EventId.make(itemId),
          type: "turn-item.updated",
          threadId,
          occurredAt: sentAt,
          payload:
            message.role === "user"
              ? {
                  ...common,
                  type: "user_message",
                  createdBy: "user",
                  creationSource: "server",
                  inputIntent: "turn_start",
                  text,
                  ...withContext,
                  attachments: attachments[index] ?? [],
                }
              : { ...common, type: "assistant_message", text: message.text, streaming: false },
        },
      ];
    }),
  ];
};

const failedFork = (stage: ColleagueForkThreadErrorFork["stage"], threadId: ThreadId) =>
  Effect.mapError((cause) => new ColleagueForkThreadErrorFork({ stage, threadId, cause }));

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const claimContext = yield* Effect.context<
    FileSystem.FileSystem | ServerConfig.ServerConfig | DocumentText.DocumentText
  >();

  const fork = Effect.fn("ColleagueThreadForkFork.fork")(function* (
    input: ColleagueForkThreadInputFork,
  ) {
    yield* orchestrator
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${PREFIX}:create:${input.threadId}`),
        createdBy: "user",
        creationSource: "web",
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
      })
      .pipe(failedFork("create-thread", input.threadId));
    // Thread commands write whole thread rows, so hold their lock from the re-read through the
    // write that marks the history imported. Claims copy each pending upload, so a failed write
    // releases only these copies.
    const claimedPaths: Array<string> = [];
    yield* threadCommands
      .withLock(
        input.threadId,
        Effect.gen(function* () {
          const { thread, turnItems } = yield* orchestrator.getThreadRecords(input.threadId, [
            "turnItems",
          ]);
          if (turnItems.length > 0) return;
          const attachments = yield* Effect.forEach(input.messages, (message) =>
            message.role !== "user" || (message.attachments ?? []).length === 0
              ? Effect.succeed([])
              : AttachmentClaims.claimPendingAttachments({
                  threadId: input.threadId,
                  attachments: message.attachments ?? [],
                }).pipe(
                  Effect.provide(claimContext),
                  Effect.map((claimed) => {
                    claimedPaths.push(...claimed.claimedPaths);
                    return claimed.attachments;
                  }),
                ),
          );
          const at = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              ...historyEventsFork(input.threadId, input, attachments, at),
              ...(input.messages.length === 0
                ? []
                : [
                    {
                      id: EventId.make(`${PREFIX}:thread:${input.threadId}:history`),
                      type: "thread.metadata-updated" as const,
                      threadId: input.threadId,
                      providerInstanceId: thread.providerInstanceId,
                      occurredAt: at,
                      payload: { ...thread, historyOrigin: "v1_import" as const },
                    },
                  ]),
            ],
          });
        }).pipe(
          Effect.onError(() =>
            AttachmentClaims.releaseClaimedAttachments(claimedPaths).pipe(
              Effect.provide(claimContext),
            ),
          ),
          // Outside the release: an interrupt after the write must not delete what history names.
          Effect.uninterruptible,
        ),
      )
      .pipe(failedFork("write-history", input.threadId));
  });

  return ColleagueThreadForkFork.of({ fork });
});

/** Takes the orchestrator's event sink and thread locks from its caller, as a test harness has. */
export const layerFromRuntime = Layer.effect(ColleagueThreadForkFork, make);

export const layer = layerFromRuntime.pipe(
  Layer.provide(Layer.merge(layerEventSink, ThreadCommandExecutor.layer)),
);
