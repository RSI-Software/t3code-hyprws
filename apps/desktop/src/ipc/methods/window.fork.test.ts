import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendMode from "../../app/DesktopBackendMode.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { HyprlandPlacement } from "../../window/HyprlandPlacement.ts";
import { getLocalEnvironmentBootstraps } from "./window.ts";
import { publishWindowProjects } from "./window.fork.ts";

const readyConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "node",
  args: ["/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "127.0.0.1",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const readyInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("local:default"),
  label: Effect.succeed("Local"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.some(readyConfig)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

describe("getLocalEnvironmentBootstraps in client-only mode", () => {
  // A client-only launch spawned nothing, so a ready pool entry describes a backend this app does
  // not own. Publishing it would hand the renderer a bootstrap token for someone else's server.
  it.effect("publishes no local bootstrap even while the pool reports a ready instance", () =>
    Effect.gen(function* () {
      const mode = yield* DesktopBackendMode.DesktopBackendMode;
      yield* mode.latch("client-only");
      assert.deepEqual(yield* getLocalEnvironmentBootstraps.handler(), []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          DesktopBackendPool.layerTest([readyInstance]),
          DesktopBackendMode.layerTest(),
        ),
      ),
    ),
  );
});

describe("publishWindowProjects", () => {
  const windowId = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const scope = { kind: "all" } as const;
  const window = { webContents: { id: 7 } } as unknown as Electron.BrowserWindow;

  // Runs one report with the given sender, and returns what reached placement.
  const report = (payload: unknown, sender: { readonly id: number } | undefined) => {
    const published: Array<{ readonly windowId: string; readonly scope: unknown }> = [];
    return publishWindowProjects.handler(payload, sender && { sender }).pipe(
      Effect.as(published),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ElectronWindow.ElectronWindow)({
            getById: (id) => Effect.succeed(id === windowId ? Option.some(window) : Option.none()),
          }),
          Layer.mock(HyprlandPlacement)({
            isAvailable: true,
            publishScope: (id, reported) =>
              Effect.sync(() => void published.push({ windowId: id, scope: reported })),
          }),
        ),
      ),
    );
  };

  it.effect("records the scope a window reports for itself", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* report({ windowId, scope }, { id: 7 }), [{ windowId, scope }]);
    }),
  );

  it.effect("ignores a report from another window's sender, or none", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* report({ windowId, scope }, { id: 8 }), []);
      assert.deepEqual(yield* report({ windowId, scope }, undefined), []);
    }),
  );

  it.effect("ignores a report for an unknown or malformed window id", () =>
    Effect.gen(function* () {
      const unknown = "1f8fad5b-d9cb-469f-a165-70867728950e";
      assert.deepEqual(yield* report({ windowId: unknown, scope }, { id: 7 }), []);
      assert.deepEqual(yield* report({ windowId: "hub", scope }, { id: 7 }), []);
    }),
  );
});
