// Fork-only reverse lookup for thread ↔ GitHub issue links
// (RSI-Software/t3code-hyprws#1431), mirroring upstream's pull request
// `linkedThreads.ts` against the fork-owned `projection_thread_issues` table.
// The key is host-qualified, so one issue linked from two projects answers
// with both threads; deleted threads are never returned.
import {
  GitHubIssueOperationError,
  PullRequestLinkedThreadsResult,
  type ThreadIssueKey,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  normalizeThreadIssueKey,
  threadIssueKeysEqual,
} from "../orchestration/threadIssues.fork.ts";

const decodeLinkedThreads = Schema.decodeUnknownEffect(PullRequestLinkedThreadsResult);

export const listLinkedIssueThreadsFork = Effect.fn("listLinkedIssueThreadsFork")(
  function* (input: ThreadIssueKey) {
    const key = normalizeThreadIssueKey(input);
    const hostname = key.host.replace(/:\d+$/u, "");
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
        t.archived_at AS "archivedAt", link.host, link.repository, link.number
      FROM projection_thread_issues AS link
      JOIN projection_threads AS t ON t.thread_id = link.thread_id
      WHERE (link.host = ${key.host} OR link.host = ${hostname})
        AND link.repository = ${key.repository}
        AND link.number = ${key.number}
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
