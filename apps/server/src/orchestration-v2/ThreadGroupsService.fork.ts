// Fork-only (thread-ordering): the environment's sidebar thread groups. They
// live in the fork table `fork_thread_groups` rather than the event-sourced
// thread payload, since one group spans threads and orchestrator commands are
// keyed to one thread. Clients follow `changes`; agents reach the same service
// through the MCP group tools.
import {
  applyThreadGroupMutationFork,
  type ThreadGroupFork,
  ThreadGroupErrorFork,
  ThreadGroupFork as ThreadGroupForkSchema,
  type ThreadGroupMutationFork,
  type ThreadGroupsSnapshotFork,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "./ThreadManagementService.ts";

export class ThreadGroupsServiceFork extends Context.Service<
  ThreadGroupsServiceFork,
  {
    readonly snapshot: Effect.Effect<ThreadGroupsSnapshotFork>;
    /** The current snapshot, then one per committed change. */
    readonly changes: Stream.Stream<ThreadGroupsSnapshotFork>;
    readonly mutate: (
      mutation: ThreadGroupMutationFork,
    ) => Effect.Effect<ThreadGroupsSnapshotFork, ThreadGroupErrorFork>;
    readonly groupOf: (threadId: ThreadId) => Effect.Effect<ThreadGroupFork | undefined>;
  }
>()("t3/orchestration-v2/ThreadGroupsService.fork/ThreadGroupsServiceFork") {}

interface ThreadGroupRow {
  readonly group_id: string;
  readonly title: string;
  readonly thread_ids_json: string;
  readonly parent_thread_id: string | null;
}

const ThreadIdsJson = Schema.fromJsonString(Schema.Array(ThreadId));
const decodeThreadIds = Schema.decodeSync(ThreadIdsJson);
const encodeThreadIds = Schema.encodeSync(ThreadIdsJson);
const decodeGroup = Schema.decodeSync(ThreadGroupForkSchema);
/** Compares snapshots by value, so a no-op mutation neither writes nor notifies. */
const encodeGroups = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ThreadGroupForkSchema)));

const rowToGroup = (row: ThreadGroupRow): ThreadGroupFork =>
  decodeGroup({
    id: row.group_id,
    title: row.title,
    threadIds: decodeThreadIds(row.thread_ids_json),
    ...(row.parent_thread_id === null ? {} : { parentThreadId: row.parent_thread_id }),
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const rows = yield* sql<ThreadGroupRow>`
    SELECT group_id, title, thread_ids_json, parent_thread_id
    FROM fork_thread_groups ORDER BY position
  `.pipe(Effect.orDie);
  const ref = yield* SubscriptionRef.make<ThreadGroupsSnapshotFork>({
    groups: rows.map(rowToGroup),
  });
  const writeLock = yield* Semaphore.make(1);

  const persist = Effect.fn("ThreadGroupsServiceFork.persist")(
    function* (groups: ReadonlyArray<ThreadGroupFork>) {
      yield* sql`DELETE FROM fork_thread_groups`;
      for (const [position, group] of groups.entries()) {
        yield* sql`INSERT INTO fork_thread_groups ${sql.insert({
          group_id: group.id,
          position,
          title: group.title,
          thread_ids_json: encodeThreadIds(group.threadIds),
          parent_thread_id: group.parentThreadId ?? null,
        })}`;
      }
    },
    sql.withTransaction,
    Effect.orDie,
  );

  const isLiveThread = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell !== null && shell.deletedAt === null),
      Effect.orDie,
    );

  /** Refuses a named thread that is missing; drops imported ones, which may be long gone. */
  const checkThreads = Effect.fn("ThreadGroupsServiceFork.checkThreads")(function* (
    mutation: ThreadGroupMutationFork,
  ) {
    if (mutation.type === "set-membership") {
      for (const threadId of mutation.threadIds) {
        if (!(yield* isLiveThread(threadId))) {
          return yield* new ThreadGroupErrorFork({ message: `Unknown thread ${threadId}.` });
        }
      }
      return mutation;
    }
    if (mutation.type !== "import") return mutation;
    const groups = yield* Effect.forEach(mutation.groups, (group) =>
      Effect.filter(group.threadIds, isLiveThread).pipe(
        Effect.map((threadIds) => ({ ...group, threadIds })),
      ),
    );
    return { ...mutation, groups };
  });

  const mutate = Effect.fn("ThreadGroupsServiceFork.mutate")(function* (
    requested: ThreadGroupMutationFork,
  ) {
    const mutation = yield* checkThreads(requested);
    const freshGroupId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const current = yield* SubscriptionRef.get(ref);
    const result = applyThreadGroupMutationFork(current.groups, mutation, () => freshGroupId);
    if ("error" in result) return yield* new ThreadGroupErrorFork({ message: result.error });
    if (encodeGroups(result.groups) === encodeGroups(current.groups)) return current;
    yield* persist(result.groups);
    const next = { groups: result.groups };
    yield* SubscriptionRef.set(ref, next);
    return next;
  }, writeLock.withPermits(1));

  return ThreadGroupsServiceFork.of({
    snapshot: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref),
    mutate,
    groupOf: (threadId) =>
      SubscriptionRef.get(ref).pipe(
        Effect.map(({ groups }) => groups.find((group) => group.threadIds.includes(threadId))),
      ),
  });
});

export const threadGroupsServiceLiveFork = Layer.effect(ThreadGroupsServiceFork, make);
