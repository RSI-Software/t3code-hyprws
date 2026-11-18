import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork-owned columns, added after the upstream migration sequence has run. A numbered fork
 * migration would collide with the next upstream release, so this idempotent pass checks each
 * column with `PRAGMA table_info` and adds it when missing, whatever the migration table says.
 */
const FORK_COLUMNS: ReadonlyArray<{
  readonly table: string;
  readonly column: string;
  readonly definition: string;
}> = [
  // The external MCP policy an owner attached to a device approval.
  { table: "auth_device_authorizations", column: "mcp_policy_json", definition: "TEXT" },
  // The run an external MCP interrupt committed to, read back by its retry.
  { table: "auth_external_mcp_requests", column: "pinned_target", definition: "TEXT" },
  // A stopped collaborator share's thread shell, frozen when sharing stopped; null while live.
  { table: "fork_colleague_shares", column: "frozen_shell_json", definition: "TEXT" },
  // What a live share's collaborator messages may do: `send`, or `approve` to wait for the host.
  { table: "fork_colleague_shares", column: "access", definition: "TEXT" },
];

/**
 * Fork-owned tables, created idempotently after the upstream migrations for
 * the same reason as the columns above. They report nothing: a fresh database
 * and an upgraded one both simply have them afterwards.
 */
const FORK_TABLES = [
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
  // External MCP policies for device-authorized sessions, keyed by the session
  // the grant issued; the session's own expiry and revocation end the grant.
  `CREATE TABLE IF NOT EXISTS auth_external_mcp_grants (
    session_id TEXT PRIMARY KEY,
    policy_json TEXT NOT NULL,
    client_label TEXT,
    created_at TEXT NOT NULL
  )`,
  // External MCP retry keys: each binds one request's fingerprint to the
  // result it produced, so a retry replays it instead of acting again.
  `CREATE TABLE IF NOT EXISTS auth_external_mcp_requests (
    session_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, operation, client_request_id)
  )`,
  // Sidebar thread groups for the thread-ordering domain, in sidebar order.
  // Members are a JSON array of thread ids; a thread is in at most one group.
  `CREATE TABLE IF NOT EXISTS fork_thread_groups (
    group_id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    thread_ids_json TEXT NOT NULL,
    parent_thread_id TEXT
  )`,
  // Threads shared with a collaborator's pairing subject for the colleague-collab domain.
  `CREATE TABLE IF NOT EXISTS fork_colleague_shares (
    subject TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    colleague_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (subject, thread_id)
  )`,
  // Collaborator messages waiting for the host to send or dismiss them (colleague-collab).
  `CREATE TABLE IF NOT EXISTS fork_collaborator_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    collaborator_name TEXT NOT NULL,
    text TEXT NOT NULL,
    submitted_at TEXT NOT NULL
  )`,
] as const;

/**
 * Repairs fork nightlies `v0.0.39-hyprws-nightly.20260906.337`–`.341`, which recorded
 * migration row `(48, "ProjectionThreadCheckoutMove")`. The Migrator runs only ids above the
 * latest recorded one, so that row would skip upstream's real 048: delete exactly it before
 * `runMigrations`. Databases that already carry `checkout_move_json` keep that column unread.
 */
export const repairStaleForkMigrationRow = Effect.fn("repairStaleForkMigrationRow")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
  if (!tables.some((table) => table.name === "effect_sql_migrations")) return;
  // Read first: a current database takes no write, so a `query_only` recheck still passes.
  const stale =
    yield* sql`SELECT 1 FROM effect_sql_migrations WHERE migration_id = 48 AND name = ${"ProjectionThreadCheckoutMove"}`;
  if (stale.length === 0) return;
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 48 AND name = ${"ProjectionThreadCheckoutMove"}`;
});

// Payload columns that hold thread issue links under `$.issues`.
const ISSUE_LINK_PAYLOADS = [
  { table: "orchestration_v2_projection_threads", key: "thread_id", column: "payload_json" },
  { table: "fork_colleague_shares", key: "rowid", column: "frozen_shell_json" },
] as const;

type LegacyIssueLink = {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly source?: string;
  readonly linkedAt: string;
  readonly snapshot?: { readonly title?: string } | null;
};

/**
 * A link the retired fork issue panel stored (`host`, `repository`, `number`) in upstream's
 * tracker-keyed shape. Linear kept `workspace/TEAM` in `repository`; GitHub its `owner/repo`.
 */
function upstreamIssueLinkFork(link: LegacyIssueLink, projectId: string) {
  const linear = link.host.toLowerCase() === "linear.app";
  const scope = linear
    ? (link.repository.split("/")[1] ?? link.repository).toUpperCase()
    : link.repository.toLowerCase();
  const key = linear ? `${scope}-${link.number}` : String(link.number);
  const displayKey = linear ? key : `#${link.number}`;
  return {
    tracker: linear ? "linear" : "github",
    host: link.host.toLowerCase(),
    scope,
    key,
    projectId,
    url: link.url,
    source: link.source === "agent" ? "agent" : "manual",
    linkedAt: link.linkedAt,
    displayKey,
    title: link.snapshot?.title?.trim() || displayKey,
  };
}

