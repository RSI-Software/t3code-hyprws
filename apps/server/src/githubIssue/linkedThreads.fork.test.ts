import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { listLinkedIssueThreadsFork } from "./linkedThreads.fork.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("finds every readable thread linked to exactly one issue, across projects, by host", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const createdAt = "2026-09-01T00:00:00.000Z";
    const laterAt = "2026-09-03T00:00:00.000Z";
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
      const payload = yield* encodePayload({
        issues: [
          {
            host: fixture.host,
            repository: fixture.repository,
            number: fixture.number,
            url: `https://${fixture.host}/${fixture.repository}/issues/${fixture.number}`,
            source: "manual",
            linkedAt: createdAt,
            snapshot: null,
          },
        ],
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${fixture.id}, ${fixture.projectId}, ${fixture.id}, 'codex', 'full-access', 'default',
          ${createdAt}, ${fixture.id === "archived" ? laterAt : createdAt},
          ${fixture.id === "archived" ? laterAt : null},
          ${fixture.id === "deleted" ? laterAt : null}, ${payload}
        )
      `;
    }
    // A thread from before issue links has no `issues` key at all.
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        'pre-feature', 'project-1', 'pre-feature', 'codex', 'full-access', 'default',
        ${createdAt}, ${createdAt}, '{"pullRequests":[]}'
      )
    `;

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
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
