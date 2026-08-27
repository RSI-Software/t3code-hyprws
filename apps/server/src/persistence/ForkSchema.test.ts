import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ensureForkSchema } from "./ForkSchema.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("ForkSchema", (it) => {
  it.effect("adds the worktrunk hooks column once after the upstream migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const first = yield* ensureForkSchema();
      assert.deepStrictEqual(first, ["projection_projects.worktrunk_hooks"]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.ok(columns.some((column) => column.name === "worktrunk_hooks"));

      const second = yield* ensureForkSchema();
      assert.deepStrictEqual(second, []);
    }),
  );
});