type IssueLinkIdentity = {
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
};

/** A payload with each legacy link rewritten and repeats of one issue dropped. */
function rewriteLegacyIssueLinksFork(json: string): string {
  const payload = JSON.parse(json) as {
    projectId: string;
    issues: ReadonlyArray<LegacyIssueLink | IssueLinkIdentity>;
  };
  const seen = new Set<string>();
  payload.issues = payload.issues.flatMap((link) => {
    const next = "tracker" in link ? link : upstreamIssueLinkFork(link, payload.projectId);
    const identity = JSON.stringify([next.tracker, next.host, next.scope, next.key]);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [next];
  });
  return JSON.stringify(payload);
}

const LEGACY_ISSUE_LINK_FILTER = (column: string) => `${column} IS NOT NULL
  AND json_valid(${column})
  AND EXISTS (
    SELECT 1 FROM json_each(${column}, '$.issues')
    WHERE json_extract(value, '$.tracker') IS NULL
  )`;

const tableExists = (sql: SqlClient.SqlClient, table: string) =>
  sql`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ${table}`.pipe(
    Effect.map((rows) => rows.length > 0),
  );

/** Rewrites every stored fork-shaped issue link so thread payloads decode under upstream. */
const repairForkIssueLinks = Effect.fn("repairForkIssueLinks")(function* () {
  const sql = yield* SqlClient.SqlClient;
  let repaired = 0;
  for (const { table, key, column } of ISSUE_LINK_PAYLOADS) {
    if (!(yield* tableExists(sql, table))) continue;
    const rows = yield* sql<{ readonly id: string | number; readonly payload: string }>`
      SELECT ${sql.literal(key)} AS id, ${sql.literal(column)} AS payload
      FROM ${sql.literal(table)}
      WHERE ${sql.literal(LEGACY_ISSUE_LINK_FILTER(column))}
    `;
    for (const row of rows) {
      yield* sql`
        UPDATE ${sql.literal(table)} SET ${sql.literal(column)} = ${rewriteLegacyIssueLinksFork(row.payload)}
        WHERE ${sql.literal(key)} = ${row.id}
      `;
      repaired += 1;
    }
  }
  if (repaired > 0) {
    yield* Effect.log("Fork issue links rewritten for upstream Issues").pipe(
      Effect.annotateLogs({ repaired }),
    );
  }
});

const hasLegacyIssueLinks = Effect.fn("hasLegacyIssueLinks")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const { table, column } of ISSUE_LINK_PAYLOADS) {
    if (!(yield* tableExists(sql, table))) continue;
    const rows = yield* sql`
      SELECT 1 FROM ${sql.literal(table)} WHERE ${sql.literal(LEGACY_ISSUE_LINK_FILTER(column))} LIMIT 1
    `;
    if (rows.length > 0) return true;
  }
  return false;
});

export const hasPendingForkSchema = Effect.fn("hasPendingForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (yield* hasLegacyIssueLinks()) return true;
  for (const { table, column } of FORK_COLUMNS) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
    if (!columns.some((existing) => existing.name === column)) return true;
  }
  for (const statement of FORK_TABLES) {
    const name = /CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/.exec(statement)![1]!;
    const rows = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = ${name}`;
    if (rows.length === 0) return true;
  }
  return false;
});

export const ensureForkSchema = Effect.fn("ensureForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const added: string[] = [];
  if (!(yield* hasPendingForkSchema())) return added;

  // Tables first, so a column can extend a fork table on a fresh database.
  for (const statement of FORK_TABLES) {
    yield* sql.unsafe(statement);
  }

  for (const { table, column, definition } of FORK_COLUMNS) {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
    if (columns.some((existing) => existing.name === column)) continue;
    yield* sql`ALTER TABLE ${sql.literal(table)} ADD COLUMN ${sql.literal(column)} ${sql.literal(definition)}`;
    added.push(`${table}.${column}`);
  }

  yield* repairForkIssueLinks();

  if (added.length > 0) {
    yield* Effect.log("Fork schema columns added").pipe(Effect.annotateLogs({ added }));
  }
  return added;
});
