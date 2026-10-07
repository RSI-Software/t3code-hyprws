import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "ProjectStoreV2 (fork)",
  (it) => {
    it.effect("reads a project the V1 fork projection stored with the worktrunk default", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-worktrunk");
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            default_thread_env_mode, scripts_json, created_at, updated_at, deleted_at
          )
          VALUES (
            ${projectId}, 'Worktrunk project', '/tmp/project-worktrunk', NULL,
            'worktrunk', '[]', '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:01.000Z', NULL
          )
        `;
        // The project wire slot only decodes "local" and "worktree"; the exact
        // mode lives in the project settings override, so the row reads as the
        // worktree it behaves like instead of failing the whole project list.
        const shells = yield* projects.listShells();
        assert.deepStrictEqual(
          shells.map((shell) => shell.defaultThreadEnvMode),
          ["worktree"],
        );
        assert.strictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultThreadEnvMode,
          "worktree",
        );
      }),
    );
  },
);
