import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { describe, expect, vi } from "vite-plus/test";
import type { WindowId } from "../window/WindowId.fork.ts";
import { previewManagerFixtureLayer } from "./Manager.fork-test-harness.ts";
import { forkSupersedes } from "../../../../scripts/lib/fork-supersedes.ts";
import * as PreviewManager from "./Manager.ts";

const { fromId, webviewSend } = vi.hoisted(() => ({
  fromId: vi.fn<(_id?: number) => Electron.WebContents | null>(() => null),
  webviewSend: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  clipboard: { writeImage: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  session: { fromPartition: vi.fn() },
  webContents: { fromId, getFocusedWebContents: vi.fn(() => null) },
}));

const layer = previewManagerFixtureLayer();
const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) => Effect.flatMap(PreviewManager.PreviewManager, use).pipe(Effect.provide(layer), Effect.scoped);

describe("fork preview manager ownership", () => {
  effectIt.effect("namespaces equal tab ids by owning window and routes events to that owner", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstWindowId = "00000000-0000-4000-8000-000000000001" as WindowId;
        const secondWindowId = "00000000-0000-4000-8000-000000000002" as WindowId;
        const first = yield* manager.forWindow(firstWindowId);
        const second = yield* manager.forWindow(secondWindowId);
        const deliveries: string[] = [];
        yield* manager.subscribeOwnedStateChanges((owner, tabId) =>
          Effect.sync(() => {
            deliveries.push(`${owner}:${tabId}`);
          }),
        );

        const firstState = yield* first.createTab("shared-tab", { zoomFactor: 1.25 });
        const secondState = yield* second.createTab("shared-tab", { zoomFactor: 0.8 });

        expect(firstState.zoomFactor).toBe(1.25);
        expect(secondState.zoomFactor).toBe(0.8);
        expect(deliveries).toEqual([`${firstWindowId}:shared-tab`, `${secondWindowId}:shared-tab`]);
      }),
    ),
  );

  effectIt.effect("explicitly rejects a tab owned only by another window", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const owner = yield* manager.forWindow("00000000-0000-4000-8000-00000000000a" as WindowId);
        const other = yield* manager.forWindow("00000000-0000-4000-8000-00000000000b" as WindowId);
        yield* owner.createTab("owned-tab");

        const exit = yield* Effect.exit(other.closeTab("owned-tab"));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewTabOwnershipError",
            tabId: "owned-tab",
          });
        }
      }),
    ),
  );
});

type Listener = (...args: unknown[]) => void;

interface TestCapturedPreviewImage {
  readonly toJPEG: () => Buffer;
  readonly getSize: () => { readonly width: number; readonly height: number };
}

type TestDisplayMediaHandler = (
  request: { readonly frame: { readonly frameTreeNodeId: number } | null },
  callback: (streams: { video?: unknown }) => void,
) => void;

interface TestHostWebContents {
  readonly id: number;
  readonly mainFrame: { readonly frameTreeNodeId: number };
  readonly executeJavaScript: ReturnType<typeof vi.fn>;
  readonly isDestroyed: () => boolean;
  readonly session: {
    readonly setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>;
  };
  readonly displayMediaHandler: () => TestDisplayMediaHandler | undefined;
}

type TestPreviewWebContents = Electron.WebContents & {
  readonly setBackgroundThrottling: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
};

const makeTestHostWebContents = (): TestHostWebContents => {
  let handler: TestDisplayMediaHandler | undefined;
  return {
    id: 7,
    mainFrame: { frameTreeNodeId: 7 },
    executeJavaScript: vi.fn(async () => true),
    isDestroyed: () => false,
    session: {
      setDisplayMediaRequestHandler: vi.fn((next: TestDisplayMediaHandler) => {
        handler = next;
      }),
    },
    displayMediaHandler: () => handler,
  };
};

const makeTestPreviewWebContents = (
  capturePage: () => Promise<TestCapturedPreviewImage>,
  id = 42,
  hostWebContents: TestHostWebContents = makeTestHostWebContents(),
) => {
  const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
  return {
    id,
    mainFrame: { routingId: id },
    hostWebContents,
    executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.com",
    getTitle: () => "Example",
    isLoading: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    setBackgroundThrottling,
    isCurrentlyAudible: () => false,
    on: vi.fn(),
    off: vi.fn(),
    ipc: { on: vi.fn(), off: vi.fn() },
    send: webviewSend,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
    },
    capturePage,
  } as unknown as TestPreviewWebContents;
};

const settle = function* (until: () => boolean) {
  for (let attempt = 0; attempt < 30 && !until(); attempt++) {
    yield* Effect.promise(() => Promise.resolve());
  }
};

