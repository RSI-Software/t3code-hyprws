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
  // Durable checkout-move state machine for the zmux-estate domain.
  { table: "projection_threads", column: "checkout_move_json", definition: "TEXT" },
] as const;

/**
 * Fork-owned tables, created idempotently after the upstream migrations for
 * the same reason as the columns above. They report nothing: a fresh database
 * and an upgraded one both simply have them afterwards.
 */
const FORK_TABLES = [
  // V1 thread ↔ GitHub issue links for the github-issues domain. V2 keeps links
  // on the thread payload; only the legacy import reads this table, so it stays
  // for databases that predate V2 and fresh ones alike.
  `CREATE TABLE IF NOT EXISTS projection_thread_issues (
    thread_id TEXT NOT NULL,
    host TEXT NOT NULL,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    source TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    snapshot_json TEXT,
    PRIMARY KEY (thread_id, host, repository, number)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projection_thread_issues_issue
    ON projection_thread_issues(host, repository, number)`,
  // Owner-approved native client requests for the device-auth domain. Only a
  // digest of the device code is stored; rows prune once expired.
  `CREATE TABLE IF NOT EXISTS auth_device_authorizations (
    device_code_hash TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    client_json TEXT NOT NULL,
    requested_scopes TEXT,
    proof_key_thumbprint TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_polled_at TEXT,
    last_proof_iat INTEGER,
    granted_scopes TEXT,
    granted_ttl_ms INTEGER,
    decided_at TEXT,
    session_id TEXT
  )`,
] as const;

/**
 * Shipped-nightly repair for fork nightlies
 * `v0.0.39-hyprws-nightly.20260906.337`–`.341`, which recorded the fork column
 * as numbered migration row `(48, "ProjectionThreadCheckoutMove")`.
 *
 * The Migrator only runs migrations with an id above the latest recorded id,
 * so that stale fork row would make upstream's real 048
 * (`ProjectionThreadBranchPullRequest`) skip: latest id 48 is not below 48.
 * Delete exactly that row before `runMigrations` so upstream's guarded 048
 * runs; the post-migration pass below then re-adds the fork column.
 */
export const repairStaleForkMigrationRow = Effect.fn("repairStaleForkMigrationRow")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
  if (!tables.some((table) => table.name === "effect_sql_migrations")) return;
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 48 AND name = ${"ProjectionThreadCheckoutMove"}`;
});

export const ensureForkSchema = Effect.fn("ensureForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const added: string[] = [];

  for (const { table, column, definition } of FORK_COLUMNS) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
    if (columns.some((existing) => existing.name === column)) continue;
    yield* sql`ALTER TABLE ${sql.literal(table)} ADD COLUMN ${sql.literal(column)} ${sql.literal(definition)}`;
    added.push(`${table}.${column}`);
  }

  for (const statement of FORK_TABLES) {
    yield* sql.unsafe(statement);
  }

  if (added.length > 0) {
    yield* Effect.log("Fork schema columns added").pipe(Effect.annotateLogs({ added }));
  }
  return added;
});
