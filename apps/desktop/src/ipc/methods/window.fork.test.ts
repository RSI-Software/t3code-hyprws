import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";
import type * as Electron from "electron";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import {
  getLocalEnvironmentBootstraps,
  getWindowFullscreenState,
  openProjectWindow,
  pickProjectFavicon,
} from "./window.ts";
const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
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
const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.some(readyWslConfig)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};
describe("openProjectWindow", () => {
  it.effect("validates scoped refs and delegates repeated opens to the window registry", () => {
    const openedIdentities: Parameters<
      DesktopWindow.DesktopWindow["Service"]["openIdentity"]
    >[0][] = [];
    const window = {} as Electron.BrowserWindow;
    const layer = Layer.mock(DesktopWindow.DesktopWindow)({
      openIdentity: (identity) =>
        Effect.sync(() => {
          openedIdentities.push(identity);
          return window;
        }),
    });
    const projectRef = {
      environmentId: EnvironmentId.make("environment-1"),
      projectId: ProjectId.make("project-1"),
    };
    return Effect.gen(function* () {
      yield* openProjectWindow.handler(projectRef);
      yield* openProjectWindow.handler(projectRef);
      assert.deepEqual(openedIdentities, [
        { kind: "project", ref: projectRef },
        { kind: "project", ref: projectRef },
      ]);
      const malformed = yield* Effect.result(
        openProjectWindow.handler({ environmentId: " ", projectId: "project-1" }),
      );
      assert.isTrue(malformed._tag === "Failure");
      assert.lengthOf(openedIdentities, 2);
    }).pipe(Effect.provide(layer));
  });
});
