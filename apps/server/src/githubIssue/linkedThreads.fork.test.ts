import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { listLinkedIssueThreadsFork } from "./linkedThreads.fork.ts";

it.effect("finds every readable thread linked to exactly one issue, across projects, by host", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const createdAt = "2026-09-01T00:00:00.000Z";
    const laterAt = "2026-09-03T00:00:00.000Z";
    for (const projectId of ["project-1", "project-2"]) {
      yield* sql`
          INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES (${projectId}, ${projectId}, ${`/tmp/${projectId}`}, '[]', ${createdAt}, ${createdAt})
        `;
    }
    const fixtures = [
      {
        id: "active",
        projectId: "project-1",
        host: "github.com",
        repository: "acme/web",
        number: 7,
      },
      {
        id: "archived",
        projectId: "project-2",
        host: "github.com",
        repository: "acme/web",
        number: 7,
      },
      {
        id: "deleted",
        projectId: "project-1",
        host: "github.com",
        repository: "acme/web",
        number: 7,
      },
      {
        id: "enterprise",
        projectId: "project-1",
        host: "github.example.com",
        repository: "acme/web",
        number: 7,
      },
      {
        id: "other-repo",
        projectId: "project-1",
        host: "github.com",
        repository: "acme/api",
        number: 7,
      },
      {
        id: "other-number",
        projectId: "project-1",
        host: "github.com",
        repository: "acme/web",
        number: 8,
      },
    ];
    for (const fixture of fixtures) {
      yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, created_at, updated_at, archived_at, deleted_at
          ) VALUES (
            ${fixture.id}, ${fixture.projectId}, ${fixture.id}, '{"instanceId":"codex","model":"gpt-5.4"}',
            ${createdAt}, ${fixture.id === "archived" ? laterAt : createdAt},
            ${fixture.id === "archived" ? laterAt : null},
            ${fixture.id === "deleted" ? laterAt : null}
          )
        `;
      yield* sql`
          INSERT INTO projection_thread_issues (thread_id, host, repository, number, url, source, linked_at)
          VALUES (${fixture.id}, ${fixture.host}, ${fixture.repository}, ${fixture.number},
            ${`https://${fixture.host}/${fixture.repository}/issues/${fixture.number}`}, 'manual', ${createdAt})
        `;
    }

    expect(
      yield* listLinkedIssueThreadsFork({ host: "GitHub.com", repository: "ACME/Web", number: 7 }),
    ).toEqual({
      threads: [
        { id: "archived", projectId: "project-2", title: "archived", archivedAt: laterAt },
        { id: "active", projectId: "project-1", title: "active", archivedAt: null },
      ],
    });
    expect(
      (yield* listLinkedIssueThreadsFork({
        host: "github.example.com",
        repository: "acme/web",
        number: 7,
      })).threads.map((thread) => thread.id),
    ).toEqual(["enterprise"]);
    expect(
      yield* listLinkedIssueThreadsFork({ host: "github.com", repository: "acme/web", number: 9 }),
    ).toEqual({ threads: [] });
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
