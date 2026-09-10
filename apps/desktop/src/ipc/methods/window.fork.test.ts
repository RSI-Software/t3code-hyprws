import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendMode from "../../app/DesktopBackendMode.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import { getLocalEnvironmentBootstraps } from "./window.ts";

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