describe("fork preview manager zoom and window close", () => {
  effectIt.effect("honors guest wheel zoom through the tab-owned state", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const listeners = new Map<string, Listener>();
        const off = vi.fn();
        const setZoomFactor = vi.fn();
        const on = vi.fn((event: string, listener: Listener) => {
          listeners.set(event, listener);
        });
        fromId.mockReturnValue(
          Object.assign(makeTestPreviewWebContents(vi.fn(), 42), { setZoomFactor, on, off }),
        );
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_wheel");
        yield* manager.registerWebview("tab_wheel", 42);

        const staleZoomChanged = listeners.get("zoom-changed");
        setZoomFactor.mockClear();
        staleZoomChanged?.({} as never, "in");
        yield* settle(() => states.at(-1)?.zoomFactor === 1.1);
        expect(setZoomFactor).toHaveBeenLastCalledWith(1.1);
        expect(states.at(-1)?.zoomFactor).toBe(1.1);

        staleZoomChanged?.({} as never, "out");
        yield* settle(() => states.at(-1)?.zoomFactor === 1);
        expect(setZoomFactor).toHaveBeenLastCalledWith(1);
        expect(states.at(-1)?.zoomFactor).toBe(1);

        yield* manager.zoomIn("tab_wheel");
        const replacementListeners = new Map<string, Listener>();
        const replacementSetZoomFactor = vi.fn();
        const replacementOn = vi.fn((event: string, listener: Listener) => {
          replacementListeners.set(event, listener);
        });
        fromId.mockReturnValue(
          Object.assign(makeTestPreviewWebContents(vi.fn(), 43), {
            setZoomFactor: replacementSetZoomFactor,
            on: replacementOn,
          }),
        );
        yield* manager.registerWebview("tab_wheel", 43);
        expect(replacementSetZoomFactor).toHaveBeenCalledWith(1.1);

        // The replaced guest's wheel listener is unbound and ignored.
        expect(off).toHaveBeenCalledWith("zoom-changed", staleZoomChanged);
        replacementSetZoomFactor.mockClear();
        staleZoomChanged?.({} as never, "in");
        yield* settle(() => false);
        expect(replacementSetZoomFactor).not.toHaveBeenCalled();
        expect(states.at(-1)?.zoomFactor).toBe(1.1);

        // Wheel requests stop at the zoom bounds.
        for (let index = 0; index < 20; index += 1) yield* manager.zoomIn("tab_wheel");
        expect(states.at(-1)?.zoomFactor).toBe(5);
        replacementSetZoomFactor.mockClear();
        replacementListeners.get("zoom-changed")?.({} as never, "in");
        yield* settle(() => false);
        expect(replacementSetZoomFactor).not.toHaveBeenCalled();

        for (let index = 0; index < 20; index += 1) yield* manager.zoomOut("tab_wheel");
        expect(states.at(-1)?.zoomFactor).toBe(0.25);
        replacementSetZoomFactor.mockClear();
        replacementListeners.get("zoom-changed")?.({} as never, "out");
        yield* settle(() => false);
        expect(replacementSetZoomFactor).not.toHaveBeenCalled();

        yield* manager.closeTab("tab_wheel");
        replacementListeners.get("zoom-changed")?.({} as never, "in");
        yield* settle(() => false);
        expect(replacementSetZoomFactor).not.toHaveBeenCalled();
      }),
    ),
  );

  // Fork restores guest zoom after the embedder's zoom lands (commit `e576b6454c8`).
  forkSupersedes({
    upstream:
      "apps/desktop/src/preview/Manager.test.ts > re-applies each tab's own zoom when the app window zooms",
    reason:
      "fork replaces reapplyZoom with preserveGuestZooms, which restores each guest only after the app window's zoom change runs",
    commit: "e576b6454c8",
  });
  effectIt.effect("preserves each tab's own zoom while the app window zooms", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor,
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_preserve");
        yield* manager.registerWebview("tab_preserve", 42);
        yield* manager.zoomIn("tab_preserve");
        setZoomFactor.mockClear();

        const restoreOrder: string[] = [];
        setZoomFactor.mockImplementation(() => {
          restoreOrder.push("guest");
        });
        yield* manager.preserveGuestZooms(() => {
          restoreOrder.push("embedder");
          expect(setZoomFactor).not.toHaveBeenCalled();
          queueMicrotask(() => restoreOrder.push("microtask"));
        });

        expect(restoreOrder).toEqual(["embedder", "guest"]);
        expect(setZoomFactor).toHaveBeenCalledTimes(1);
        expect(setZoomFactor).toHaveBeenCalledWith(1.1);
      }),
    ),
  );

  // Fork tabs belong to a window, so its close disposes them (commit `70240ecf8e5`).
  forkSupersedes({
    upstream:
      "apps/desktop/src/preview/Manager.test.ts > releases frame capture when the main window closes",
    reason:
      "fork disposes the closing window's preview tabs, so a raced start finds no tab instead of PreviewMainWindowClosedError, and other windows' tabs stay live",
    commit: "70240ecf8e5",
  });
  effectIt.effect("disposes preview tabs when their owning window closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        const firstWindowThrottling = vi.fn();
        const replacementWindowThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const host = makeTestHostWebContents();
        const webContentsById = new Map([
          [42, makeTestPreviewWebContents(capturePage, 42, host)],
          [43, makeTestPreviewWebContents(capturePage, 43, host)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );

        const otherWindowId = "00000000-0000-4000-8000-00000000000c" as WindowId;
        const otherWindow = yield* manager.forWindow(otherWindowId);
        // A creation default a dispose race would lose: a tab re-created after
        // the main window's close resets it, a surviving tab keeps it.
        yield* otherWindow.createTab("tab_other_window", { zoomFactor: 1.25 });
        yield* otherWindow.navigate("tab_other_window", "https://other.example");
        yield* manager.createTab("tab_window_close_recording");
        yield* manager.createTab("tab_window_close_race");
        yield* manager.registerWebview("tab_window_close_recording", 42);
        yield* manager.registerWebview("tab_window_close_race", 43);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          webContents: { setBackgroundThrottling: firstWindowThrottling },
        } as never);
        yield* manager.startRecording("tab_window_close_recording");
        expect(firstWindowThrottling.mock.calls).toEqual([[false]]);

        closeMainWindow?.();
        const otherWindowState: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeOwnedStateChanges((owner, _tabId, state) =>
          Effect.sync(() => {
            if (owner === otherWindowId) otherWindowState.push(state);
          }),
        );
        const racedStart = yield* Effect.exit(manager.startRecording("tab_window_close_race"));
        expect(Exit.isFailure(racedStart)).toBe(true);
        if (Exit.isFailure(racedStart)) {
          expect(Option.getOrThrow(Cause.findErrorOption(racedStart.cause))).toMatchObject({
            _tag: "PreviewTabNotFoundError",
            tabId: "tab_window_close_race",
          });
        }
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* otherWindow.navigate("tab_other_window", "https://other.example/after");
        // The other window's tab outlived the main window's close: the post-close
        // navigation still drives the tab created before it, creation zoom intact.
        expect(otherWindowState.at(-1)).toMatchObject({
          tabId: "tab_other_window",
          navStatus: { kind: "Loading", url: "https://other.example/after" },
          zoomFactor: 1.25,
        });

        const grants: Array<{ video?: unknown }> = [];
        host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => grants.push(value));
        expect(grants).toEqual([{}]);

        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);
        expect(replacementWindowThrottling).not.toHaveBeenCalled();
      }),
    ),
  );

  // Fork registers a closed listener per owner (commit `70240ecf8e5`).
  forkSupersedes({
    upstream:
      "apps/desktop/src/preview/Manager.test.ts > does not arm recording after the main window closes during warmup",
    reason:
      "fork registers more than one closed listener on the main window, and the upstream case keeps only the last one it was handed",
    commit: "70240ecf8e5",
  });
  effectIt.effect("does not arm recording when every close listener runs during warmup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const closeMainWindowListeners: Array<() => void> = [];
        let finishWarmup!: (image: TestCapturedPreviewImage) => void;
        let markWarmupStarted!: () => void;
        const warmupStarted = new Promise<void>((resolve) => {
          markWarmupStarted = resolve;
        });
        const capturedImage = {
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        const capturePage = vi.fn(
          () =>
            new Promise<TestCapturedPreviewImage>((resolve) => {
              markWarmupStarted();
              finishWarmup = resolve;
            }),
        );
        const host = makeTestHostWebContents();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42, host));

        yield* manager.createTab("tab_window_close_warmup");
        yield* manager.registerWebview("tab_window_close_warmup", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindowListeners.push(listener);
          }),
          webContents: { setBackgroundThrottling: vi.fn() },
        } as never);

        const start = yield* manager
          .startRecording("tab_window_close_warmup")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupStarted);
        for (const listener of closeMainWindowListeners) listener();
        finishWarmup(capturedImage);

        const exit = yield* Fiber.await(start);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_window_close_warmup",
          });
        }
        expect(host.session.setDisplayMediaRequestHandler).not.toHaveBeenCalled();
      }),
    ),
  );
});
