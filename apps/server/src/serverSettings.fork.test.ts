import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
});
