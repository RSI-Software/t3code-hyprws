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
const QUIET_MARKER_SPIKE = "(listening)";

/**
 * Spike RSI-712: every message in a shared thread reaches the agent with its author and one
 * rule: answer only what is for you, otherwise reply with the quiet marker alone.
 */
const sharedThreadRule = (others: string) =>
  `This thread is shared: ${others} read it and your replies live, and people here also talk to each other. ` +
  `Reply only when the message is for you: it asks you (the agent) to do, check, explain or decide something, or names you. ` +
  `When it is people talking to each other (addressed to a person by name, a question only a person can answer, thanks, agreement, small talk, plans between them), ` +
  `do nothing: no tools, no work, and reply with exactly ${QUIET_MARKER_SPIKE} and nothing else.`;

const collaboratorPromptPrefix = (name: string) =>
  `[${name}, a collaborator the owner shared this thread with, wrote the message below. ${sharedThreadRule(`the owner and ${name}`)}]\n\n`;

const ownerPromptPrefix = (owner: string, others: string) =>
  `[${owner}, the owner of this thread, wrote the message below. ${sharedThreadRule(`${owner} and ${others}`)}]\n\n`;

export const collaboratorPrompt = (name: string, text: string) =>
  `${collaboratorPromptPrefix(name)}${text}`;

const stripPrefix = (prefix: string, text: string) =>
  text.startsWith(prefix) ? text.slice(prefix.length) : text;

/** The attributed text and the context that shows the collaborator's own words beside their name. */
export const collaboratorAttribution = (name: string, text: string) => {
  // A queued edit starts from the already attributed text, so the prefix is not repeated.
  const own = stripPrefix(collaboratorPromptPrefix(name), text);
  return {
    text: collaboratorPrompt(name, own),
    context: { collaboratorFork: { name, text: own } },
  };
};

/** Spike RSI-712: the owner's own messages in a shared thread carry their author too. */
export const ownerAttributionSpike = (
  owner: string,
  others: ReadonlyArray<string>,
  text: string,
) => {
  const prefix = ownerPromptPrefix(owner, others.join(" and "));
  const own = stripPrefix(prefix, text);
  return {
    text: `${prefix}${own}`,
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
