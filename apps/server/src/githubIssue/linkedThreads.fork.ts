// Fork-only reverse lookup for thread ↔ GitHub issue links
// (RSI-Software/t3code-hyprws#1431), mirroring upstream's pull request
// `linkedThreads.ts`: links live in the V2 thread payload's `issues` array.
// The key is host-qualified, so one issue linked from two projects answers
// with both threads; deleted threads are never returned.
import {
  GitHubIssueOperationError,
  PullRequestLinkedThreadsResult,
  type ThreadIssueKey,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  normalizeThreadIssueKey,
  threadIssueKeysEqual,
} from "../orchestration-v2/ThreadIssues.fork.ts";

const decodeLinkedThreads = Schema.decodeUnknownEffect(PullRequestLinkedThreadsResult);

export const listLinkedIssueThreadsFork = Effect.fn("listLinkedIssueThreadsFork")(
  function* (input: ThreadIssueKey) {
    const key = normalizeThreadIssueKey(input);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      id: string;
      projectId: string;
      title: string;
      archivedAt: string | null;
      host: string;
      repository: string;
      number: number;
    }>`
      SELECT t.thread_id AS id, t.project_id AS "projectId", t.title,
        t.archived_at AS "archivedAt", json_extract(link.value, '$.host') AS host,
        json_extract(link.value, '$.repository') AS repository,
        json_extract(link.value, '$.number') AS number
      FROM orchestration_v2_projection_threads AS t
      JOIN json_each(t.payload_json, '$.issues') AS link
      WHERE json_extract(link.value, '$.number') = ${key.number}
        AND t.deleted_at IS NULL
      ORDER BY t.updated_at DESC, t.thread_id ASC
    `;
    const threads = rows
      .filter((row) => threadIssueKeysEqual(row, key))
      .map(({ id, projectId, title, archivedAt }) => ({ id, projectId, title, archivedAt }));
    return yield* decodeLinkedThreads({ threads });
  },
  Effect.mapError(
    (cause) =>
      new GitHubIssueOperationError({
        operation: "linkedThreads",
        detail: "Could not load linked threads.",
        cause,
      }),
  ),
);
