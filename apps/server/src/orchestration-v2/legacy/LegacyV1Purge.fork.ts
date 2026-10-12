// Fork-owned purge of V1 rows the V2 runtime never reads. Every V2 reader selects
// only `application_event_version = 2` thread events, so a thread's V1 events are
// dead once its transcript import finishes, and `projection_thread_activities`
// has no reader at all. Upstream's `ProjectionMaintenance.compactEventStore` also
// drops these events but has no production caller, and its thread-state
// supersession would delete the fork's legacy issue markers. Retire this when
// upstream schedules its own compaction and the markers no longer depend on events.
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

// Measured on a 12 GB database: 200-row pages hold the connection for a p99 of
// 171 ms, and the pause keeps the purge from saturating the disk.
const PAGE_SIZE = 200;
const PAGE_PAUSE = "50 millis";

/** Deletes one page at a time; each page commits alone so requests interleave. */
const drainPages = Effect.fn("LegacyV1Purge.drainPages")(function* (
  deletePage: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>,
) {
  let deleted = 0;
  while (true) {
    const rows = yield* deletePage;
    deleted += rows.length;
    if (rows.length < PAGE_SIZE) return deleted;
    yield* Effect.sleep(PAGE_PAUSE);
  }
});

/** Runs after the background transcript import; a no-op once the V1 rows are gone. */
export const purgeImportedLegacyV1Fork = Effect.fn("purgeImportedLegacyV1Fork")(
  function* (sql: SqlClient.SqlClient) {
    const events = yield* drainPages(sql`
      DELETE FROM orchestration_events
      WHERE sequence IN (
        SELECT sequence
        FROM orchestration_events INDEXED BY idx_orchestration_events_application_sequence
        WHERE application_event_version = 1
          AND aggregate_kind = 'thread'
          AND stream_id IN (
            SELECT thread_id FROM orchestration_v2_legacy_imports
            WHERE transcript_imported_at IS NOT NULL
          )
        LIMIT ${PAGE_SIZE}
      )
      RETURNING sequence
    `);
    const activities = yield* drainPages(sql`
      DELETE FROM projection_thread_activities
      WHERE rowid IN (SELECT rowid FROM projection_thread_activities LIMIT ${PAGE_SIZE})
      RETURNING rowid
    `);
    if (events + activities > 0) {
      yield* Effect.logInfo("Purged imported legacy v1 rows", { events, activities });
    }
    return { events, activities };
  },
  // A failed purge leaves the rest for the next startup.
  Effect.catchCause((cause) =>
    Effect.logWarning("Legacy v1 purge stopped", { cause }).pipe(
      Effect.as({ events: 0, activities: 0 }),
    ),
  ),
);
