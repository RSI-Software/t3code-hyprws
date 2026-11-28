import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { ensureForkSchema } from "./ForkSchema.ts";
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

layer("ForkSchema columns", (it) => {
  it.effect("adds fork columns to rows saved before them, left null", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`ALTER TABLE auth_external_mcp_requests DROP COLUMN pinned_target`;
      yield* sql`ALTER TABLE fork_collaborator_messages DROP COLUMN force_reply`;
      assert.isTrue(yield* hasPendingMigrations());
      yield* sql`
        INSERT INTO auth_external_mcp_requests
          (session_id, operation, client_request_id, request_hash, result_json, created_at)
        VALUES ('s', 'interrupt', 'k', 'h', NULL, '2026-10-05T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO fork_collaborator_messages
          (id, thread_id, subject, collaborator_name, text, submitted_at)
        VALUES ('m', 't', 's', 'Sam', 'hi', '2026-11-20T00:00:00.000Z')
      `;
      yield* runMigrations();
      assert.isFalse(yield* hasPendingMigrations());
      const pins = yield* sql<{ readonly pinned: string | null }>`
        SELECT pinned_target AS "pinned" FROM auth_external_mcp_requests
      `;
      assert.deepStrictEqual(pins, [{ pinned: null }]);
      // A collaborator request saved before "Ask the agent" loads as a normal one.
      const requests = yield* sql<{ readonly text: string; readonly force: number | null }>`
        SELECT text, force_reply AS "force" FROM fork_collaborator_messages
      `;
      assert.deepStrictEqual(requests, [{ text: "hi", force: null }]);
    }),
  );
});
