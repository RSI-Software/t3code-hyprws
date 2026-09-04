import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationCommand,
  type OrchestrationProject,
  ProjectId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { reconcilePersistedProjectSetupScripts } from "./serverRuntimeStartup.ts";

const legacyGeneratedCommand =
  "vp i && ln -sf $T3CODE_PROJECT_ROOT/.env .env && " +
  "ln -sf $T3CODE_PROJECT_ROOT/infra/relay/.env infra/relay/.env && " +
  "node apps/web/scripts/warm-dep-cache.ts";

const makeProject = (
  id: string,
  command: string,
  metadata: Partial<OrchestrationProject["scripts"][number]> = {},
): OrchestrationProject => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/repo/${id}`,
  defaultModelSelection: null,
  scripts: [
    {
      id: "setup-worktree",
      name: "Setup Worktree",
      command,
      icon: "configure",
      runOnWorktreeCreate: true,
      ...metadata,
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

it.effect("persists only an unmodified imported fork setup command", () => {
  const stale = makeProject("stale", legacyGeneratedCommand);
  const custom = makeProject("custom", "vp i && ./scripts/configure-worktree.sh");
  const dispatched: OrchestrationCommand[] = [];

  return reconcilePersistedProjectSetupScripts.pipe(
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
      getCommandReadModel: () => Effect.succeed({ projects: [stale, custom] } as never),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () => Effect.die("unused thread replay stats"),
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command)).pipe(
          Effect.as({ sequence: dispatched.length }),
        ),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(NodeServices.layer),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.equal(dispatched.length, 1);
        const command = dispatched[0];
        assert.equal(command?.type, "project.meta.update");
        if (command?.type !== "project.meta.update") {
          return;
        }
        assert.equal(command.projectId, stale.id);
        assert.deepStrictEqual(command.scripts, [
          {
            ...stale.scripts[0]!,
            command: "node scripts/setup-worktree.ts",
          },
        ]);
      }),
    ),
  );
});
