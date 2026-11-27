// Fork-only (colleague-collab): a collaborator with `approve` access sends nothing to the agent.
// Their messages wait here until the host sends or dismisses each one, or they withdraw it.
// A dismissed one stays, so its author sees the outcome, until they clear it.
import {
  CollaboratorMessageBusyErrorFork,
  CollaboratorMessageDeliveryErrorFork,
  type CollaboratorMessageFork,
  CollaboratorMessageMissingErrorFork,
  collaboratorMessageCommandId,
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
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { QUIET_MARKER } from "./quietTurn.fork.ts";

// Model-facing: evals/shared-thread-quiet grades this text; rerun it after any change.
const sharedThreadRule = (people: string) =>
  `This thread is shared: ${people} read it and your replies live, and people here also talk to each other. ` +
  `A message is for the agent when it asks the agent to do, check, explain, change or decide something, even with no name ("can you...", "it should...", "let's add..." said to the room); ` +
  `when it passes a request to the agent through a person ("Jordan, can you get it to add a test?", "ask it to...", "have the agent..."); ` +
  `when it answers a question the agent just asked ("yes, option 2", "sounds good, go ahead"); ` +
  `or when it says the agent's work is wrong or incomplete. ` +
  `A message is between people when it is addressed to a person about something only people can answer or do (meetings, plans, a person's opinion), ` +
  `or is thanks, agreement or small talk that asks nothing of the agent, or talks about what the agent made without asking for a change. ` +
  `When unsure, treat it as for the agent. ` +
  `When the message is not for you, do nothing: no tools, no work, and reply with exactly ${QUIET_MARKER} and nothing else.`;

const FORCED_END = `never reply with ${QUIET_MARKER}.`;
// "Ask the agent": the writer chose the agent, so no judgement; earlier quiet turns made Haiku stay quiet.
const forcedRule = (people: string) =>
  `This thread is shared: ${people} read it and your replies live. ` +
  `The writer chose to ask you directly, so this message is for you: answer it in words, even if it is addressed to a person or is only thanks or small talk, and ${FORCED_END}`;

const PREFIX_ENDS = [`${QUIET_MARKER} and nothing else.]\n\n`, `${FORCED_END}]\n\n`];

/**
 * A queued edit starts from the already attributed text, maybe under an older share list or the
 * other rule, so any prefix by the same author is replaced rather than nested.
 */
const attributed = (intro: string, people: string, text: string, forced: boolean) => {
  const cut = text.startsWith(intro)
    ? Math.min(
        ...PREFIX_ENDS.map((end) => {
          const at = text.indexOf(end);
          return at === -1 ? Infinity : at + end.length;
        }),
      )
    : Infinity;
  const own = cut === Infinity ? text : text.slice(cut);
  const rule = forced ? forcedRule(people) : sharedThreadRule(people);
  return { own, text: `${intro}${rule}]\n\n${own}` };
};

/** What the agent reads from a collaborator, and the context that shows their own words. */
export const collaboratorAttribution = (name: string, text: string, forced = false) => {
  // Naming the host here made Haiku read collaborators' doubts as addressed to them.
  const { own, text: prompt } = attributed(
    `[${name}, a collaborator the owner shared this thread with, wrote the message below. `,
    `the owner and ${name}`,
    text,
    forced,
  );
  return { text: prompt, context: { collaboratorFork: { name, text: own } } };
};

/** The host's own message in a shared thread names them too; people still see it as the host's. */
export const hostAttribution = (
  host: string | undefined,
  others: ReadonlyArray<string>,
  text: string,
  forced = false,
) => {
  const { own, text: prompt } = attributed(
    `[${host === undefined ? "The owner of this thread" : `${host}, the owner of this thread,`} wrote the message below. `,
    `${host ?? "the owner"} and ${others.join(" and ")}`,
    text,
    forced,
  );
  return {
    text: prompt,
    context: { collaboratorFork: { name: host ?? "", text: own, host: true as const } },
  };
};

interface MessageRow {
  readonly id: string;
  readonly thread_id: string;
  readonly subject: string;
  readonly collaborator_name: string;
  readonly text: string;
  readonly submitted_at: string;
  readonly outcome: string | null;
  readonly force_reply: number | null;
}

const fromRow = (row: MessageRow): CollaboratorMessageFork => ({
  id: row.id,
  threadId: ThreadId.make(row.thread_id),
  subject: row.subject,
  name: row.collaborator_name,
  text: row.text,
  submittedAt: row.submitted_at,
  outcome: row.outcome === "dismissed" ? "dismissed" : undefined,
  ...(row.force_reply === 1 ? { forceReplyFork: true as const } : {}),
});

export const makeCollaboratorMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const random = yield* SecureRandom.SecureRandom;
  // One change at a time: two tabs cannot both send one message, and a submit cannot slip
  // between an unshare's purge and its freeze.
  const lock = (yield* Semaphore.make(1)).withPermits(1);

  const read = sql<MessageRow>`
  SELECT id, thread_id, subject, collaborator_name, text, submitted_at, outcome, force_reply
  FROM fork_collaborator_messages ORDER BY submitted_at
`.pipe(Effect.map((rows) => rows.map(fromRow)));
  const ref = yield* SubscriptionRef.make(yield* read.pipe(Effect.orDie));
  const reload = read.pipe(Effect.flatMap((next) => SubscriptionRef.set(ref, next)));

  const submit = Effect.fn("CollaboratorMessagesFork.submit")(function* (input: {
    readonly subject: string;
    readonly name: string;
    readonly threadId: ThreadId;
    readonly text: string;
    readonly id?: string | undefined;
    readonly forceReplyFork?: true | undefined;
  }) {
    const undelivered = (cause: unknown) =>
      new CollaboratorMessageDeliveryErrorFork({ threadId: input.threadId, cause });
    const messages = yield* SubscriptionRef.get(ref);
    // A flush from their queue may repeat after a lost reply: it already waits here, or it went
    // out under the id both delivery paths share.
    if (messages.some(({ id, subject }) => id === input.id && subject === input.subject)) return;
    if (input.id !== undefined) {
      const sent = yield* receipts
        .getByCommandId(CommandId.make(collaboratorMessageCommandId(input.id)))
        .pipe(Effect.mapError(undelivered));
      if (Option.exists(sent, (r) => r.status === "accepted" && r.threadId === input.threadId)) {
        return;
      }
      // A rejected id replays its rejection forever; the sender edits it to try again.
      if (Option.isSome(sent)) return yield* undelivered(sent.value.error);
    }
    const waiting = messages.filter(
      (message) =>
        message.subject === input.subject &&
        message.threadId === input.threadId &&
        message.outcome === undefined,
    );
    if (waiting.length >= GUEST_PENDING_MESSAGE_LIMIT) {
      return yield* new CollaboratorMessageBusyErrorFork({ threadId: input.threadId });
    }
    const id = input.id ?? (yield* random.uuidV4().pipe(Effect.mapError(undelivered)));
    const submittedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
    INSERT INTO fork_collaborator_messages
      (id, thread_id, subject, collaborator_name, text, submitted_at, force_reply)
    VALUES (${id}, ${input.threadId}, ${input.subject}, ${input.name}, ${input.text}, ${submittedAt}, ${input.forceReplyFork ? 1 : null})
  `.pipe(Effect.andThen(reload), Effect.mapError(undelivered));
  });

  /**
   * `subject` null is the host, who sends or dismisses a waiting message; a collaborator may
   * only remove their own, withdrawing it while it waits or clearing it once dismissed.
   */
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
        (subject === null ? candidate.outcome === undefined : candidate.subject === subject),
    );
    if (message === undefined) {
      return yield* new CollaboratorMessageMissingErrorFork({ messageId: input.messageId });
    }
    if (input.decision === "send" && subject === null) {
      const forced = message.forceReplyFork === true;
      const attribution = collaboratorAttribution(message.name, message.text, forced);
      const context: OrchestrationMessageContext = {
        version: 1,
        records: [],
        ...(forced ? { forceReplyFork: true as const } : {}),
        collaboratorFork: { ...attribution.context.collaboratorFork, sentByHost: true },
      };
      // Ids from the message, so a retry after a failed delete replays instead of sending twice.
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(collaboratorMessageCommandId(message.id)),
          threadId: message.threadId,
          messageId: MessageId.make(collaboratorMessageCommandId(message.id)),
          text: attribution.text,
          context,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(undelivered));
    }
    yield* (
      input.decision === "dismiss" && subject === null
        ? sql`UPDATE fork_collaborator_messages SET outcome = 'dismissed' WHERE id = ${message.id}`
        : sql`DELETE FROM fork_collaborator_messages WHERE id = ${message.id}`
    ).pipe(Effect.andThen(reload), Effect.mapError(undelivered));
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
    /** The messages a session may see, re-emitted whenever any changes. */
    visible: (
      visibleTo: (message: CollaboratorMessageFork) => boolean,
    ): Stream.Stream<ReadonlyArray<CollaboratorMessageFork>> =>
      SubscriptionRef.changes(ref).pipe(Stream.map((messages) => messages.filter(visibleTo))),
  };
});
