import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId, type ServerSettings } from "@t3tools/contracts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );
it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("folds a legacy zmuxSessions opt-in into the terminal session mode on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, '{"zmuxSessions":true}');
      const settings = yield* serverSettings.getSettings;
      assert.strictEqual(settings.terminalSessionMode, "zmux");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
  it.effect("keeps an explicit terminal session mode over the legacy zmuxSessions flag", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"zmuxSessions":true,"terminalSessionMode":"shell"}',
      );
      const settings = yield* serverSettings.getSettings;
      assert.strictEqual(settings.terminalSessionMode, "shell");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
  it.effect("folds a legacy worktrunk project row as the wire env-mode pair", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const worktrunkProject = ProjectId.make("project-worktrunk");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          default_thread_env_mode, auto_pull, scripts_json, created_at, updated_at
        )
        VALUES (
          ${worktrunkProject}, ${"Project"}, ${`/tmp/${worktrunkProject}`}, ${null},
          ${"worktrunk"}, ${0}, ${"[]"},
          ${"2026-08-25T00:00:00.000Z"}, ${"2026-08-25T00:00:00.000Z"}
        )
      `;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{}");

      const settings = yield* serverSettings.getSettings;
      assert.deepEqual<ServerSettings["projectSettingsOverrides"]>(
        settings.projectSettingsOverrides,
        {
          [worktrunkProject]: {
            defaultThreadEnvMode: "worktree",
            defaultThreadEnvModeFork: "worktrunk",
          },
        },
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
