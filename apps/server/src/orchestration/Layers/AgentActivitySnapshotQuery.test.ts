import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery agent activity", (it) => {
  it.effect("paginates only rows owned by a thread member", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Project 1', '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, linked_pull_request_json,
          latest_turn_id, latest_user_message_at, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan,
          created_at, updated_at, deleted_at
        ) VALUES (
          'thread-1', 'project-1', 'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access',
          'default', NULL, NULL, NULL, NULL, NULL, 0, 0, 0,
          '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', NULL
        )
      `;

      const rows = [
        ["activity-1", "task.started", '{"taskId":"agent-1","agentKind":"agent"}', 1],
        ["activity-2", "tool.started", '{"agentId":"agent-1","detail":"first"}', 2],
        ["activity-3", "task.started", '{"taskId":"other-agent","agentKind":"agent"}', 3],
        ["activity-4", "tool.completed", '{"agentId":"agent-1","detail":"second"}', 4],
        ["activity-5", "task.completed", '{"taskId":"agent-1","agentKind":"agent"}', 5],
      ] as const;
      for (const [activityId, kind, payload, sequence] of rows) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary,
            payload_json, sequence, created_at
          ) VALUES (
            ${activityId}, 'thread-1', NULL, 'tool', ${kind}, ${kind},
            ${payload}, ${sequence}, ${`2026-08-28T00:00:0${sequence}.000Z`}
          )
        `;
      }
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 20, '2026-08-28T00:00:20.000Z')
        `;
      }

      const first = Option.getOrThrow(
        yield* snapshotQuery.getAgentActivitySnapshot(ThreadId.make("thread-1"), "agent-1", {
          limit: 2,
        }),
      );
      assert.deepEqual(
        first.activities.map((activity) => activity.id),
        ["activity-4", "activity-5"],
      );
      assert.equal(first.page.hasMore, true);
      assert.equal(first.page.snapshotSequence, 20);
      assert.equal(first.page.threadSequence, 0);
      assert.isString(first.page.beforeCursor);

      const second = Option.getOrThrow(
        yield* snapshotQuery.getAgentActivitySnapshot(ThreadId.make("thread-1"), "agent-1", {
          limit: 2,
          beforeCursor: first.page.beforeCursor!,
        }),
      );
      assert.deepEqual(
        second.activities.map((activity) => activity.id),
        ["activity-1", "activity-2"],
      );
      assert.equal(second.page.hasMore, false);
      assert.equal(second.page.beforeCursor, null);

      const foreign = yield* snapshotQuery.getAgentActivitySnapshot(
        ThreadId.make("thread-1"),
        "missing-agent",
        { limit: 2 },
      );
      assert.isTrue(Option.isNone(foreign));
      const missingThread = yield* snapshotQuery.getAgentActivitySnapshot(
        ThreadId.make("missing-thread"),
        "agent-1",
        { limit: 2 },
      );
      assert.isTrue(Option.isNone(missingThread));
    }),
  );
});
