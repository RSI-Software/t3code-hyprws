// Fork-owned SQL projection for thread ↔ GitHub issue links
// (RSI-Software/t3code-hyprws#1431). The `projection_thread_issues` table comes
// from the idempotent `ForkSchema.ts` pass, never a numbered migration. The
// upstream projection pipeline and snapshot query reach this file only through
// marked `github-issues/*` hooks.
import {
  IsoDateTime,
  ThreadId,
  ThreadIssueKey,
  ThreadIssueLinkSource,
  ThreadIssueSnapshot,
  TrimmedNonEmptyString,
  type OrchestrationEvent,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "./Errors.ts";
import { ProjectionThreadRepository } from "./Services/ProjectionThreads.ts";
import { isStaleThreadIssueSync, threadIssuesField } from "../orchestration/threadIssues.fork.ts";

const ThreadIssueRow = Schema.Struct({
  threadId: ThreadId,
  ...ThreadIssueKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadIssueLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(Schema.fromJsonString(ThreadIssueSnapshot)),
});
type ThreadIssueRow = typeof ThreadIssueRow.Type;

const ThreadIssueRowKey = Schema.Struct({ threadId: ThreadId, ...ThreadIssueKey.fields });
const ThreadIssueThreadInput = Schema.Struct({ threadId: ThreadId });

const toLink = ({ threadId: _threadId, ...link }: ThreadIssueRow): ThreadIssueLink => link;

const toRepositoryError =
  (operation: string) =>
  (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decodeRows`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);

const makeThreadIssueSql = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsert = SqlSchema.void({
    Request: ThreadIssueRow,
    execute: (row) => sql`
      INSERT INTO projection_thread_issues (
        thread_id, host, repository, number, url, source, linked_at, snapshot_json
      )
      VALUES (
        ${row.threadId}, ${row.host}, ${row.repository}, ${row.number}, ${row.url},
        ${row.source}, ${row.linkedAt}, ${row.snapshot}
      )
      ON CONFLICT (thread_id, host, repository, number)
      DO UPDATE SET
        url = excluded.url,
        source = excluded.source,
        linked_at = excluded.linked_at,
        snapshot_json = excluded.snapshot_json
    `,
  });

  const selectRows = sql`
    SELECT
      thread_id AS "threadId", host, repository, number, url, source,
      linked_at AS "linkedAt", snapshot_json AS "snapshot"
    FROM projection_thread_issues
  `;

  const listAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadIssueRow,
    execute: () => sql`${selectRows} ORDER BY thread_id ASC, linked_at ASC, number ASC`,
  });

  const listByThread = SqlSchema.findAll({
    Request: ThreadIssueThreadInput,
    Result: ThreadIssueRow,
    execute: ({ threadId }) =>
      sql`${selectRows} WHERE thread_id = ${threadId} ORDER BY linked_at ASC, number ASC`,
  });

  const findOne = SqlSchema.findOneOption({
    Request: ThreadIssueRowKey,
    Result: ThreadIssueRow,
    execute: ({ threadId, host, repository, number }) => sql`
      ${selectRows}
      WHERE thread_id = ${threadId} AND host = ${host}
        AND repository = ${repository} AND number = ${number}
    `,
  });

  const deleteOne = SqlSchema.void({
    Request: ThreadIssueRowKey,
    execute: ({ threadId, host, repository, number }) => sql`
      DELETE FROM projection_thread_issues
      WHERE thread_id = ${threadId} AND host = ${host}
        AND repository = ${repository} AND number = ${number}
    `,
  });

  const deleteByThread = SqlSchema.void({
    Request: ThreadIssueThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_issues WHERE thread_id = ${threadId}
    `,
  });

  return { upsert, listAll, listByThread, findOne, deleteOne, deleteByThread };
});

/**
 * The threads projector's issue-link step, run at the top of the upstream
 * `applyThreadsProjection` for every event. Keys arrive normalized by the
 * decider, so rows match them exactly.
 */
export const makeThreadIssueProjectionFork = Effect.gen(function* () {
  const rows = yield* makeThreadIssueSql;
  const threads = yield* ProjectionThreadRepository;

  const touchThread = (threadId: ThreadId, updatedAt: string) =>
    threads
      .getById({ threadId })
      .pipe(
        Effect.flatMap((row) =>
          Option.isNone(row) ? Effect.void : threads.upsert({ ...row.value, updatedAt }),
        ),
      );

  const apply = Effect.fn("applyThreadIssueProjectionFork")(
    function* (event: OrchestrationEvent) {
      switch (event.type) {
        // A draft retry re-creates the id; links belong to the old incarnation.
        case "thread.created":
        case "thread.deleted":
          return yield* rows.deleteByThread({ threadId: event.payload.threadId });

        case "thread.issue-linked": {
          const { threadId, link, updatedAt } = event.payload;
          const thread = yield* threads.getById({ threadId });
          if (Option.isNone(thread) || thread.value.deletedAt !== null) return;
          yield* rows.upsert({ threadId, ...link });
          return yield* touchThread(threadId, updatedAt);
        }

        case "thread.issue-unlinked": {
          const { threadId, host, repository, number, updatedAt } = event.payload;
          yield* rows.deleteOne({ threadId, host, repository, number });
          return yield* touchThread(threadId, updatedAt);
        }

        case "thread.issue-synced": {
          const { threadId, host, repository, number, snapshot, updatedAt } = event.payload;
          const link = yield* rows.findOne({ threadId, host, repository, number });
          // A sync for a link removed in the meantime, or for an earlier link, is dropped.
          if (Option.isNone(link) || isStaleThreadIssueSync(link.value, snapshot.syncedAt)) return;
          yield* rows.upsert({ ...link.value, snapshot });
          return yield* touchThread(threadId, updatedAt);
        }
      }
    },
    Effect.mapError(toRepositoryError("ThreadIssueProjectionFork.apply")),
  );

  return apply;
});

/**
 * Issue-link reads for the snapshot query, run inside its transactions, each
 * yielding the thread's `issues` key to spread into its literal: `byThread` for
 * the whole-model and shell snapshot readers, `forThread` for one thread's
 * detail or shell.
 */
export const makeThreadIssueReadsFork = Effect.gen(function* () {
  const rows = yield* makeThreadIssueSql;

  const byThread = (operation: string) =>
    rows.listAll(undefined).pipe(
      Effect.map((all) => {
        const grouped = new Map<string, Array<ThreadIssueLink>>();
        for (const row of all) {
          const links = grouped.get(row.threadId) ?? [];
          links.push(toLink(row));
          grouped.set(row.threadId, links);
        }
        return (threadId: string) => threadIssuesField(grouped.get(threadId));
      }),
      Effect.mapError(toRepositoryError(`${operation}:listThreadIssues`)),
    );

  const forThread = (
    threadId: ThreadId,
    operation = "ProjectionSnapshotQuery.getThreadDetailById",
  ) =>
    rows.listByThread({ threadId }).pipe(
      Effect.map((links) => threadIssuesField(links.map(toLink))),
      Effect.mapError(toRepositoryError(`${operation}:listIssues`)),
    );

  return { byThread, forThread };
});
