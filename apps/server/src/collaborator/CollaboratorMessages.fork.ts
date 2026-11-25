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

/** Spike RSI-711: a message reaches the agent only when it says `@agent`. */
export const AGENT_MENTION = /(^|\s)@agent\b/i;

/** Spike RSI-711: the block the agent reads before an `@agent` message, naming each speaker. */
const peopleLinesPrompt = (lines: ReadonlyArray<{ name: string; text: string }>) =>
  `[Since your last message, the people in this thread said the lines below to each other, not to you. Use them as context; act only on the message after them.]\n${lines
    .map((line) => `${line.name === "" ? "Owner" : line.name}: ${line.text}`)
    .join("\n")}\n[End of people-only lines.]\n\n`;

interface PeopleRow {
  readonly id: string;
  readonly thread_id: string;
  readonly author_name: string;
  readonly text: string;
  readonly created_at: string;
}

const fromPeopleRow = (row: PeopleRow): CollaboratorMessageFork => ({
  id: row.id,
  threadId: ThreadId.make(row.thread_id),
  subject: "people",
  name: row.author_name,
  text: row.text,
  submittedAt: row.created_at,
  kind: "people",
});

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

  const readPeople = sql<PeopleRow>`
    SELECT id, thread_id, author_name, text, created_at FROM fork_people_lines ORDER BY created_at
  `;
  const read = sql<MessageRow>`
    SELECT id, thread_id, subject, collaborator_name, text, submitted_at
    FROM fork_collaborator_messages ORDER BY submitted_at
  `.pipe(
    Effect.map((rows) => rows.map(fromRow)),
    Effect.flatMap((waiting) =>
      readPeople.pipe(Effect.map((people) => [...people.map(fromPeopleRow), ...waiting])),
    ),
  );
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

  /** Spike RSI-711: a line between people; `name` "" is the host. */
  const postPeopleLine = Effect.fn("CollaboratorMessagesFork.postPeopleLine")(function* (input: {
    readonly name: string;
    readonly threadId: ThreadId;
    readonly text: string;
  }) {
    const undelivered = (cause: unknown) =>
      new CollaboratorMessageDeliveryErrorFork({ threadId: input.threadId, cause });
    const id = yield* random.uuidV4().pipe(Effect.mapError(undelivered));
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO fork_people_lines (id, thread_id, author_name, text, created_at)
      VALUES (${id}, ${input.threadId}, ${input.name}, ${input.text}, ${createdAt})
    `.pipe(Effect.andThen(reload), Effect.mapError(undelivered));
  });

  /**
   * Spike RSI-711: folds the thread's people-only lines into an `@agent` message, so the agent
   * reads them as context and the timeline shows them above it. The lines leave the live list.
   */
  const foldPeopleLines = <
    C extends { readonly text: string; readonly context?: OrchestrationMessageContext | undefined },
  >(
    threadId: string,
    command: C,
  ) =>
    Effect.gen(function* () {
      const lines = (yield* SubscriptionRef.get(ref)).filter(
        (message) => message.kind === "people" && message.threadId === threadId,
      );
      if (lines.length === 0) return command;
      yield* sql`DELETE FROM fork_people_lines WHERE thread_id = ${threadId}`.pipe(
        Effect.andThen(reload),
        Effect.orDie,
      );
      const own = command.context?.collaboratorFork?.text ?? command.text;
      return {
        ...command,
        text: `${peopleLinesPrompt(lines)}${command.text}`,
        context: {
          version: 1 as const,
          records: [],
          ...command.context,
          peopleLinesFork: {
            text: own,
            lines: lines.map(({ name, text, submittedAt }) => ({ name, text, at: submittedAt })),
          },
        },
      };
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
      const folded = yield* foldPeopleLines(message.threadId, {
        text: attribution.text,
        context: { version: 1, records: [], ...attribution.context } as OrchestrationMessageContext,
      });
      // Ids from the message, so a retry after a failed delete replays instead of sending twice.
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`collaborator-message:${message.id}`),
          threadId: message.threadId,
          messageId: MessageId.make(`collaborator-message:${message.id}`),
          text: folded.text,
          ...(folded.context === undefined ? {} : { context: folded.context }),
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
    postPeopleLine,
    foldPeopleLines,
    /** The waiting messages a session may see, re-emitted whenever any changes. */
    visible: (
      visibleTo: (message: CollaboratorMessageFork) => boolean,
    ): Stream.Stream<ReadonlyArray<CollaboratorMessageFork>> =>
      SubscriptionRef.changes(ref).pipe(Stream.map((messages) => messages.filter(visibleTo))),
  };
});
