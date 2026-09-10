// Fork-owned harness pieces and cases for `DesktopWindow.test.ts`. The upstream
// file reaches them through `fork-hook` lines, so it keeps only upstream cases
// and its harness stays upstream's text (RSI-Software/t3code-hyprws#1493).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { WINDOW_DEMAND_STATE_CHANNEL } from "../ipc/channels.ts";
import type { DesktopWindowHarnessFork } from "./DesktopWindow.test.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

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
};
