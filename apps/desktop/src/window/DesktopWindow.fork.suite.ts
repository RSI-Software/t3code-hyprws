// Fork-owned harness pieces and cases for `DesktopWindow.test.ts`. The upstream
// file reaches them through `fork-hook` lines, so it keeps only upstream cases
// and its harness stays upstream's text (RSI-Software/t3code-hyprws#1493).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";
import { vi, type Mock } from "vite-plus/test";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { WINDOW_DEMAND_STATE_CHANNEL } from "../ipc/channels.ts";
import type * as PreviewManager from "../preview/Manager.ts";
import type { DesktopWindowLayerTestFork } from "./DesktopWindow.test.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import { testRestoreEntry, testWindowId } from "./testWindowIds.fork.ts";
import { WINDOW_ID_PRELOAD_ARGUMENT, windowIdPreloadArgument } from "./WindowId.fork.ts";

/**
 * Upstream's test environment plus the variables a fork case opts into. The
 * harness merges it after upstream's environment layer, so it wins when set.
 */
export const desktopEnvironmentLayerFork = (
  input: Parameters<typeof DesktopEnvironment.layer>[0],
  env: Record<string, string | undefined> | undefined,
) =>
  env === undefined
    ? Layer.empty
    : DesktopEnvironment.layer(input).pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            DesktopConfig.layerTest({
              T3CODE_PORT: "3773",
              VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
              ...env,
            }),
          ),
        ),
      );

/** The per-window preview event forwarding startup installs. */
export const previewOwnedForwardingFork = {
  subscribeOwnedStateChanges: () => Effect.void,
  subscribeOwnedRecordingInputs: () => Effect.void,
  subscribeOwnedPointerEvents: () => Effect.void,
  subscribeOwnedOpenLinks: () => Effect.void,
} satisfies Partial<PreviewManager.PreviewManager["Service"]>;

/** Records shared-session requests when a fork case passes a recorder; else upstream's mock stands. */
export const previewSessionCountersFork = (input: {
  readonly previewBrowserSessionRequests?: number[];
}): Partial<PreviewManager.PreviewManager["Service"]> => {
  const requests = input.previewBrowserSessionRequests;
  return requests
    ? {
        getBrowserSession: () =>
          Effect.sync(() => {
            requests.push(1);
            return {} as Electron.Session;
          }),
      }
    : {};
};

type WindowListenerFork = (...args: readonly unknown[]) => void;

// The fork cases' view of upstream's `makeFakeBrowserWindow`. Its inferred
// vitest mock types cannot be named in an exported declaration.
type FakeBrowserWindowFork = {
  readonly window: Electron.BrowserWindow;
  readonly isFocused: Mock<() => boolean>;
  readonly isMinimized: Mock<() => boolean>;
  readonly isVisible: Mock<() => boolean>;
  readonly loadURL: Mock<() => Promise<void>>;
  readonly openDevTools: Mock;
  readonly send: Mock;
  readonly setTitle: Mock;
  readonly webContentsListeners: Map<string, WindowListenerFork>;
  readonly windowListeners: Map<string, WindowListenerFork>;
};

type DesktopWindowHarnessFork = {
  readonly makeFakeBrowserWindow: () => FakeBrowserWindowFork;
  readonly layerTest: DesktopWindowLayerTestFork;
};

/**
 * Registers the fork's cases inside upstream's `DesktopWindow` suite, so they
 * share its harness. Each fork domain adds its cases here.
 */
