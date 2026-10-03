import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { ensureForkSchema, repairStaleForkMigrationRow } from "./ForkSchema.ts";
import { runMigrations } from "./Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("ForkSchema", (it) => {
  it.effect("adds the checkout move column once after the upstream migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const first = yield* ensureForkSchema();
      assert.deepStrictEqual(first, ["projection_threads.checkout_move_json"]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "checkout_move_json"));

      const second = yield* ensureForkSchema();
      assert.deepStrictEqual(second, []);
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
