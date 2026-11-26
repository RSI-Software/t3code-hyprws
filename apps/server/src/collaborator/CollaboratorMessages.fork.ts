// Fork-only (colleague-collab): a collaborator with `approve` access sends nothing to the agent.
// Their messages wait here until the host sends or dismisses each one, or they withdraw it.
import {
  CollaboratorMessageBusyErrorFork,
  CollaboratorMessageDeliveryErrorFork,
  type CollaboratorMessageFork,
  CollaboratorMessageMissingErrorFork,
  CommandId,
  type CollaboratorResolveMessageInputFork,
  GUEST_PENDING_MESSAGE_LIMIT,
  MessageId,
  type OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/** The whole reply the agent gives when a shared-thread message is between people. */
export const QUIET_MARKER_SPIKE = "(listening)";
/** Spike RSI-714: the structured "no reply"; the agent calls this tool instead of writing text. */
export const QUIET_TOOL_SPIKE = "stay_quiet";

/**
 * Spike RSI-712/714: how the agent learns whether to answer. `marker712` is RSI-712's rule as
 * shipped; `marker` and `tool` use the RSI-714 criteria and stay quiet by text marker or by tool
 * call; `answer` is a message a router or its sender already marked as for the agent.
 */
export type SharedThreadModeSpike = "marker712" | "marker" | "tool" | "answer";

/** Spike RSI-714: when a shared-thread line is for the agent. The router reads the same text. */
export const FOR_AGENT_CRITERIA_SPIKE =
  `A message is for the agent when it asks the agent to do, check, explain, change or decide something, even with no name ("can you...", "it should...", "let's add..." said to the room); ` +
  `when it passes a request to the agent through a person ("Jordan, can you get it to add a test?", "ask it to...", "have the agent..."); ` +
  `when it answers a question the agent just asked ("yes, option 2", "sounds good, go ahead"); ` +
  `or when it says the agent's work is wrong or incomplete. ` +
  `A message is between people when it is addressed to a person about something only people can answer or do (meetings, plans, a person's opinion), ` +
  `or is thanks, agreement or small talk that asks nothing of the agent, or talks about what the agent made without asking for a change. ` +
  `When unsure, treat it as for the agent.`;

const quietBy: Record<"marker712" | "marker" | "tool", string> = {
  marker712: `reply with exactly ${QUIET_MARKER_SPIKE} and nothing else`,
  marker: `reply with exactly ${QUIET_MARKER_SPIKE} and nothing else`,
  tool: `call the ${QUIET_TOOL_SPIKE} tool and end your turn without writing any text`,
};

const sharedThreadRule = (others: string, mode: SharedThreadModeSpike) =>
  mode === "answer"
    ? `This thread is shared: ${others} read it and your replies live. This message is for you: answer it.`
    : mode === "marker712"
      ? `This thread is shared: ${others} read it and your replies live, and people here also talk to each other. ` +
        `Reply only when the message is for you: it asks you (the agent) to do, check, explain or decide something, or names you. ` +
        `When it is people talking to each other (addressed to a person by name, a question only a person can answer, thanks, agreement, small talk, plans between them), ` +
        `do nothing: no tools, no work, and ${quietBy[mode]}.`
      : `This thread is shared: ${others} read it and your replies live, and people here also talk to each other. ` +
        `${FOR_AGENT_CRITERIA_SPIKE} ` +
        `When the message is not for you, do nothing: no tools, no work, and ${quietBy[mode]}.`;

const MODES: ReadonlyArray<SharedThreadModeSpike> = ["marker712", "marker", "tool", "answer"];

const collaboratorPromptPrefix = (name: string, mode: SharedThreadModeSpike) =>
  `[${name}, a collaborator the owner shared this thread with, wrote the message below. ${sharedThreadRule(`the owner and ${name}`, mode)}]\n\n`;

const ownerPromptPrefix = (owner: string, others: string, mode: SharedThreadModeSpike) =>
  `[${owner}, the owner of this thread, wrote the message below. ${sharedThreadRule(`${owner} and ${others}`, mode)}]\n\n`;

export const collaboratorPrompt = (
  name: string,
  text: string,
  mode: SharedThreadModeSpike = "marker",
) => `${collaboratorPromptPrefix(name, mode)}${text}`;

/** A queued edit or a forced resend starts from attributed text, so no prefix is repeated. */
const stripPrefix = (prefixFor: (mode: SharedThreadModeSpike) => string, text: string) => {
  const prefix = MODES.map(prefixFor).find((candidate) => text.startsWith(candidate));
  return prefix === undefined ? text : text.slice(prefix.length);
};

/** The attributed text and the context that shows the collaborator's own words beside their name. */
export const collaboratorAttribution = (
  name: string,
  text: string,
  mode: SharedThreadModeSpike = "marker",
) => {
  const own = stripPrefix((m) => collaboratorPromptPrefix(name, m), text);
  return {
    text: collaboratorPrompt(name, own, mode),
    context: { collaboratorFork: { name, text: own } },
  };
};

/** Spike RSI-712: the owner's own messages in a shared thread carry their author too. */
export const ownerAttributionSpike = (
  owner: string,
  others: ReadonlyArray<string>,
  text: string,
  mode: SharedThreadModeSpike = "marker",
) => {
  const joined = others.join(" and ");
  const own = stripPrefix((m) => ownerPromptPrefix(owner, joined, m), text);
  return {
    text: `${ownerPromptPrefix(owner, joined, mode)}${own}`,
    context: { collaboratorFork: { name: owner, text: own } },
  };
};

interface MessageRow {
  readonly id: string;
  readonly thread_id: string;
  readonly subject: string;
  readonly collaborator_name: string;
  readonly text: string;
  readonly submitted_at: string;
}

const fromRow = (row: MessageRow): CollaboratorMessageFork => ({
  id: row.id,
  threadId: ThreadId.make(row.thread_id),
  subject: row.subject,
  name: row.collaborator_name,
  text: row.text,
  submittedAt: row.submitted_at,
});

export const makeCollaboratorMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  // One change at a time: two tabs cannot both send one message, and a submit cannot slip
  // between an unshare's purge and its freeze.
  const lock = (yield* Semaphore.make(1)).withPermits(1);

  const read = sql<MessageRow>`
    SELECT id, thread_id, subject, collaborator_name, text, submitted_at
    FROM fork_collaborator_messages ORDER BY submitted_at
  `.pipe(Effect.map((rows) => rows.map(fromRow)));
  const ref = yield* SubscriptionRef.make(yield* read.pipe(Effect.orDie));
  const reload = read.pipe(Effect.flatMap((next) => SubscriptionRef.set(ref, next)));

  const submit = Effect.fn("CollaboratorMessagesFork.submit")(function* (input: {
    readonly subject: string;
    readonly name: string;
    readonly threadId: ThreadId;
    readonly text: string;
  }) {
    const undelivered = (cause: unknown) =>
      new CollaboratorMessageDeliveryErrorFork({ threadId: input.threadId, cause });
    const waiting = (yield* SubscriptionRef.get(ref)).filter(
      (message) => message.subject === input.subject && message.threadId === input.threadId,
    );
    if (waiting.length >= GUEST_PENDING_MESSAGE_LIMIT) {
      return yield* new CollaboratorMessageBusyErrorFork({ threadId: input.threadId });
    }
    const id = yield* random.uuidV4().pipe(Effect.mapError(undelivered));
    const submittedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO fork_collaborator_messages
        (id, thread_id, subject, collaborator_name, text, submitted_at)
      VALUES (${id}, ${input.threadId}, ${input.subject}, ${input.name}, ${input.text}, ${submittedAt})
    `.pipe(Effect.andThen(reload), Effect.mapError(undelivered));
  });

  /** `subject` null is the host, who may send; a collaborator may only withdraw their own. */
  const resolve = Effect.fn("CollaboratorMessagesFork.resolve")(function* (
    input: CollaboratorResolveMessageInputFork,
    subject: string | null,
  ) {
    const undelivered = (cause: unknown) =>
      new CollaboratorMessageDeliveryErrorFork({ threadId: input.threadId, cause });
    const message = (yield* SubscriptionRef.get(ref)).find(
      (candidate) =>
        candidate.id === input.messageId &&
        candidate.threadId === input.threadId &&
        (subject === null || candidate.subject === subject),
    );
    if (message === undefined) {
      return yield* new CollaboratorMessageMissingErrorFork({ messageId: input.messageId });
    }
    if (input.decision === "send" && subject === null) {
      const attribution = collaboratorAttribution(message.name, message.text);
      const context: OrchestrationMessageContext = {
        version: 1,
        records: [],
        ...attribution.context,
      };
      // Ids from the message, so a retry after a failed delete replays instead of sending twice.
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`collaborator-message:${message.id}`),
          threadId: message.threadId,
          messageId: MessageId.make(`collaborator-message:${message.id}`),
          text: attribution.text,
          context,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(undelivered));
    }
    yield* sql`DELETE FROM fork_collaborator_messages WHERE id = ${message.id}`.pipe(
      Effect.andThen(reload),
      Effect.mapError(undelivered),
    );
  }, lock);

  /** Drops a collaborator's waiting messages on a thread they no longer share. */
  const drop = (subject: string, threadId: string) =>
    sql`
      DELETE FROM fork_collaborator_messages WHERE subject = ${subject} AND thread_id = ${threadId}
    `.pipe(Effect.andThen(reload));

  return {
    /** Runs `effect` alone; `submit` and `drop` run only inside it, with the share check. */
    exclusive: lock,
    submit,
    resolve,
    drop,
    /** The waiting messages a session may see, re-emitted whenever any changes. */
    visible: (
      visibleTo: (message: CollaboratorMessageFork) => boolean,
    ): Stream.Stream<ReadonlyArray<CollaboratorMessageFork>> =>
      SubscriptionRef.changes(ref).pipe(Stream.map((messages) => messages.filter(visibleTo))),
  };
});
