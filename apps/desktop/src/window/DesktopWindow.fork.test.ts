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
import { WINDOW_ID_PRELOAD_ARGUMENT, windowIdPreloadArgument } from "./WindowId.fork.ts";
import { windowClaimTitle } from "./WindowPlacement.fork.ts";
import { windowScopeSeedPreloadArgument } from "./WindowScopeSeed.fork.ts";
import { makeTestWindowIds, testWindowId } from "./testWindowIds.fork.ts";

type Listener = (...args: readonly unknown[]) => void;

function makeWindow(
  bounds: () => Electron.Rectangle = () => ({ x: 0, y: 0, width: 1100, height: 780 }),
  title: () => string = () => "T3 Code",
) {
  const webContentsListeners = new Map<string, Listener>();
  const windowListeners = new Map<string, Listener>();
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
  const loadURL = vi.fn(() => Promise.resolve());
  const setTitle = vi.fn();
  const window = {
    getBounds: bounds,
    getNormalBounds: bounds,
    getTitle: title,
    isDestroyed: () => false,
    isFocused: () => true,
    isFullScreen: () => false,
    isMaximized: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    close: vi.fn(),
    loadURL,
    on: vi.fn((event: string, listener: Listener) => void windowListeners.set(event, listener)),
    once: vi.fn((event: string, listener: Listener) => void windowListeners.set(event, listener)),
    showInactive: vi.fn(),
    setAutoHideCursor: vi.fn(),
    setBackgroundColor: vi.fn(),
    setTitle,
    setTitleBarOverlay: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    webContents,
  } as unknown as Electron.BrowserWindow;
  return { window, loadURL, setTitle, webContentsListeners, windowListeners };
}

