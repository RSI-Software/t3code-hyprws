// Fork-only (thread-ordering): the environment's sidebar thread groups. They
// live in the fork table `fork_thread_groups` rather than the event-sourced
// thread payload, since one group spans threads and orchestrator commands are
// keyed to one thread. Clients follow `changes`; agents reach the same service
// through the MCP group tools and the launch tools.
import {
  applyThreadGroupMutationFork,
  type ThreadGroupFork,
  ThreadGroupErrorFork,
  ThreadGroupFork as ThreadGroupForkSchema,
  type ThreadGroupMutationFork,
  type ThreadGroupsDescribedFork,
  type ThreadGroupsSnapshotFork,
  ThreadId,
  type ThreadLaunchGroupFork,
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
    /** Names each member as seen from `caller`; a thread deleted since it was grouped is left out. */
    readonly describe: (
      snapshot: ThreadGroupsSnapshotFork,
      caller: ThreadId | undefined,
    ) => Effect.Effect<ThreadGroupsDescribedFork>;
    /**
     * Resolves where launched threads go before any exists, so an unknown group
     * creates nothing. The returned join never fails: the thread is already
     * launched, and a failed launch reply would invite a duplicate retry.
     */
    readonly prepareLaunch: (
      caller: ThreadId | undefined,
      group: ThreadLaunchGroupFork | undefined,
    ) => Effect.Effect<(threadId: ThreadId) => Effect.Effect<void>, ThreadGroupErrorFork>;
  }
>()("t3/orchestration-v2/ThreadGroupsService.fork/ThreadGroupsServiceFork") {}

/**
 * Places each thread a batch launch accepts as it is accepted, so a later
 * failure in the batch leaves the earlier threads in their group. The default
 * places nothing; the launch handler provides the join.
 */
export class LaunchedThreadPlacementFork extends Context.Reference<
  (threadId: ThreadId) => Effect.Effect<void>
>("t3/orchestration-v2/ThreadGroupsService.fork/LaunchedThreadPlacementFork", {
  defaultValue: () => () => Effect.void,
}) {}

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
    epoch: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
    revision: 0,
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
          return yield* new ThreadGroupErrorFork({ reason: "unknown-thread", threadId });
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
    if ("error" in result) return yield* result.error;
    if (encodeGroups(result.groups) === encodeGroups(current.groups)) return current;
    const next = { ...current, revision: current.revision + 1, groups: result.groups };
    // Memory follows a committed write even when the caller is interrupted.
    yield* Effect.uninterruptible(
      Effect.andThen(persist(result.groups), SubscriptionRef.set(ref, next)),
    );
    return next;
  }, writeLock.withPermits(1));

  const groupOf = (threadId: ThreadId) =>
    SubscriptionRef.get(ref).pipe(
      Effect.map(({ groups }) => groups.find((group) => group.threadIds.includes(threadId))),
    );

  const describe = Effect.fn("ThreadGroupsServiceFork.describe")(function* (
    snapshot: ThreadGroupsSnapshotFork,
    caller: ThreadId | undefined,
  ) {
    const groups = yield* Effect.forEach(snapshot.groups, (group) =>
      Effect.forEach(group.threadIds, (threadId) =>
        threads.getThreadShell(threadId).pipe(Effect.orDie),
      ).pipe(
        Effect.map((members) => ({
          id: group.id,
          title: group.title,
          parentThreadId: group.parentThreadId ?? null,
          threads: members.flatMap((shell) =>
            shell === null || shell.deletedAt !== null
              ? []
              : [{ threadId: shell.id, title: shell.title }],
          ),
        })),
      ),
    );
    const callerGroup =
      caller === undefined
        ? undefined
        : snapshot.groups.find((group) => group.threadIds.includes(caller));
    return { groups, callerGroupId: callerGroup?.id ?? null };
  });

  const prepareLaunch = Effect.fn("ThreadGroupsServiceFork.prepareLaunch")(function* (
    caller: ThreadId | undefined,
    group: ThreadLaunchGroupFork | undefined,
  ) {
    let groupId: string | undefined;
    if (group === undefined || group === "caller") {
      groupId = caller === undefined ? undefined : (yield* groupOf(caller))?.id;
    } else if (group !== "none") {
      const { groups } = yield* SubscriptionRef.get(ref);
      if (!groups.some((candidate) => candidate.id === group.groupId)) {
        return yield* new ThreadGroupErrorFork({ reason: "unknown-group", groupId: group.groupId });
      }
      groupId = group.groupId;
    }
    return (threadId: ThreadId) =>
      groupId === undefined
        ? Effect.void
        : mutate({
            type: "set-membership",
            threadIds: [threadId],
            target: { type: "existing", groupId },
          }).pipe(
            Effect.asVoid,
            Effect.catchTags({
              ThreadGroupErrorFork: (error) =>
                Effect.logWarning("A launched thread was left out of its group", {
                  groupId,
                  threadId,
                  reason: error.reason,
                }),
            }),
          );
  });

  return ThreadGroupsServiceFork.of({
    snapshot: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref),
    mutate,
    groupOf,
    describe,
    prepareLaunch,
  });
});

export const layer = Layer.effect(ThreadGroupsServiceFork, make);
