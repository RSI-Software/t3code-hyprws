import * as NodeServices from "@effect/platform-node/NodeServices";
import { type OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectService from "./project/ProjectService.ts";
import { reconcileSetupScriptsFork } from "./serverRuntimeStartup.fork.ts";

const legacyGeneratedCommand =
  "vp i && ln -sf $T3CODE_PROJECT_ROOT/.env .env && " +
  "ln -sf $T3CODE_PROJECT_ROOT/infra/relay/.env infra/relay/.env && " +
  "node apps/web/scripts/warm-dep-cache.ts";

const makeProject = (id: string, command: string): OrchestrationProjectShell => ({
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
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

it.effect("persists only an unmodified imported fork setup command", () => {
  const stale = makeProject("stale", legacyGeneratedCommand);
  const custom = makeProject("custom", "vp i && ./scripts/configure-worktree.sh");
  const updates: ProjectService.ProjectUpdateInput[] = [];

  return reconcileSetupScriptsFork.pipe(
    Effect.provideService(ProjectStore.ProjectStoreV2, {
      listShells: () => Effect.succeed([stale, custom]),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    Effect.provideService(ProjectService.ProjectService, {
      update: (input: ProjectService.ProjectUpdateInput) =>
        Effect.sync(() => updates.push(input)).pipe(Effect.as({} as never)),
    } as unknown as ProjectService.ProjectService["Service"]),
    Effect.provide(NodeServices.layer),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.equal(updates.length, 1);
        assert.equal(updates[0]?.projectId, stale.id);
        assert.deepStrictEqual(updates[0]?.scripts, [
          { ...stale.scripts[0]!, command: "node scripts/setup-worktree.ts" },
        ]);
      }),
    ),
  );
});
