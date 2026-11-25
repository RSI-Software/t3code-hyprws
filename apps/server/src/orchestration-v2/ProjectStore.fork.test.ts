import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
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

it.effect("keeps a team project marked across a server restart until it is unmarked", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dbPath = `${yield* fs.makeTempDirectoryScoped()}/state.sqlite`;
    const session = <A, E>(
      body: (projects: ProjectStore.ProjectStoreV2["Service"]) => Effect.Effect<A, E>,
    ) =>
      Effect.flatMap(ProjectStore.ProjectStoreV2, body).pipe(
        Effect.provide(
          ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerFromPath(dbPath))),
        ),
      );
    const projectId = ProjectId.make("project-team");
    const at = "2026-11-25T00:00:00.000Z";
    let sequence = 0;
    const event = () => ({
      sequence: ++sequence,
      eventId: EventId.make(`event-team-${sequence}`),
      aggregateKind: "project" as const,
      aggregateId: projectId,
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });
    const update = (fields: { readonly title?: string; readonly teamFork?: boolean }) => ({
      ...event(),
      type: "project.meta-updated" as const,
      payload: { projectId, ...fields, updatedAt: at },
    });
    const teamMarks = (projects: ProjectStore.ProjectStoreV2["Service"]) =>
      Effect.all([
        projects.listShells().pipe(Effect.map((shells) => shells.map((shell) => shell.teamFork))),
        projects.get(projectId).pipe(Effect.map((row) => Option.getOrNull(row)?.teamFork)),
      ]);

    yield* session((projects) =>
      Effect.gen(function* () {
        yield* projects.apply({
          ...event(),
          type: "project.created",
          payload: {
            projectId,
            title: "Team project",
            workspaceRoot: "/tmp/project-team",
            defaultModelSelection: null,
            scripts: [],
            createdAt: at,
            updatedAt: at,
          },
        });
        yield* projects.apply(update({ teamFork: true }));
      }),
    );

    const afterRestart = yield* session((projects) =>
      Effect.gen(function* () {
        const marked = yield* teamMarks(projects);
        // An update that leaves the mark out keeps it.
        yield* projects.apply(update({ title: "Renamed team project" }));
        const renamed = yield* teamMarks(projects);
        yield* projects.apply(update({ teamFork: false }));
        return { marked, renamed, unmarked: yield* teamMarks(projects) };
      }),
    );
    assert.deepStrictEqual(afterRestart, {
      marked: [[true], true],
      renamed: [[true], true],
      unmarked: [[undefined], undefined],
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
