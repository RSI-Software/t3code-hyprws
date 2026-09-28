import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  screen: {
    getAllDisplays: vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]),
  },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as DesktopWindowSession from "./DesktopWindowSession.ts";
import * as HyprlandPlacement from "./HyprlandPlacement.ts";
import { windowIdPreloadArgument } from "./WindowId.fork.ts";
import { makeTestWindowIds, testWindowId } from "./testWindowIds.fork.ts";

type Listener = (...args: readonly unknown[]) => void;

function makeWindow() {
  const webContentsListeners = new Map<string, Listener>();
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "t3code-dev://app/",
    getZoomLevel: () => 0,
    getZoomFactor: () => 1,
    setZoomLevel: vi.fn(),
    isLoadingMainFrame: () => false,
    on: (event: string, listener: Listener) => void webContentsListeners.set(event, listener),
    once: vi.fn(),
    openDevTools: vi.fn(),
    send: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const bounds = () => ({ x: 0, y: 0, width: 1100, height: 780 });
  const loadURL = vi.fn(() => Promise.resolve());
  const window = {
    getBounds: bounds,
    getNormalBounds: bounds,
    getTitle: () => "T3 Code",
    isDestroyed: () => false,
    isFocused: () => true,
    isFullScreen: () => false,
    isMaximized: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    loadURL,
    on: vi.fn(),
    once: vi.fn(),
    setAutoHideCursor: vi.fn(),
    setBackgroundColor: vi.fn(),
    setTitle: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    webContents,
  } as unknown as Electron.BrowserWindow;
  return { window, loadURL, webContentsListeners };
}

function makeLayer(
  window: Electron.BrowserWindow,
  options: Electron.BrowserWindowConstructorOptions[],
) {
  const windowIds = makeTestWindowIds();
  const mainWindow = Ref.makeUnsafe(Option.none<Electron.BrowserWindow>());
  const settings = DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS;
  return DesktopWindow.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/dist-electron",
          homeDirectory: "/home/alice",
          platform: "linux",
          processArch: "x64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: false,
          resourcesPath: "/repo/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              DesktopConfig.layerTest({
                T3CODE_PORT: "3773",
                VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
                T3CODE_DESKTOP_DEVTOOLS: "0",
              }),
            ),
          ),
        ),
        DesktopState.layer,
        Layer.mock(DesktopAssets.DesktopAssets)({
          iconPaths: Effect.succeed({
            ico: Option.none(),
            icns: Option.none(),
            png: Option.none(),
          }),
          resolveResourcePath: () => Effect.succeedNone,
        }),
        Layer.mock(DesktopAppSettings.DesktopAppSettings)({
          get: Effect.succeed(settings),
          load: Effect.succeed(settings),
          setMainWindowBounds: () => Effect.succeed({ settings, changed: false }),
        }),
        Layer.mock(DesktopClientSettings.DesktopClientSettings)({ get: Effect.succeedNone }),
        Layer.mock(DesktopRendererHistory.DesktopRendererHistory)({
          register: () => Effect.void,
          shutdown: Effect.void,
        }),
        Layer.mock(DesktopServerExposure.DesktopServerExposure)({}),
        Layer.mock(HyprlandPlacement.HyprlandPlacement)({
          isAvailable: false,
          claim: () => Effect.void,
          forget: () => Effect.void,
        }),
        Layer.mock(DesktopWindowSession.DesktopWindowSession)({ consume: Effect.succeed([]) }),
        Layer.mock(ElectronApp.ElectronApp)({ quit: Effect.void }),
        Layer.mock(ElectronMenu.ElectronMenu)({ setApplicationMenu: () => Effect.void }),
        Layer.mock(ElectronShell.ElectronShell)({}),
        Layer.mock(ElectronTheme.ElectronTheme)({
          shouldUseDarkColors: Effect.succeed(false),
          onUpdated: () => Effect.void,
        }),
        Layer.mock(ElectronWindow.ElectronWindow)({
          create: (created) =>
            Effect.sync(() => void options.push(created)).pipe(Effect.as(window)),
          main: Ref.get(mainWindow),
          get: () => Ref.get(mainWindow),
          currentMainOrFirst: Ref.get(mainWindow),
          focusedMainOrFirst: Ref.get(mainWindow),
          getOrCreate: (_identity, create, requestedId) =>
            windowIds.create(create, requestedId).pipe(
              Effect.tap((created) => Ref.set(mainWindow, Option.some(created))),
              Effect.map(windowIds.created),
            ),
          windowIdFor: windowIds.windowIdFor,
          prepareReveal: () => Effect.succeed(false),
          reveal: () => Effect.void,
          sendAll: () => Effect.void,
        }),
        Layer.mock(PreviewManager.PreviewManager)({
          setWindow: () => Effect.void,
          getBrowserSession: () => Effect.succeed({} as Electron.Session),
          isBrowserPartition: () => false,
          getBrowserPartition: () => Effect.succeed("persist:t3code-preview-test"),
        }),
      ),
    ),
  );
}

describe("DesktopWindow (fork)", () => {
  it.effect("keeps a window's WindowId across render-process-gone recovery", () =>
    Effect.gen(function* () {
      const { window, loadURL, webContentsListeners } = makeWindow();
      const options: Electron.BrowserWindowConstructorOptions[] = [];
      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const electronWindow = yield* ElectronWindow.ElectronWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        assert.deepEqual(yield* electronWindow.windowIdFor(window), Option.some(testWindowId(1)));

        webContentsListeners.get("render-process-gone")?.({}, { reason: "crashed", exitCode: 1 });
        yield* TestClock.adjust("500 millis");

        // Recovery reloads the same BrowserWindow: nothing is recreated, so the
        // preload arguments Electron replays to the new renderer still carry the id.
        assert.equal(loadURL.mock.calls.length, 2);
        assert.equal(options.length, 1);
        assert.include(
          options[0]?.webPreferences?.additionalArguments ?? [],
          windowIdPreloadArgument(testWindowId(1)),
        );
        assert.deepEqual(yield* electronWindow.windowIdFor(window), Option.some(testWindowId(1)));
      }).pipe(Effect.provide(makeLayer(window, options)));
    }),
  );
});
