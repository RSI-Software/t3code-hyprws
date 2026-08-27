import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork-owned columns, added after the upstream migration sequence has run.
 *
 * Upstream numbers its migrations sequentially, so a fork migration in that
 * sequence collides with the next upstream release and a database migrated by
 * either build skips the other's step. Fork columns instead land through this
 * idempotent pass: each one is checked with `PRAGMA table_info` and added when
 * missing, whatever the migration table says.
 */
const FORK_COLUMNS = [
  // Per-project Worktrunk hooks override for the worktrunk-hooks domain.
  { table: "projection_projects", column: "worktrunk_hooks", definition: "INTEGER" },
] as const;

export const ensureForkSchema = Effect.fn("ensureForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const added: string[] = [];

  for (const { table, column, definition } of FORK_COLUMNS) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
    if (columns.some((existing) => existing.name === column)) continue;
    yield* sql`ALTER TABLE ${sql.literal(table)} ADD COLUMN ${sql.literal(column)} ${sql.literal(definition)}`;
    added.push(`${table}.${column}`);
  }

  if (added.length > 0) {
    yield* Effect.log("Fork schema columns added").pipe(Effect.annotateLogs({ added }));
  }
  return added;
});
