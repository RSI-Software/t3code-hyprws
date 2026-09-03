import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);
projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("sends a stored worktrunk default as the wire pair every client decodes", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          default_thread_env_mode,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-worktrunk',
          'Worktrunk project',
          '/tmp/project-worktrunk',
          NULL,
          'worktrunk',
          '[]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;
      // A released client validates the field against "local" and "worktree"
      // only, and drops the whole payload on anything else. The exact mode
      // rides alongside in a key that client ignores.
      const shellProject = (yield* snapshotQuery.getShellSnapshot()).projects[0];
      assert.equal(shellProject?.defaultThreadEnvMode, "worktree");
      assert.equal(shellProject?.defaultThreadEnvModeFork, "worktrunk");
      const project = (yield* snapshotQuery.getSnapshot()).projects[0];
      assert.equal(project?.defaultThreadEnvMode, "worktree");
      assert.equal(project?.defaultThreadEnvModeFork, "worktrunk");
    }),
  );
});
