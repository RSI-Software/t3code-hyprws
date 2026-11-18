import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { ensureForkSchema, repairStaleForkMigrationRow } from "./ForkSchema.ts";
import { hasPendingMigrations, runMigrations } from "./Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("ForkSchema", (it) => {
  it.effect("rewrites fork-shaped issue links to upstream's shape", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const link = {
        url: "https://linear.app/acme/issue/PLAT-24/fix",
        linkedAt: "2026-09-01T00:00:00.000Z",
      };
      const shell = {
        projectId: "project-1",
        issues: [
          {
            ...link,
            host: "linear.app",
            repository: "acme/plat",
            number: 24,
            source: "handoff",
            snapshot: null,
          },
          {
            host: "github.com",
            repository: "Acme/Web",
            number: 7,
            url: "https://github.com/Acme/Web/issues/7",
            source: "agent",
            linkedAt: link.linkedAt,
            snapshot: { title: "Broken build" },
          },
        ],
      };
      yield* sql`
        INSERT INTO fork_colleague_shares (subject, thread_id, colleague_name, created_at, frozen_shell_json)
        VALUES ('s', 'thread-1', 'Sam', ${link.linkedAt}, ${JSON.stringify(shell)})
      `;
      assert.isTrue(yield* hasPendingMigrations());
      yield* ensureForkSchema();
      assert.isFalse(yield* hasPendingMigrations());
      const [row] = yield* sql<{ readonly json: string }>`
        SELECT frozen_shell_json AS json FROM fork_colleague_shares
      `;
      assert.deepStrictEqual(JSON.parse(row!.json).issues, [
        {
          tracker: "linear",
          host: "linear.app",
          scope: "PLAT",
          key: "PLAT-24",
          projectId: "project-1",
          url: link.url,
          source: "manual",
          linkedAt: link.linkedAt,
          displayKey: "PLAT-24",
          title: "PLAT-24",
        },
        {
          tracker: "github",
          host: "github.com",
          scope: "acme/web",
          key: "7",
          projectId: "project-1",
          url: "https://github.com/Acme/Web/issues/7",
          source: "agent",
          linkedAt: link.linkedAt,
          displayKey: "#7",
          title: "Broken build",
        },
      ]);
    }),
  );
});

// A separate top-level `layer(...)` block gets its own memo map, so its own in-memory database.
// A shared one would already be migrated past 048 by the earlier test, so `runMigrations` would
// have nothing left to run against the shipped-nightly state this models: a fresh database at
// 047 plus the stale fork row.
layer("ForkSchema repair", (it) => {
  it.effect("repairs a stale fork migration row so upstream 048 still runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 48`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (48, ${"ProjectionThreadCheckoutMove"})`;

      yield* repairStaleForkMigrationRow();
      const executed = yield* runMigrations();
      assert.ok(
        executed.some(([id, name]) => id === 48 && name === "ProjectionThreadBranchPullRequest"),
      );

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "branch_pull_request_json"));
    }),
  );
});

layer("ForkSchema columns", (it) => {
  it.effect("adds the interrupt pin to a request table created without it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`ALTER TABLE auth_external_mcp_requests DROP COLUMN pinned_target`;
      assert.isTrue(yield* hasPendingMigrations());
      yield* sql`
        INSERT INTO auth_external_mcp_requests
          (session_id, operation, client_request_id, request_hash, result_json, created_at)
        VALUES ('s', 'interrupt', 'k', 'h', NULL, '2026-10-05T00:00:00.000Z')
      `;
      yield* runMigrations();
      assert.isFalse(yield* hasPendingMigrations());
      const rows = yield* sql<{ readonly pinned: string | null }>`
        SELECT pinned_target AS "pinned" FROM auth_external_mcp_requests
      `;
      assert.deepStrictEqual(rows, [{ pinned: null }]);
    }),
  );
});
