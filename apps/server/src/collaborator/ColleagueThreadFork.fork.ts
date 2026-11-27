// Fork-only (colleague-collab): forks a colleague's thread onto this machine from the client's copy
// of it. The new thread holds the copied messages as run-less `v1_import` history, which upstream
// hands to the first run's fresh provider session as context. A notice names the original.
import {
  ColleagueForkThreadErrorFork,
  type ColleagueForkThreadInputFork,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { layerEventSink } from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";

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
  input: Pick<ColleagueForkThreadInputFork, "hostName" | "originTitle" | "messages" | "partial">,
) => {
  const from = `Forked from ${input.hostName}'s thread "${input.originTitle}".`;
  if (input.messages.length === 0) {
    return `${from} This device had no copy of it, so this thread starts empty and only links to the original.`;
  }
  return input.partial ? `${from} Its oldest messages were not in this device's copy.` : from;
};

/** The events that write the copied history into `threadId`, the notice first. */
const historyEventsFork = (
  threadId: ThreadId,
  input: ColleagueForkThreadInputFork,
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
            text: message.text,
            attachments: [],
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
                  text: message.text,
                  attachments: [],
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
    // write that marks the history imported.
    yield* threadCommands
      .withLock(
        input.threadId,
        Effect.gen(function* () {
          const { thread, turnItems } = yield* orchestrator.getThreadRecords(input.threadId, [
            "turnItems",
          ]);
          if (turnItems.length > 0) return;
          const at = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              ...historyEventsFork(input.threadId, input, at),
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
        }),
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
