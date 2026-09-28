import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
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
import * as DesktopWindow from "./DesktopWindow.ts";
import * as DesktopWindowSession from "./DesktopWindowSession.ts";
import * as HyprlandPlacement from "./HyprlandPlacement.ts";
import { dispatchedWindowUrlFork } from "./DesktopWindowDispatch.fork.ts";
import { windowIdPreloadArgument } from "./WindowId.fork.ts";
import { windowScopeSeedPreloadArgument } from "./WindowScopeSeed.fork.ts";
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
    close: vi.fn(),
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
  recency: { byRecency: Electron.BrowserWindow[]; revealed: Electron.BrowserWindow[] } = {
    byRecency: [],
    revealed: [],
  },
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
          createNew: (_identity, create) =>
            windowIds.create(create).pipe(Effect.map(windowIds.created)),
          windowIdFor: windowIds.windowIdFor,
          windowsByRecency: Effect.sync(() => recency.byRecency),
          prepareReveal: () => Effect.succeed(false),
          reveal: (revealed) => Effect.sync(() => void recency.revealed.push(revealed)),
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

const projectRef = {
  environmentId: EnvironmentId.make("environment-1"),
  projectId: ProjectId.make("project-1"),
};

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

  it.effect("creates a window per New Window request, at its route and off the saved bounds", () =>
    Effect.gen(function* () {
      const { window, loadURL } = makeWindow();
      const options: Electron.BrowserWindowConstructorOptions[] = [];
      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        const resizeListeners = () =>
          vi.mocked(window.on).mock.calls.filter(([event]) => String(event) === "resize").length;
        assert.equal(resizeListeners(), 1);

        yield* desktopWindow.requestWindow({ kind: "new-window" });
        yield* desktopWindow.requestWindow({ kind: "new-window" });
        yield* desktopWindow.requestWindow({
          kind: "open-in-new-window",
          route: "/project/environment-1/project-1/thread/thread-1",
          seed: { environmentId: projectRef.environmentId, projectId: projectRef.projectId },
        });

        // Each request is a new window, even with one already open.
        assert.equal(options.length, 4);
        assert.deepEqual(loadURL.mock.calls.slice(1), [
          ["t3code-dev://app/"],
          ["t3code-dev://app/"],
          ["t3code-dev://app/#/project/environment-1/project-1/thread/thread-1"],
        ]);
        assert.include(
          options[3]?.webPreferences?.additionalArguments ?? [],
          windowIdPreloadArgument(testWindowId(4)),
        );
        // Only the primary window persists bounds into the one saved slot.
        assert.equal(resizeListeners(), 1);
      }).pipe(Effect.provide(makeLayer(window, options)));
    }),
  );

  it.effect("focuses the most recently focused window on a second launch", () =>
    Effect.gen(function* () {
      const { window } = makeWindow();
      const recent = makeWindow().window;
      const options: Electron.BrowserWindowConstructorOptions[] = [];
      const recency = { byRecency: [recent, window], revealed: [] as Electron.BrowserWindow[] };
      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        recency.revealed.length = 0;

        yield* desktopWindow.requestWindow({ kind: "activate" });

        assert.deepEqual(recency.revealed, [recent]);
        assert.equal(options.length, 1);
      }).pipe(Effect.provide(makeLayer(window, options, recency)));
    }),
  );

  it.effect("seeds New Window with all projects and Open in New Window with its project", () =>
    Effect.gen(function* () {
      const { window } = makeWindow();
      const options: Electron.BrowserWindowConstructorOptions[] = [];
      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* desktopWindow.requestWindow({ kind: "new-window" });
        yield* desktopWindow.requestWindow({
          kind: "open-in-new-window",
          route: "/project/environment-1/project-1",
          seed: projectRef,
        });

        const seedArguments = options.map((created) =>
          (created.webPreferences?.additionalArguments ?? []).filter((argument) =>
            argument.startsWith("--t3code-window-scope-seed="),
          ),
        );
        // The primary window inherits the shared scope, as upstream.
        assert.deepEqual(seedArguments, [
          [],
          [windowScopeSeedPreloadArgument("all-projects")],
          [windowScopeSeedPreloadArgument(projectRef)],
        ]);
      }).pipe(Effect.provide(makeLayer(window, options)));
    }),
  );

  // Work started from a project window opens in it (RSI-Software/t3code-hyprws#1343):
  // its own project routes and the shared pages stay; another project closes it.
  it.effect("keeps a project window on its own issue work", () =>
    Effect.gen(function* () {
      const { window, webContentsListeners } = makeWindow();
      const options: Electron.BrowserWindowConstructorOptions[] = [];
      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* desktopWindow.requestWindow({
          kind: "open-in-new-window",
          route: "/project/environment-1/project-1",
          seed: projectRef,
        });
        assert.equal(options.length, 2);

        // Issues from a shared page, then Work on this issue: its draft.
        const navigate = webContentsListeners.get("did-navigate-in-page");
        navigate?.({}, "t3code-dev://app/#/settings/general");
        navigate?.({}, "t3code-dev://app/#/project/environment-1/project-1/issues?state=open");
        navigate?.({}, "t3code-dev://app/#/project/environment-1/project-1/draft/draft-1");
        yield* Effect.yieldNow;

        assert.equal(options.length, 2);
        assert.equal(vi.mocked(window.close).mock.calls.length, 0);
      }).pipe(Effect.provide(makeLayer(window, options)));
    }),
  );

  it.effect("closes a project window that navigates into another project", () =>
    Effect.gen(function* () {
      const { window, webContentsListeners } = makeWindow();
      const options: Electron.BrowserWindowConstructorOptions[] = [];
      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* desktopWindow.requestWindow({
          kind: "open-in-new-window",
          route: "/project/environment-1/project-1",
          seed: projectRef,
        });

        webContentsListeners.get("did-navigate-in-page")?.(
          {},
          "t3code-dev://app/#/project/environment-2/project-2/thread/thread-9",
        );
        yield* Effect.yieldNow;

        assert.equal(vi.mocked(window.close).mock.calls.length, 1);
      }).pipe(Effect.provide(makeLayer(window, options)));
    }),
  );

  it.effect("skips the close when the window left its project already destroyed", () =>
    Effect.gen(function* () {
      const { window, webContentsListeners } = makeWindow();
      const options: Electron.BrowserWindowConstructorOptions[] = [];
      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* desktopWindow.requestWindow({
          kind: "open-in-new-window",
          route: "/project/environment-1/project-1",
          seed: projectRef,
        });
        Object.assign(window, { isDestroyed: () => true });

        webContentsListeners.get("did-navigate-in-page")?.(
          {},
          "t3code-dev://app/#/project/environment-2/project-2/thread/thread-9",
        );
        yield* Effect.yieldNow;

        assert.equal(vi.mocked(window.close).mock.calls.length, 0);
      }).pipe(Effect.provide(makeLayer(window, options)));
    }),
  );

  it("opens a dispatched window at its route on the identity's origin", () => {
    const projectUrl = "t3code-dev://app/#/project/environment-1/project-1";
    assert.equal(dispatchedWindowUrlFork(projectUrl, undefined), projectUrl);
    assert.equal(
      dispatchedWindowUrlFork("t3code-dev://app/", {
        route: "/project/e/p/thread/t",
        seed: projectRef,
      }),
      "t3code-dev://app/#/project/e/p/thread/t",
    );
    assert.equal(
      dispatchedWindowUrlFork(projectUrl, { route: "/", seed: "all-projects" }),
      "t3code-dev://app/",
    );
  });
});
