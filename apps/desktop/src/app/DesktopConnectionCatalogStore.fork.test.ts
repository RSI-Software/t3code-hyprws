import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const safeStorageLayer = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
  isEncryptionAvailable: Effect.succeed(true),
  encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
  decryptString: (value) => Effect.succeed(textDecoder.decode(value).slice("encrypted:".length)),
  selectedStorageBackend: Effect.succeed(Option.none()),
} satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

function makeLayer(baseDir: string) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "linux",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  const dependencies = Layer.mergeAll(environmentLayer, safeStorageLayer, NodeServices.layer);

  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(DesktopSavedEnvironments.layer.pipe(Layer.provideMerge(dependencies))),
    Layer.provideMerge(dependencies),
  );
}

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-connection-catalog-fork-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopConnectionCatalogStore file mode", () => {
  it.effect("writes the catalog private to the user", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");

        // A world-readable predecessor must not survive the replacement, so the
        // catalog starts loose on purpose.
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, "{}", { mode: 0o644 });

        assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));

        const info = yield* fileSystem.stat(catalogPath);
        assert.equal(info.mode & 0o777, 0o600);
      }),
    ),
  );
});
