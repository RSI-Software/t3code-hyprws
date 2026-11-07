// Fork-only (colleague-collab): a collaborator with `approve` access sends nothing to the agent.
// Their messages wait here until the host sends or dismisses each one, or they withdraw it.
import {
  CommandId,
  CollaboratorMessageErrorFork,
  type CollaboratorMessageFork,
  type CollaboratorResolveMessageInputFork,
  GUEST_PENDING_MESSAGE_LIMIT,
  MessageId,
  type OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

/**
 * What the agent reads. It names the collaborator and says they follow the thread live, so the
 * agent answers them here instead of drafting replies for the host to pass on.
 */
export const collaboratorPrompt = (name: string, text: string) =>
  `${collaboratorPromptPrefix(name)}${text}`;

const collaboratorPromptPrefix = (name: string) =>
  `[${name}, a collaborator the owner shared this thread with, wrote the message below. ${name} reads this thread and your replies live, so answer ${name} here directly, as you would the owner.]\n\n`;

/** The attributed text and the context that shows the collaborator's own words beside their name. */
export const collaboratorAttribution = (name: string, text: string) => {
  // A queued edit starts from the already attributed text, so the prefix is not repeated.
  const own = text.startsWith(collaboratorPromptPrefix(name))
    ? text.slice(collaboratorPromptPrefix(name).length)
    : text;
  return {
    text: collaboratorPrompt(name, own),
    context: { collaboratorFork: { name, text: own } },
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

const failed = (cause: unknown) => new CollaboratorMessageErrorFork({ reason: "failed", cause });

export const makeCollaboratorMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;

  const read = sql<MessageRow>`
    SELECT id, thread_id, subject, collaborator_name, text, submitted_at
    FROM fork_collaborator_messages ORDER BY submitted_at
  `.pipe(Effect.map((rows) => rows.map(fromRow)));
  const ref = yield* SubscriptionRef.make(yield* read.pipe(Effect.orDie));
  const reload = read.pipe(Effect.flatMap((next) => SubscriptionRef.set(ref, next)));

  const submit = Effect.fn("CollaboratorMessagesFork.submit")(function* (input: {
    readonly subject: string;
    readonly name: string;
    readonly threadId: string;
    readonly text: string;
  }) {
    const waiting = (yield* SubscriptionRef.get(ref)).filter(
      (message) => message.subject === input.subject && message.threadId === input.threadId,
    );
    if (waiting.length >= GUEST_PENDING_MESSAGE_LIMIT) {
      return yield* new CollaboratorMessageErrorFork({ reason: "busy" });
    }
    const id = yield* random.uuidV4().pipe(Effect.mapError(failed));
    const submittedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO fork_collaborator_messages
        (id, thread_id, subject, collaborator_name, text, submitted_at)
      VALUES (${id}, ${input.threadId}, ${input.subject}, ${input.name}, ${input.text}, ${submittedAt})
    `.pipe(Effect.mapError(failed));
    yield* reload.pipe(Effect.mapError(failed));
  });

  const take = Effect.fn("CollaboratorMessagesFork.take")(function* (
    input: CollaboratorResolveMessageInputFork,
    subject: string | null,
  ) {
    const message = (yield* SubscriptionRef.get(ref)).find(
      (candidate) =>
        candidate.id === input.messageId &&
        candidate.threadId === input.threadId &&
        (subject === null || candidate.subject === subject),
    );
    if (message === undefined)
      return yield* new CollaboratorMessageErrorFork({ reason: "missing" });
    return message;
  });

  const remove = (id: string) =>
    sql`DELETE FROM fork_collaborator_messages WHERE id = ${id}`.pipe(
      Effect.andThen(reload),
      Effect.mapError(failed),
    );

  /** `subject` null is the host, who may send; a collaborator may only withdraw their own. */
  const resolve = Effect.fn("CollaboratorMessagesFork.resolve")(function* (
    input: CollaboratorResolveMessageInputFork,
    subject: string | null,
  ) {
    const message = yield* take(input, subject);
    if (input.decision === "send" && subject === null) {
      const attribution = collaboratorAttribution(message.name, message.text);
      const context: OrchestrationMessageContext = {
        version: 1,
        records: [],
        ...attribution.context,
      };
      const commandId = yield* random.uuidV4().pipe(Effect.mapError(failed));
      yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(commandId),
          threadId: message.threadId,
          messageId: MessageId.make(commandId),
          text: attribution.text,
          context,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(failed));
    }
    yield* remove(message.id);
  });

  return {
    submit,
    resolve,
    reload,
    /** The waiting messages a session may see, re-emitted whenever any changes. */
    visible: (
      visibleTo: (message: CollaboratorMessageFork) => boolean,
    ): Stream.Stream<ReadonlyArray<CollaboratorMessageFork>> =>
      SubscriptionRef.changes(ref).pipe(Stream.map((messages) => messages.filter(visibleTo))),
  };
});
