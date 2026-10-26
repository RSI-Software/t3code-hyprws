import * as NodeServices from "@effect/platform-node/NodeServices";
import { type OrchestrationProjectShell, ProjectId, type ProjectScript } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ServerSettings from "./serverSettings.ts";
import { reconcileSetupScriptsFork } from "./serverRuntimeStartup.fork.ts";

const legacyGeneratedCommand =
  "vp i && ln -sf $T3CODE_PROJECT_ROOT/.env .env && " +
  "ln -sf $T3CODE_PROJECT_ROOT/infra/relay/.env infra/relay/.env && " +
  "node apps/web/scripts/warm-dep-cache.ts";

const setupScript = (command: string): ProjectScript => ({
  id: "setup-worktree",
  name: "Setup Worktree",
  command,
  icon: "configure",
  runOnWorktreeCreate: true,
});

const makeProject = (id: string, command: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/repo/${id}`,
  defaultModelSelection: null,
  scripts: [setupScript(command)],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const reconcile = (input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly updates: ProjectService.ProjectUpdateInput[];
}) =>
  reconcileSetupScriptsFork.pipe(
    Effect.provideService(ProjectStore.ProjectStoreV2, {
      listShells: () => Effect.succeed(input.projects),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    Effect.provideService(ProjectService.ProjectService, {
      update: (update: ProjectService.ProjectUpdateInput) =>
        Effect.sync(() => input.updates.push(update)).pipe(Effect.as({} as never)),
    } as unknown as ProjectService.ProjectService["Service"]),
  );

it.effect("persists only an unmodified imported fork setup command", () => {
  const stale = makeProject("stale", legacyGeneratedCommand);
  const custom = makeProject("custom", "vp i && ./scripts/configure-worktree.sh");
  const updates: ProjectService.ProjectUpdateInput[] = [];

  return reconcile({ projects: [stale, custom], updates }).pipe(
    Effect.provide(
      Layer.merge(ServerSettings.ServerSettingsService.layerTest(), NodeServices.layer),
    ),
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

it.effect("refreshes a legacy generated setup command in project settings overrides", () => {
  const stale = ProjectId.make("stale");
  const custom = ProjectId.make("custom");
  const customScripts = [setupScript("vp i && ./scripts/configure-worktree.sh")];

  return Effect.gen(function* () {
    yield* reconcile({ projects: [], updates: [] });
    const { projectSettingsOverrides } = yield* (yield* ServerSettings.ServerSettingsService)
      .getSettings;
    assert.deepStrictEqual(projectSettingsOverrides[stale], {
      defaultAutoPull: true,
      defaultProjectScripts: [setupScript("node scripts/setup-worktree.ts")],
    });
    assert.deepStrictEqual(projectSettingsOverrides[custom]?.defaultProjectScripts, customScripts);
  }).pipe(
    Effect.provide(
      Layer.merge(
        ServerSettings.ServerSettingsService.layerTest({
          projectSettingsOverrides: {
            [stale]: {
              defaultAutoPull: true,
              defaultProjectScripts: [setupScript("vp run setup:worktree")],
            },
            [custom]: { defaultProjectScripts: customScripts },
          },
        }),
        NodeServices.layer,
      ),
    ),
  );
});
