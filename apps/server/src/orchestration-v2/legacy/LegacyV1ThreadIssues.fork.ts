// Fork-owned V1 → V2 import of thread ↔ GitHub issue links
// (RSI-Software/t3code-hyprws#1431). V1 kept them in the fork table
// `projection_thread_issues`; V2 keeps them on the thread payload. The shell
// import calls this once per startup through one `github-issues/*` hook, after
// every thread it imports already exists in the V2 projection.
import {
  EventId,
  OrchestrationV2AppThreadJson,
  ThreadIssueLink,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type * as EventSink from "../EventSink.ts";
import { threadIssueKeysEqual, threadIssuesOf, withThreadIssues } from "../ThreadIssues.fork.ts";

const decodeStoredThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeLegacyLinks = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ThreadIssueLink)),
);

/** One import per thread, ever: a later unlink in V2 is never undone by a restart. */
export const legacyThreadIssuesEventIdFork = (threadId: ThreadId) =>
  EventId.make(`migration:v1:thread:${threadId}:issues`);

/**
 * Folds each live V2 thread's V1 issue links into its payload. A link already
 * on the thread wins, so the import only ever adds.
 */
export const importLegacyThreadIssuesFork = Effect.fn("importLegacyThreadIssuesFork")(function* (
  sql: SqlClient.SqlClient,
  eventSink: EventSink.EventSinkV2["Service"],
) {
  const rows = yield* sql<{
    readonly thread_id: ThreadId;
    readonly issues_json: string;
    readonly payload_json: string;
  }>`
    SELECT
      link.thread_id,
      json_group_array(json_object(
        'host', link.host, 'repository', link.repository, 'number', link.number,
        'url', link.url, 'source', link.source, 'linkedAt', link.linked_at,
        'snapshot', json(link.snapshot_json)
      )) AS issues_json,
      v2_thread.payload_json
    FROM projection_thread_issues AS link
    INNER JOIN orchestration_v2_projection_threads AS v2_thread
      ON v2_thread.thread_id = link.thread_id
    WHERE v2_thread.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_events AS imported
        WHERE imported.event_id = 'migration:v1:thread:' || link.thread_id || ':issues'
      )
    GROUP BY link.thread_id
    ORDER BY link.thread_id ASC
  `;
  let importedLinkCount = 0;
  let undecodedThreadCount = 0;
  for (const row of rows) {
    const current = decodeStoredThread(row.payload_json);
    const legacy = decodeLegacyLinks(row.issues_json);
    if (Option.isNone(current) || Option.isNone(legacy)) {
      // No marker is written, so the thread retries on every startup and warns each time.
      undecodedThreadCount += 1;
      yield* Effect.logWarning("Legacy issue links skipped: undecodable row").pipe(
        Effect.annotateLogs({
          threadId: row.thread_id,
          part: Option.isNone(current) ? "v2-thread" : "v1-links",
        }),
      );
      continue;
    }
    const links = threadIssuesOf(current.value);
    const added = legacy.value
      .filter((link) => !links.some((existing) => threadIssueKeysEqual(existing, link)))
      .toSorted((left, right) => left.linkedAt.localeCompare(right.linkedAt));
    const thread = withThreadIssues(current.value, [...links, ...added]);
    yield* eventSink.write({
      events: [
        {
          id: legacyThreadIssuesEventIdFork(thread.id),
          type: "thread.metadata-updated",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          // The import is not thread activity: the thread keeps its place.
          occurredAt: thread.updatedAt,
          payload: thread,
        },
      ],
    });
    importedLinkCount += added.length;
  }
  if (rows.length > 0) {
    // Links of threads deleted in V2 or never imported stay in the V1 table only.
    const [left] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM projection_thread_issues AS link
      WHERE NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads AS v2_thread
        WHERE v2_thread.thread_id = link.thread_id AND v2_thread.deleted_at IS NULL
      )
    `;
    yield* Effect.logInfo("Legacy issue links imported").pipe(
      Effect.annotateLogs({
        threads: rows.length - undecodedThreadCount,
        links: importedLinkCount,
        undecodedThreads: undecodedThreadCount,
        linksWithoutLiveThread: left?.count ?? 0,
      }),
    );
  }
  return { importedLinkCount, undecodedThreadCount };
});
