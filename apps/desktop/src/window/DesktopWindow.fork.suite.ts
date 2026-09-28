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
import { vi } from "vite-plus/test";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { WINDOW_DEMAND_STATE_CHANNEL } from "../ipc/channels.ts";
import type * as PreviewManager from "../preview/Manager.ts";
import type { DesktopWindowHarnessFork } from "./DesktopWindow.test.ts";
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

/**
 * Preview session overrides that record calls when a fork case passes the
 * matching recorder; without one, upstream's mock stands.
 */
export const previewSessionCountersFork = (input: {
  readonly previewBrowserSessionRequests?: number[];
  readonly previewMainWindowSets?: Electron.BrowserWindow[];
}): Partial<PreviewManager.PreviewManager["Service"]> => {
  const { previewBrowserSessionRequests: sessionRequests, previewMainWindowSets: mainWindowSets } =
    input;
  return {
    ...(sessionRequests && {
      getBrowserSession: () =>
        Effect.sync(() => {
          sessionRequests.push(1);
          return {} as Electron.Session;
        }),
    }),
    ...(mainWindowSets && {
      setMainWindow: (window) =>
        Effect.sync(() => {
          mainWindowSets.push(window);
        }),
    }),
  };
};

/**
 * Registers the fork's cases inside upstream's `DesktopWindow` suite, so they
 * share its harness. Each fork domain adds its cases here.
 */
export const registerDesktopWindowForkTests = (harness: DesktopWindowHarnessFork) => {
  const { makeFakeBrowserWindow, makeTestLayer } = harness;

  it.effect("leaves app context menus to the renderer while preserving native text actions", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const popupTemplates: Electron.MenuItemConstructorOptions[][] = [];
      const layer = makeTestLayer({
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
      const layer = makeTestLayer({
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
      const layer = makeTestLayer({
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

  it.effect("opens once the renderer is ready without a backend callback", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleRendererReady;
        assert.equal(yield* Ref.get(createCount), 1);
        assert.deepEqual(fakeWindow.loadURL.mock.calls[0], ["t3code-dev://app/"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("maps an agent desktop on its target workspace without requesting focus", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const workspaceMoves: { key: string; workspace: string }[] = [];
      const workspaceRuleEvents: {
        action: "stage" | "clear";
        title: string;
        workspace?: string;
      }[] = [];
      const placementLifecycle: string[] = [];
      fakeWindow.setTitle.mockImplementation((title) => {
        placementLifecycle.push(`title:${title}`);
      });
      const revealRequests: number[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        workspaceMoves,
        workspaceRuleEvents,
        placementLifecycle,
        onReveal: () => revealRequests.push(1),
        environmentEnv: {
          T3CODE_DESKTOP_DEVTOOLS: "0",
          T3CODE_DESKTOP_AGENT_WORKSPACE: "8",
          T3CODE_DESKTOP_AGENT_PLACEMENT_TITLE: "t3code-dev-agent-test",
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        assert.equal(createdWindowOptions[0]?.title, "t3code-dev-agent-test");
        assert.deepEqual(revealRequests, []);

        const readyToShow = fakeWindow.windowListeners.get("ready-to-show");
        if (!readyToShow) return yield* Effect.die("ready-to-show listener was not registered");
        readyToShow();
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

        assert.equal(fakeWindow.showInactive.mock.calls.length, 1);
        assert.deepEqual(revealRequests, []);
        assert.deepEqual(workspaceRuleEvents, [
          {
            action: "stage",
            title: "t3code-dev-agent-test",
            workspace: "8",
          },
          { action: "clear", title: "t3code-dev-agent-test" },
        ]);
        assert.deepEqual(workspaceMoves, [{ key: testWindowId(1), workspace: "8" }]);
        assert.deepEqual(fakeWindow.setTitle.mock.calls, [
          ["t3code-dev-agent-test"],
          ["T3 Code (Dev)"],
        ]);
        assert.deepEqual(placementLifecycle, [
          "stage:8",
          "title:t3code-dev-agent-test",
          "title:T3 Code (Dev)",
          "move:8",
          "clear",
        ]);
        assert.equal(fakeWindow.openDevTools.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("leaves an unplaced restored window wherever Hyprland puts it", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const workspaceMoves: { key: string; workspace: string }[] = [];
      const layer = makeTestLayer({
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
      const layer = makeTestLayer({
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
        assert.isFalse(fakeWindow.windowListeners.has("resize"));

        fakeWindow.windowListeners.get("ready-to-show")?.();
        yield* Effect.yieldNow;
        assert.deepEqual(
          placementClaims.map((claim) => claim.key),
          [testWindowId(1)],
        );
        const pageTitleUpdated = fakeWindow.windowListeners.get("page-title-updated");
        const preventDefault = vi.fn();
        pageTitleUpdated?.({ preventDefault }, "Project One");
        assert.equal(preventDefault.mock.calls.length, 1);
        assert.deepEqual(fakeWindow.setTitle.mock.calls, [["Project One"]]);

        yield* desktopWindow.openArguments(["t3code-dev://app/project/environment-1/project-1"]);
        assert.equal(yield* Ref.get(createCount), 1);

        fakeWindow.webContentsListeners.get("did-navigate-in-page")?.({}, "t3code-dev://app/");
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(fakeWindow.close.mock.calls.length, 0);
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
      const layer = makeTestLayer({
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

  it.effect("still honours an explicit launch intent alongside a restore", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        workspaceMoves: [],
        restoreEntries: [testRestoreEntry("all-projects", { id: 1, name: "1" })],
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.restoreWindowSession;
        yield* desktopWindow.openArguments(["t3code", "--project", "environment-2", "project-2"]);
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

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
};