function makeLayer(
  window: Electron.BrowserWindow,
  options: Electron.BrowserWindowConstructorOptions[],
  recency: { byRecency: Electron.BrowserWindow[]; revealed: Electron.BrowserWindow[] } = {
    byRecency: [],
    revealed: [],
  },
  extra: {
    /** Later windows, in creation order; `window` is always the first. */
    readonly nextWindows?: Electron.BrowserWindow[];
    readonly mainWindow?: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
    readonly savedBounds?: DesktopAppSettings.DesktopWindowBounds[];
    readonly restoreEntries?: readonly DesktopWindowSession.WindowRestoreEntry[];
    readonly claims?: { key: string; title: string }[];
  } = {},
) {
  const windowIds = makeTestWindowIds();
  const mainWindow = extra.mainWindow ?? Ref.makeUnsafe(Option.none<Electron.BrowserWindow>());
  let created = 0;
  const nextWindow = () => (created++ === 0 ? window : (extra.nextWindows?.shift() ?? window));
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
          setMainWindowBounds: (bounds) =>
            Effect.sync(() => void extra.savedBounds?.push(bounds)).pipe(
              Effect.as({ settings, changed: false }),
            ),
        }),
        Layer.mock(DesktopClientSettings.DesktopClientSettings)({ get: Effect.succeedNone }),
        Layer.mock(DesktopServerExposure.DesktopServerExposure)({}),
        Layer.mock(HyprlandPlacement.HyprlandPlacement)({
          isAvailable: extra.claims !== undefined,
          claim: (key, title) => Effect.sync(() => void extra.claims?.push({ key, title })),
          forget: () => Effect.void,
          snapshotAddresses: Effect.succeed(new Set<string>()),
          stageWorkspaceRule: () => Effect.succeed(true),
          clearWorkspaceRule: () => Effect.void,
          moveToWorkspace: () => Effect.void,
        }),
        Layer.mock(DesktopWindowSession.DesktopWindowSession)({
          consume: Effect.succeed(extra.restoreEntries ?? []),
        }),
        Layer.mock(ElectronApp.ElectronApp)({ quit: Effect.void }),
        Layer.mock(ElectronMenu.ElectronMenu)({ setApplicationMenu: () => Effect.void }),
        Layer.mock(ElectronShell.ElectronShell)({}),
        Layer.mock(ElectronTheme.ElectronTheme)({
          shouldUseDarkColors: Effect.succeed(false),
          onUpdated: () => Effect.void,
        }),
        Layer.mock(ElectronWindow.ElectronWindow)({
          create: (created) =>
            Effect.sync(() => void options.push(created)).pipe(Effect.map(nextWindow)),
          main: Ref.get(mainWindow),
          get: () => Ref.get(mainWindow),
          currentMainOrFirst: Ref.get(mainWindow),
          focusedMainOrFirst: Ref.get(mainWindow),
          getOrCreate: (_identity, create, requestedId) =>
            windowIds.create(create, requestedId).pipe(
              Effect.tap((created) => Ref.set(mainWindow, Option.some(created))),
              Effect.map(windowIds.created),
            ),
          createNew: (_identity, create, requestedId) =>
            windowIds.create(create, requestedId).pipe(Effect.map(windowIds.created)),
          clearMain: () => Effect.void,
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
        // Every all-projects window tracks its bounds (see the current-main test).
        assert.equal(resizeListeners(), 3);
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
          route: "/environment-1/thread-1",
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

  // A seeded window is a filter, not a route scope (RSI-Software/t3code-hyprws#1347):
  // navigating to another project's work keeps the window open.
  it.effect("keeps a seeded window open when it navigates into another project", () =>
    Effect.gen(function* () {
      const { window, webContentsListeners } = makeWindow();
      const options: Electron.BrowserWindowConstructorOptions[] = [];
      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* desktopWindow.requestWindow({
          kind: "open-in-new-window",
          route: "/",
          seed: projectRef,
        });

        const navigate = webContentsListeners.get("did-navigate-in-page");
        navigate?.({}, "t3code-dev://app/#/environment-2/thread-9");
        navigate?.({}, "t3code-dev://app/#/project/environment-2/project-2/thread/thread-9");
        yield* Effect.yieldNow;

        assert.equal(options.length, 2);
        assert.equal(vi.mocked(window.close).mock.calls.length, 0);
      }).pipe(Effect.provide(makeLayer(window, options)));
    }),
  );

  it("opens a dispatched window at its route on the app origin", () => {
    const rootUrl = "t3code-dev://app/";
    assert.equal(dispatchedWindowUrlFork(rootUrl, undefined), rootUrl);
    assert.equal(
      dispatchedWindowUrlFork(rootUrl, { route: "/environment-1/thread-1", seed: projectRef }),
      "t3code-dev://app/#/environment-1/thread-1",
    );
    // A project seed no longer picks the URL: a restored window at `/` opens at the root.
    assert.equal(dispatchedWindowUrlFork(rootUrl, { route: "/", seed: projectRef }), rootUrl);
  });

  it.effect(
    "persists bounds from the current main window only, and hands over when it closes",
    () =>
      Effect.gen(function* () {
        const main = makeWindow(() => ({ x: 0, y: 0, width: 1100, height: 780 }));
        const extraWindow = makeWindow(() => ({ x: 40, y: 50, width: 1000, height: 700 }));
        const mainWindow = Ref.makeUnsafe(Option.none<Electron.BrowserWindow>());
        const savedBounds: DesktopAppSettings.DesktopWindowBounds[] = [];
        const options: Electron.BrowserWindowConstructorOptions[] = [];
        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
          yield* desktopWindow.requestWindow({ kind: "new-window" });

          extraWindow.windowListeners.get("resize")?.();
          yield* TestClock.adjust("1 second");
          assert.deepEqual(savedBounds, []);

          // Main closes; the registry now answers the New Window as main.
          yield* Ref.set(mainWindow, Option.some(extraWindow.window));
          main.windowListeners.get("closed")?.();
          extraWindow.windowListeners.get("resize")?.();
          yield* TestClock.adjust("1 second");
          assert.deepEqual(savedBounds, [{ x: 40, y: 50, width: 1000, height: 700 }]);

          yield* desktopWindow.flushMainWindowBounds;
          assert.deepEqual(savedBounds.at(-1), { x: 40, y: 50, width: 1000, height: 700 });
          assert.lengthOf(savedBounds, 2);
        }).pipe(
          Effect.provide(
            makeLayer(main.window, options, undefined, {
              nextWindows: [extraWindow.window],
              mainWindow,
              savedBounds,
            }),
          ),
        );
      }),
  );

  it.effect(
    "restores each window under its id, at its route, on bounds a display still shows",
    () =>
      Effect.gen(function* () {
        const { window, loadURL } = makeWindow();
        const options: Electron.BrowserWindowConstructorOptions[] = [];
        const onDisplay = { x: 10, y: 20, width: 1000, height: 700 };
        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          const electronWindow = yield* ElectronWindow.ElectronWindow;
          yield* desktopWindow.restoreWindowSession;
          yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

          // Two all-projects windows and a project window, each its own window.
          assert.lengthOf(options, 3);
          assert.deepEqual(
            options.map((created) =>
              created.webPreferences?.additionalArguments?.find((argument) =>
                argument.startsWith(WINDOW_ID_PRELOAD_ARGUMENT),
              ),
            ),
            [testWindowId(11), testWindowId(12), testWindowId(13)].map(windowIdPreloadArgument),
          );
          assert.deepEqual(loadURL.mock.calls, [
            ["t3code-dev://app/#/settings/general"],
            ["t3code-dev://app/"],
            ["t3code-dev://app/#/project/environment-1/project-1/thread/thread-1"],
          ]);
          assert.deepInclude(options[0], onDisplay);
          // Off every display: the window opens at the default size instead.
          assert.equal(options[1]?.x, undefined);
          assert.equal(options[1]?.width, DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE.width);
          assert.deepEqual(
            yield* electronWindow.windowIdFor(window),
            Option.some(testWindowId(13)),
          );
        }).pipe(
          Effect.provide(
            makeLayer(window, options, undefined, {
              restoreEntries: [
                {
                  windowId: testWindowId(11),
                  route: "/settings/general",
                  seed: "all-projects",
                  bounds: onDisplay,
                  workspace: null,
                },
                {
                  windowId: testWindowId(12),
                  route: "/",
                  seed: "all-projects",
                  bounds: { x: 5000, y: 5000, width: 1000, height: 700 },
                  workspace: null,
                },
                {
                  windowId: testWindowId(13),
                  route: "/project/environment-1/project-1/thread/thread-1",
                  seed: projectRef,
                  bounds: null,
                  workspace: null,
                },
              ],
            }),
          ),
        );
      }),
  );

  it.effect(
    "maps only a window restored onto a workspace under its WindowId, held until claimed",
    () =>
      Effect.gen(function* () {
        const restored = makeWindow();
        const created = makeWindow();
        const options: Electron.BrowserWindowConstructorOptions[] = [];
        const claims: { key: string; title: string }[] = [];
        const token = windowClaimTitle(testWindowId(21));
        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.restoreWindowSession;
          yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
          yield* desktopWindow.requestWindow({ kind: "new-window" });

          // Both are all-projects windows; only the restored one maps as a token.
          assert.lengthOf(options, 2);
          assert.equal(options[0]?.title, token);
          assert.notEqual(options[1]?.title, token);
          assert.isFalse(options[1]?.title?.startsWith("t3code-window-"));

          // A document title arriving before the claim does not reach the compositor.
          restored.window.setTitle("Renderer title");
          assert.deepEqual(restored.setTitle.mock.calls, []);
          // A normally created window's titles pass straight through.
          created.window.setTitle("Renderer title");
          assert.deepEqual(created.setTitle.mock.calls, [["Renderer title"]]);

          restored.windowListeners.get("ready-to-show")?.();
          yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
          assert.deepEqual(claims, [{ key: testWindowId(21), title: token }]);
          assert.deepEqual(restored.setTitle.mock.calls, [[token], ["Renderer title"]]);
        }).pipe(
          Effect.provide(
            makeLayer(restored.window, options, undefined, {
              nextWindows: [created.window],
              claims,
              restoreEntries: [
                {
                  windowId: testWindowId(21),
                  route: "/",
                  seed: "all-projects",
                  bounds: null,
                  workspace: { id: 4, name: "4" },
                },
              ],
            }),
          ),
        );
      }),
  );

  it.effect("maps windows opened together under their own claim titles until each is claimed", () =>
    Effect.gen(function* () {
      const options: Electron.BrowserWindowConstructorOptions[] = [];
      // Each fake window reports the title it was built with, as Electron does.
      const at = (index: number) => makeWindow(undefined, () => options[index]?.title ?? "");
      const [hub, first, second, third, later] = [at(0), at(1), at(2), at(3), at(4)];
      const claims: { key: string; title: string }[] = [];
      const flush = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        hub.windowListeners.get("ready-to-show")?.();
        yield* flush;
        const normalTitle = options[0]?.title ?? "";
        assert.isNotEmpty(normalTitle);

        yield* Effect.all(
          [
            desktopWindow.requestWindow({ kind: "new-window" }),
            desktopWindow.requestWindow({ kind: "new-window" }),
            desktopWindow.requestWindow({ kind: "new-window" }),
          ],
          { concurrency: "unbounded" },
        );
        // The first keeps the normal title; the rest could not be told from it.
        assert.deepEqual(
          options.slice(1).map((created) => created.title),
          [normalTitle, windowClaimTitle(testWindowId(3)), windowClaimTitle(testWindowId(4))],
        );

        // A document title arriving before the claim does not reach the compositor.
        second.window.setTitle("Renderer title");
        assert.deepEqual(second.setTitle.mock.calls, []);

        for (const opened of [first, second, third])
          opened.windowListeners.get("ready-to-show")?.();
        yield* flush;
        assert.deepEqual(claims.slice(1), [
          { key: testWindowId(2), title: normalTitle },
          { key: testWindowId(3), title: windowClaimTitle(testWindowId(3)) },
          { key: testWindowId(4), title: windowClaimTitle(testWindowId(4)) },
        ]);
        // Claimed, each takes its normal title or the last one asked for.
        assert.deepEqual(second.setTitle.mock.calls, [["Renderer title"]]);
        assert.deepEqual(third.setTitle.mock.calls, [[normalTitle]]);

        // With every claim done, the next window maps under its normal title again.
        yield* desktopWindow.requestWindow({ kind: "new-window" });
        assert.equal(options[4]?.title, normalTitle);
      }).pipe(
        Effect.provide(
          makeLayer(hub.window, options, undefined, {
            nextWindows: [first.window, second.window, third.window, later.window],
            claims,
          }),
        ),
      );
    }),
  );
});
