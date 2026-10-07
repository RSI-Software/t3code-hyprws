import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { listLinkedIssueThreadsFork } from "../../githubIssue/linkedThreads.fork.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { withThreadIssues } from "../ThreadIssues.fork.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import {
  importLegacyThreadIssuesFork,
  legacyThreadIssuesEventIdFork,
} from "./LegacyV1ThreadIssues.fork.ts";

const storesProvided = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  EventStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);
const eventSinkProvided = EventSink.layer.pipe(Layer.provide(storesProvided));
const TestLayer = Layer.mergeAll(
  storesProvided,
  eventSinkProvided,
  LegacyV1ThreadImporter.layer.pipe(
    Layer.provide(Layer.mergeAll(storesProvided, eventSinkProvided)),
  ),
  ProjectionMaintenance.layer.pipe(Layer.provide(storesProvided)),
);

const createdAt = "2026-01-01T00:00:00.000Z";
const updatedAt = "2026-01-05T00:00:00.000Z";
const linked = ThreadId.make("thread:legacy-issues");
const deleted = ThreadId.make("thread:legacy-issues-deleted");
const plain = ThreadId.make("thread:legacy-no-issues");

const issueLink = (number: number, linkedAt: string, snapshot: string | null = null) => ({
  host: "github.com",
  repository: "acme/web",
  number,
  url: `https://github.com/acme/web/issues/${number}`,
  linkedAt,
  snapshot,
});

it.layer(TestLayer)("V1 issue link import", (it) => {
  it.effect("imports each live thread's V1 issue links once, keeping V2 changes after", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const eventSink = yield* EventSink.EventSinkV2;

      for (const [threadId, deletedAt] of [
        [linked, null],
        [deleted, updatedAt],
        [plain, null],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            created_at, updated_at, deleted_at
          ) VALUES (
            ${threadId}, 'project:legacy-issues', ${threadId},
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
            ${createdAt}, ${updatedAt}, ${deletedAt}
          )
        `;
      }
      const rows = [
        { threadId: linked, ...issueLink(8, "2026-01-03T00:00:00.000Z") },
        {
          threadId: linked,
          ...issueLink(
            7,
            "2026-01-02T00:00:00.000Z",
            '{"title":"Fix it","state":"closed","syncedAt":"2026-01-04T00:00:00.000Z"}',
          ),
        },
        { threadId: deleted, ...issueLink(7, "2026-01-02T00:00:00.000Z") },
        // A link whose thread never reached V2 is left behind.
        { threadId: ThreadId.make("thread:missing"), ...issueLink(7, "2026-01-02T00:00:00.000Z") },
      ];
      for (const row of rows) {
        yield* sql`
          INSERT INTO projection_thread_issues (
            thread_id, host, repository, number, url, source, linked_at, snapshot_json
          ) VALUES (
            ${row.threadId}, ${row.host}, ${row.repository}, ${row.number}, ${row.url},
            'manual', ${row.linkedAt}, ${row.snapshot}
          )
        `;
      }

      yield* importer.reconcileShells;
      const imported = yield* projections.getThread(linked);
      assert.deepStrictEqual(imported.issues, [
        {
          host: "github.com",
          repository: "acme/web",
          number: 7,
          url: "https://github.com/acme/web/issues/7",
          source: "manual",
          linkedAt: "2026-01-02T00:00:00.000Z",
          snapshot: { title: "Fix it", state: "closed", syncedAt: "2026-01-04T00:00:00.000Z" },
        },
        {
          host: "github.com",
          repository: "acme/web",
          number: 8,
          url: "https://github.com/acme/web/issues/8",
          source: "manual",
          linkedAt: "2026-01-03T00:00:00.000Z",
          snapshot: null,
        },
      ]);
      // The import is not activity, and threads without V1 links stay link-free.
      assert.strictEqual(imported.updatedAt.epochMilliseconds, Date.parse(updatedAt));
      assert.isFalse("issues" in (yield* projections.getThread(plain)));
      assert.isFalse("issues" in (yield* projections.getThread(deleted)));
      assert.deepStrictEqual(
        (yield* listLinkedIssueThreadsFork({
          host: "github.com",
          repository: "acme/web",
          number: 7,
        })).threads.map((thread) => thread.id),
        [linked],
      );

      // A V2 unlink survives every later startup, and a rebuild agrees.
      yield* eventSink.write({
        events: [
          {
            id: legacyThreadIssuesEventIdFork(ThreadId.make("unlink-probe")),
            type: "thread.metadata-updated",
            threadId: linked,
            providerInstanceId: imported.providerInstanceId,
            occurredAt: imported.updatedAt,
            payload: withThreadIssues(imported, []),
          },
        ],
      });
      yield* importer.reconcileShells;
      assert.isFalse("issues" in (yield* projections.getThread(linked)));
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.isFalse("issues" in (yield* projections.getThread(linked)));
      const markers = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events
        WHERE event_id = ${legacyThreadIssuesEventIdFork(linked)}
      `;
      assert.strictEqual(markers[0]?.count, 1);
    }),
  );

  it.effect("counts an undecodable thread's links as skipped and retries them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const broken = ThreadId.make("thread:legacy-issues-broken");
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at
        ) VALUES (
          ${broken}, 'project:legacy-issues', ${broken},
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          ${createdAt}, ${updatedAt}, NULL
        )
      `;
      const link = issueLink(9, "2026-01-02T00:00:00.000Z");
      yield* sql`
        INSERT INTO projection_thread_issues (
          thread_id, host, repository, number, url, source, linked_at, snapshot_json
        ) VALUES (
          ${broken}, ${link.host}, ${link.repository}, ${link.number}, ${link.url},
          'not-a-source', ${link.linkedAt}, NULL
        )
      `;

      yield* importer.reconcileShells;
      assert.isFalse("issues" in (yield* projections.getThread(broken)));
      assert.deepStrictEqual(yield* importLegacyThreadIssuesFork(sql, eventSink), {
        importedLinkCount: 0,
        undecodedThreadCount: 1,
      });
    }),
  );
});
