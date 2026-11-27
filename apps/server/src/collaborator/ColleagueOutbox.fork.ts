// Fork-only (colleague-collab): messages for a saved colleague's thread, kept here while their
// machine is offline. A client delivers each one through the normal path once their environment
// reconnects, then removes it; the queued id makes a repeat delivery a no-op on their side.
import {
  type ColleagueQueuedMessageFork,
  type ColleagueQueueMessageInputFork,
  ColleagueStorageErrorFork,
  EnvironmentId,
  IsoDateTime,
  ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

interface OutboxRow {
  readonly id: string;
  readonly environment_id: string;
  readonly thread_id: string;
  readonly text: string;
  readonly queued_at: string;
}

const fromRow = (row: OutboxRow): ColleagueQueuedMessageFork => ({
  id: row.id,
  environmentId: EnvironmentId.make(row.environment_id),
  threadId: ThreadId.make(row.thread_id),
  text: row.text,
  queuedAt: IsoDateTime.make(row.queued_at),
});

export const makeColleagueOutbox = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const stored = (cause: unknown) => new ColleagueStorageErrorFork({ cause });

  // Insertion order is send order.
  const read = sql<OutboxRow>`
    SELECT id, environment_id, thread_id, text, queued_at FROM fork_colleague_outbox ORDER BY rowid
  `.pipe(Effect.map((rows) => rows.map(fromRow)));
  const ref = yield* SubscriptionRef.make(yield* read.pipe(Effect.orDie));
  const reload = read.pipe(
    Effect.flatMap((next) => SubscriptionRef.set(ref, next)),
    Effect.mapError(stored),
  );

  const queue = Effect.fn("ColleagueOutboxFork.queue")(function* (
    input: ColleagueQueueMessageInputFork,
  ) {
    const id = yield* random.uuidV4().pipe(Effect.mapError(stored));
    const queuedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO fork_colleague_outbox (id, environment_id, thread_id, text, queued_at)
      VALUES (${id}, ${input.environmentId}, ${input.threadId}, ${input.text}, ${queuedAt})
    `.pipe(Effect.mapError(stored));
    yield* reload;
  });

  const unqueue = (id: string) =>
    sql`DELETE FROM fork_colleague_outbox WHERE id = ${id}`.pipe(
      Effect.mapError(stored),
      Effect.andThen(reload),
    );

  /** Drops everything queued for a colleague who is no longer saved. */
  const drop = (environmentId: string) =>
    sql`DELETE FROM fork_colleague_outbox WHERE environment_id = ${environmentId}`.pipe(
      Effect.mapError(stored),
      Effect.andThen(reload),
    );

  return { queue, unqueue, drop, changes: SubscriptionRef.changes(ref) };
});