export const registerDesktopWindowForkTests = (harness: DesktopWindowHarnessFork) => {
  const { makeFakeBrowserWindow, layerTest } = harness;

  it.effect("leaves app context menus to the renderer while preserving native text actions", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const popupTemplates: Electron.MenuItemConstructorOptions[][] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        onPopupTemplate: ({ template }) =>
          Effect.sync(() => {
            popupTemplates.push([...template]);
          }),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        const contextMenu = fakeWindow.webContentsListeners.get("context-menu");
        if (!contextMenu) {
          return yield* Effect.die("context-menu listener was not registered");
        }

        const appMenuEvent = { preventDefault: vi.fn() };
        contextMenu(appMenuEvent, {
          isEditable: false,
          selectionText: "",
          editFlags: {},
          dictionarySuggestions: [],
          linkURL: "",
          mediaType: "none",
          misspelledWord: "",
        } as unknown as Electron.ContextMenuParams);
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(popupTemplates, []);
        assert.equal(appMenuEvent.preventDefault.mock.calls.length, 1);

        const editableEvent = { preventDefault: vi.fn() };
        contextMenu(editableEvent, {
          isEditable: true,
          selectionText: "selected text",
          editFlags: {
            canCut: true,
            canCopy: true,
            canPaste: true,
            canSelectAll: true,
          },
          dictionarySuggestions: [],
          linkURL: "",
          mediaType: "none",
          misspelledWord: "",
        } as unknown as Electron.ContextMenuParams);
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(
          popupTemplates[0]?.map((item) => item.role),
          ["cut", "copy", "paste", "selectAll"],
        );
        assert.equal(editableEvent.preventDefault.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("skips devtools when the development run opts out", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        environmentEnv: { T3CODE_DESKTOP_DEVTOOLS: "0" },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(fakeWindow.openDevTools.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("publishes demand from visibility without treating focus as visibility", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const show = fakeWindow.windowListeners.get("show");
        const hide = fakeWindow.windowListeners.get("hide");
        const minimize = fakeWindow.windowListeners.get("minimize");
        const restore = fakeWindow.windowListeners.get("restore");
        if (!show || !hide || !minimize || !restore) {
          return yield* Effect.die("window demand listeners were not registered");
        }
        assert.equal(fakeWindow.windowListeners.has("focus"), false);
        assert.equal(fakeWindow.windowListeners.has("blur"), false);

        fakeWindow.isFocused.mockReturnValue(false);
        show();
        fakeWindow.isVisible.mockReturnValue(false);
        hide();
        fakeWindow.isVisible.mockReturnValue(true);
        fakeWindow.isMinimized.mockReturnValue(true);
        minimize();
        fakeWindow.isMinimized.mockReturnValue(false);
        restore();

        assert.deepEqual(fakeWindow.send.mock.calls, [
          [WINDOW_DEMAND_STATE_CHANNEL, true],
          [WINDOW_DEMAND_STATE_CHANNEL, false],
          [WINDOW_DEMAND_STATE_CHANNEL, false],
          [WINDOW_DEMAND_STATE_CHANNEL, true],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("leaves an unplaced restored window wherever Hyprland puts it", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const workspaceMoves: { key: string; workspace: string }[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        workspaceMoves,
        restoreEntries: [testRestoreEntry("all-projects", null)],
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.restoreWindowSession;
        yield* desktopWindow.openArguments(["t3code"]);
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(yield* Ref.get(createCount), 1);
        yield* Effect.yieldNow;
        assert.deepEqual(workspaceMoves, []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("opens a pending project intent once and uses its renderer title", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const previewMainWindowSets: Electron.BrowserWindow[] = [];
      const previewOwners: string[] = [];
      const placementClaims: { key: string; title: string }[] = [];
      const previewBrowserSessionRequests: number[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        previewMainWindowSets,
        previewOwners,
        placementClaims,
        workspaceMoves: [],
        previewBrowserSessionRequests,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.openArguments(["t3code", "--project", "environment-1", "project-1"]);
        assert.equal(yield* Ref.get(createCount), 0);

        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(createdWindowOptions[0]?.title, "project-1");
        assert.deepEqual(createdWindowOptions[0]?.webPreferences?.additionalArguments, [
          windowIdPreloadArgument(testWindowId(1)),
          "--t3code-window-scope-seed=environment-1/project-1",
        ]);
        assert.deepEqual(previewMainWindowSets, [fakeWindow.window]);
        assert.deepEqual(previewOwners, [testWindowId(1)]);
        assert.deepEqual(previewBrowserSessionRequests, []);
        assert.deepEqual(fakeWindow.loadURL.mock.calls[0], ["t3code-dev://app/"]);

        fakeWindow.windowListeners.get("ready-to-show")?.();
        yield* Effect.yieldNow;
        assert.deepEqual(
          placementClaims.map((claim) => claim.key),
          [testWindowId(1)],
        );
        const preventDefault = vi.fn();
        // The fake keeps one listener per event; the project title needs every one.
        const listeners = vi.mocked(fakeWindow.window.on).mock.calls as unknown as [
          string,
          (...args: readonly unknown[]) => void,
        ][];
        for (const [event, listener] of listeners) {
          if (event === "page-title-updated") listener({ preventDefault }, "Project One");
        }
        assert.equal(preventDefault.mock.calls.length, 1);
        assert.deepEqual(fakeWindow.setTitle.mock.calls, [["Project One"]]);

        yield* desktopWindow.openArguments(["t3code-dev://app/project/environment-1/project-1"]);
        assert.equal(yield* Ref.get(createCount), 1);

        fakeWindow.webContentsListeners.get("did-navigate-in-page")?.({}, "t3code-dev://app/");
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(vi.mocked(fakeWindow.window.close).mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reopens the windows an update relaunch recorded, on their old workspaces", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const workspaceMoves: { key: string; workspace: string }[] = [];
      const placementClaims: { key: string; title: string }[] = [];
      const readyToShowFork: ((...args: readonly unknown[]) => void)[] = [];
      fakeWindow.window.once = ((
        eventName: string,
        listener: (...args: readonly unknown[]) => void,
      ) => {
        if (eventName === "ready-to-show") readyToShowFork.push(listener);
        fakeWindow.windowListeners.set(eventName, listener);
        return fakeWindow.window;
      }) as Electron.BrowserWindow["once"];
      const hubId = testWindowId(101);
      const projectWindowId = testWindowId(102);
      const projectSeedFork = {
        environmentId: EnvironmentId.make("environment-1"),
        projectId: ProjectId.make("project-1"),
      };
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        workspaceMoves,
        placementClaims,
        restoreEntries: [
          testRestoreEntry("all-projects", { id: 1, name: "1" }, hubId),
          testRestoreEntry(projectSeedFork, { id: 4, name: "code" }, projectWindowId),
        ],
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.restoreWindowSession;
        // A relaunch after an update carries no arguments, so the hub default
        // must not win over the recorded windows.
        yield* desktopWindow.openArguments(["t3code"]);
        assert.equal(yield* Ref.get(createCount), 0);

        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        assert.equal(yield* Ref.get(createCount), 2);
        const hubArguments = createdWindowOptions[0]?.webPreferences?.additionalArguments;
        assert.deepEqual(hubArguments, [
          windowIdPreloadArgument(hubId),
          "--t3code-window-scope-seed=all-projects",
        ]);
        assert.deepEqual(createdWindowOptions[1]?.webPreferences?.additionalArguments, [
          windowIdPreloadArgument(projectWindowId),
          "--t3code-window-scope-seed=environment-1/project-1",
        ]);

        for (const fire of readyToShowFork) fire();
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
        assert.deepEqual(
          placementClaims.map((claim) => claim.key),
          [hubId, projectWindowId],
        );
        assert.deepEqual(
          createdWindowOptions.map((options) =>
            options.webPreferences?.additionalArguments?.find((argument) =>
              argument.startsWith(WINDOW_ID_PRELOAD_ARGUMENT),
            ),
          ),
          [windowIdPreloadArgument(hubId), windowIdPreloadArgument(projectWindowId)],
        );
        assert.deepEqual(workspaceMoves, [
          { key: hubId, workspace: "1" },
          { key: projectWindowId, workspace: "code" },
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  // With Local environment off no backend signals ready, so the bootstrap's open call drains.
  const readySignals = [
    [
      "backend ready",
      true,
      (w: DesktopWindow.DesktopWindow["Service"]) =>
        w.handleBackendReady(new URL("http://127.0.0.1:3773")),
    ],
    ["Local off", false, (w: DesktopWindow.DesktopWindow["Service"]) => w.createMainIfBackendReady],
  ] as const;
  for (const [signal, localEnvironmentEnabled, ready] of readySignals) {
    it.effect(`still honours an explicit launch intent alongside a restore (${signal})`, () =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
        const layer = layerTest({
          window: fakeWindow.window,
          createCount,
          mainWindow,
          createdWindowOptions,
          workspaceMoves: [],
          restoreEntries: [testRestoreEntry("all-projects", { id: 1, name: "1" })],
          desktopSettings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled,
          },
        });

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.restoreWindowSession;
          yield* desktopWindow.openArguments(["t3code", "--project", "environment-2", "project-2"]);
          yield* ready(desktopWindow);

          assert.equal(yield* Ref.get(createCount), 2);
          assert.deepEqual(createdWindowOptions[1]?.webPreferences?.additionalArguments, [
            windowIdPreloadArgument(testWindowId(2)),
            "--t3code-window-scope-seed=environment-2/project-2",
          ]);
          assert.deepEqual(
            createdWindowOptions.map((options) =>
              options.webPreferences?.additionalArguments?.find((argument) =>
                argument.startsWith(WINDOW_ID_PRELOAD_ARGUMENT),
              ),
            ),
            [windowIdPreloadArgument(testWindowId(1)), windowIdPreloadArgument(testWindowId(2))],
          );
        }).pipe(Effect.provide(layer));
      }),
    );
  }
};
