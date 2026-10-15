// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { forkSupersedes } from "../../../../scripts/lib/fork-supersedes.ts";
import * as SqlitePersistence from "./Sqlite.ts";

forkSupersedes({
  upstream:
    "apps/server/src/persistence/Sqlite.test.ts > collects planner statistics for an existing database on open",
  reason:
    "fork tables push the schema past 100 btrees, so PRAGMA optimize scales its analysis_limit down and samples the probe index instead of counting it exactly",
  commit: "92321a73e0",
});
it.effect("collects planner statistics for an existing database on open, sampled", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE stats_probe(id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL)`;
      yield* sql`CREATE INDEX stats_probe_thread_idx ON stats_probe(thread_id)`;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
        INSERT INTO stats_probe(thread_id) SELECT 'thread-' || (i % 10) FROM n
      `;
    }).pipe(Effect.provide(persistence()));

    // The row count stays exact; only the per-key estimate is sampled.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly stat: string }>`
        SELECT stat FROM sqlite_stat1 WHERE idx = 'stats_probe_thread_idx'
      `;
      assert.lengthOf(rows, 1);
      const [count, perKey] = (rows[0]?.stat ?? "").split(" ").map(Number);
      assert.equal(count, 1000);
      assert.isAtLeast(perKey ?? 0, 90);
      assert.isAtMost(perKey ?? 0, 110);
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
