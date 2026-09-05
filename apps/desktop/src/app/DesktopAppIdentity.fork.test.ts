import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/repo/apps/desktop",
  isPackaged: false,
  resourcesPath: "/repo/apps/desktop/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

function resolveUserDataPath(
  environment: Readonly<Record<string, string | undefined>>,
  legacyPathExists: boolean,
  onLegacyProbe: () => void,
) {
  const environmentLayer = DesktopEnvironment.layer(environmentInput).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(environment))),
  );
  const fileSystemLayer = FileSystem.layerNoop({
    exists: () =>
      Effect.sync(() => {
        onLegacyProbe();
        return legacyPathExists;
      }),
  });
  return DesktopAppIdentity.resolveUserDataPath.pipe(
    Effect.provide(Layer.merge(environmentLayer, fileSystemLayer)),
  );
}

describe("DesktopAppIdentity fork user-data isolation", () => {
  it.effect("uses separate explicit development profiles without probing legacy state", () =>
    Effect.gen(function* () {
      let legacyProbes = 0;
      const sharedDevelopment = { VITE_DEV_SERVER_URL: "http://localhost:5173" };
      const first = yield* resolveUserDataPath(
        { ...sharedDevelopment, T3CODE_DESKTOP_USER_DATA_DIR: "/work/a/.t3/electron" },
        true,
        () => {
          legacyProbes += 1;
        },
      );
      const second = yield* resolveUserDataPath(
        { ...sharedDevelopment, T3CODE_DESKTOP_USER_DATA_DIR: "/work/b/.t3/electron" },
        true,
        () => {
          legacyProbes += 1;
        },
      );

      assert.equal(first, "/work/a/.t3/electron");
      assert.equal(second, "/work/b/.t3/electron");
      assert.equal(legacyProbes, 0);
    }),
  );

  it.effect("ignores the override outside development and preserves legacy resolution", () =>
    Effect.gen(function* () {
      let legacyProbes = 0;
      const path = yield* resolveUserDataPath(
        { T3CODE_DESKTOP_USER_DATA_DIR: "/work/release/.t3/electron" },
        true,
        () => {
          legacyProbes += 1;
        },
      );

      assert.equal(path, "/Users/alice/Library/Application Support/T3 Code (Alpha)");
      assert.equal(legacyProbes, 1);
    }),
  );
});
