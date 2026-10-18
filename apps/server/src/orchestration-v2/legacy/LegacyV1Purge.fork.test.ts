import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { purgeImportedLegacyV1Fork } from "./LegacyV1Purge.fork.ts";

const now = "2026-01-01T00:00:00.000Z";
const imported = "thread:purge-imported";
const pending = "thread:purge-pending";

// The purge paces pages with real sleeps.
it.layer(SqlitePersistence.layerMemory, { excludeTestServices: true })("legacy v1 purge", (it) => {
  it.effect("drops V1 rows of imported threads in pages and keeps everything V2 reads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insertEvents = (
        prefix: string,
        aggregateKind: string,
        streamId: string,
        version: number,
        count: number,
        firstVersion = 1,
      ) => sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        )
        SELECT ${prefix} || i, ${aggregateKind}, ${streamId}, ${firstVersion - 1} + i,
          'thread.activity-appended', ${now}, 'server', '{}', '{}', ${version}
        FROM n
      `;
      // More than one page of V1 events for the imported thread.
      yield* insertEvents("v1:", "thread", imported, 1, 1001);
      yield* insertEvents("v1-pending:", "thread", pending, 1, 2);
      yield* insertEvents("v1-project:", "project", "project:purge", 1, 1);
      // Fork issue markers are V2 thread events and must survive.
      yield* insertEvents("v2:", "thread", imported, 2, 1, 1002);
      yield* sql`
        INSERT INTO orchestration_v2_legacy_imports (
          thread_id, source_updated_at, shell_imported_at, transcript_imported_at,
          imported_message_count, last_error
        )
        VALUES (${imported}, ${now}, ${now}, ${now}, 0, NULL),
          (${pending}, ${now}, ${now}, NULL, 0, NULL)
      `;

      assert.deepEqual(yield* purgeImportedLegacyV1Fork(sql), { events: 1001 });

      const remaining = yield* sql<{ readonly event_id: string }>`
        SELECT event_id FROM orchestration_events ORDER BY event_id
      `;
      assert.deepEqual(
        remaining.map((row) => row.event_id),
        ["v1-pending:1", "v1-pending:2", "v1-project:1", "v2:1"],
      );
      assert.deepEqual(yield* purgeImportedLegacyV1Fork(sql), { events: 0 });
    }),
  );
});
