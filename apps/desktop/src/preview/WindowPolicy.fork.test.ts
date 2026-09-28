import { it as effectIt } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type DesktopBridge,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "../ipc/channels.ts";
import { type WindowId, windowIdPreloadArgument } from "../window/WindowId.fork.ts";
import { HUB_WINDOW_IDENTITY, windowPreloadArguments } from "../window/WindowIdentity.ts";
import { projectWindowPreloadArgument } from "../window/projectWindowArgument.ts";
import { PreviewTabOwnershipError, type PreviewTabState } from "./Manager.ts";
import {
  exposePreviewCapability,
  type PreviewCapableDesktopBridge,
} from "./WindowPolicy.preload.ts";
import * as WindowPolicy from "./WindowPolicy.ts";

const { fromWebContents, fromId, ipcRenderer } = vi.hoisted(() => ({
  fromWebContents: vi.fn(() => null as Electron.BrowserWindow | null),
  fromId: vi.fn(() => null as Electron.WebContents | null),
  ipcRenderer: {
    on: vi.fn<(channel: string, listener: (event: unknown, ...args: never[]) => void) => void>(),
    invoke: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents },
  ipcRenderer,
  webContents: { fromId },
}));

// The preload module subscribes once at load, and Vitest clears mock calls
// before each test, so its load-time subscriptions are kept here.
const loadSubscriptions = [...ipcRenderer.on.mock.calls];
const subscriptions = () => [...loadSubscriptions, ...ipcRenderer.on.mock.calls];

/** Replays what the main process pushes on a preload channel the bridge subscribed to. */
const emit = (channel: string, ...args: ReadonlyArray<unknown>) => {
  for (const [subscribed, listener] of subscriptions())
    if (subscribed === channel) listener({}, ...(args as never[]));
};

const firstWindowId = "00000000-0000-4000-8000-000000000001" as WindowId;
const secondWindowId = "00000000-0000-4000-8000-000000000002" as WindowId;

const idleState = (tabId: string): PreviewTabState => ({
  tabId,
  webContentsId: null,
  navStatus: { kind: "Idle" },
  canGoBack: false,
  canGoForward: false,
  zoomFactor: 1,
  pictureInPicture: false,
  colorScheme: "system",
  audioMuted: false,
  audible: false,
  controller: "none",
  updatedAt: "2026-09-03T00:00:00.000Z",
});

class TestAuthorizationError extends Data.TaggedError("PreviewIpcSenderNotAuthorizedError")<{
  readonly reason: "missing-sender" | "unregistered-window";
}> {}

const ownershipError = (tabId: string, requestingWindow: string) =>
  new PreviewTabOwnershipError({ tabId, requestingWindow });

const authorizationError = (reason: "missing-sender" | "unregistered-window") =>
  new TestAuthorizationError({ reason });

const makeOperationsFactory = (
  setMainWindow: (window: Electron.BrowserWindow) => Effect.Effect<void> = () => Effect.void,
) => {
  const tabSets: Set<string>[] = [];
  const stateListeners: Array<(tabId: string, state: PreviewTabState) => Effect.Effect<void>> = [];
  let stateListenerRemovals = 0;

  const create = (scope: Scope.Closeable) =>
    Effect.gen(function* () {
      const tabs = new Set<string>();
      tabSets.push(tabs);
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => tabs.clear()),
      );
      let stateListener = (_tabId: string, _state: PreviewTabState) => Effect.void;
      stateListeners.push((tabId, state) => stateListener(tabId, state));
      return {
        hasTab: (tabId: string) => Effect.succeed(tabs.has(tabId)),
        createTab: (tabId: string) =>
          Effect.gen(function* () {
            tabs.add(tabId);
            const state = idleState(tabId);
            yield* stateListener(tabId, state);
            return state;
          }),
        closeTab: (tabId: string) => Effect.sync(() => void tabs.delete(tabId)),
        setMainWindow,
        subscribeStateChanges: (listener: typeof stateListener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              stateListener = listener;
            }),
            () =>
              Effect.sync(() => {
                stateListener = () => Effect.void;
                stateListenerRemovals += 1;
              }),
          ).pipe(Effect.asVoid),
        subscribePointerEvents: () => Effect.void,
        subscribeRecordingFrames: () => Effect.void,
        subscribeRecordingInputs: () => Effect.void,
      } as unknown as WindowPolicy.OwnedPreviewOperations;
    });

  return {
    create,
    stateListeners,
    tabSets,
    get stateListenerRemovals() {
      return stateListenerRemovals;
    },
  };
};

const makeWindow = () => {
  let closed: (() => void) | undefined;
  const window = {
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "closed") closed = listener;
    }),
  } as unknown as Electron.BrowserWindow;
  return { window, close: () => closed?.() };
};

describe("desktop preview window policy", () => {
  it("preserves the assembled upstream bridge in every desktop preload", () => {
    const preview = {} as NonNullable<DesktopBridge["preview"]>;
    const openExternal = vi.fn();
    const bridge = { preview, openExternal } as unknown as PreviewCapableDesktopBridge;

    const exposed = exposePreviewCapability(bridge);

    // The upstream literal is handed over untouched; the fork only adds to it.
    expect(exposed.preview).toBe(preview);
    expect(exposed.openExternal).toBe(openExternal);
  });

  it("adds project-window capabilities the upstream bridge literal never declares", () => {
    const originalArgv = process.argv;
    process.argv = [
      "electron",
      windowIdPreloadArgument(firstWindowId),
      projectWindowPreloadArgument({ environmentId: "environment 1", projectId: "project/1" }),
    ];
    try {
      const exposed = exposePreviewCapability({} as PreviewCapableDesktopBridge);

      // Main's id comes back verbatim, apart from the project the window shows.
      expect(exposed.windowId).toBe(firstWindowId);
      expect(exposed.projectWindowRef).toStrictEqual({
        environmentId: "environment 1",
        projectId: "project/1",
      });
      void exposed.openProjectWindow({
        environmentId: EnvironmentId.make("environment-2"),
        projectId: ProjectId.make("project-2"),
      });
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(IpcChannels.OPEN_PROJECT_WINDOW_CHANNEL, {
        environmentId: "environment-2",
        projectId: "project-2",
      });
    } finally {
      process.argv = originalArgv;
    }
  });

  it("reads the window id main passed, and none from a window main did not create", () => {
    const originalArgv = process.argv;
    try {
      process.argv = ["electron", windowIdPreloadArgument(secondWindowId)];
      expect(exposePreviewCapability({} as PreviewCapableDesktopBridge).windowId).toBe(
        secondWindowId,
      );
      process.argv = ["electron", "--t3code-window-id=project:environment-1:project-1"];
      expect(exposePreviewCapability({} as PreviewCapableDesktopBridge)).not.toHaveProperty(
        "windowId",
      );
      process.argv = ["electron"];
      expect(exposePreviewCapability({} as PreviewCapableDesktopBridge)).not.toHaveProperty(
        "windowId",
      );
    } finally {
      process.argv = originalArgv;
    }
  });

  it("reads the scope seed main passed a new window, all projects included, and none when unseeded", () => {
    const originalArgv = process.argv;
    const seed = { environmentId: "environment 1", projectId: "project/1" };
    try {
      process.argv = [
        "electron",
        ...windowPreloadArguments(HUB_WINDOW_IDENTITY, firstWindowId, seed as ScopedProjectRef),
      ];
      expect(exposePreviewCapability({} as PreviewCapableDesktopBridge).windowScopeSeed).toEqual(
        seed,
      );
      process.argv = [
        "electron",
        ...windowPreloadArguments(HUB_WINDOW_IDENTITY, firstWindowId, "all-projects"),
      ];
      expect(exposePreviewCapability({} as PreviewCapableDesktopBridge).windowScopeSeed).toBe(
        "all-projects",
      );
      process.argv = ["electron", ...windowPreloadArguments(HUB_WINDOW_IDENTITY, firstWindowId)];
      expect(exposePreviewCapability({} as PreviewCapableDesktopBridge).windowScopeSeed).toBeNull();
      process.argv = ["electron", "--t3code-window-scope-seed=only-one-part"];
      expect(exposePreviewCapability({} as PreviewCapableDesktopBridge).windowScopeSeed).toBeNull();
    } finally {
      process.argv = originalArgv;
    }
  });

  it("tracks hub demand state per preload and stops after unsubscribe", () => {
    const exposed = exposePreviewCapability({} as PreviewCapableDesktopBridge);
    const seen: Array<boolean> = [];
    const unsubscribe = exposed.onWindowDemandStateChange((demanded) => seen.push(demanded));

    expect(exposed.getWindowDemandState()).toBe(true);
    emit(IpcChannels.WINDOW_DEMAND_STATE_CHANNEL, false);
    emit(IpcChannels.WINDOW_DEMAND_STATE_CHANNEL, false);
    emit(IpcChannels.WINDOW_DEMAND_STATE_CHANNEL, "no");
    expect(exposed.getWindowDemandState()).toBe(false);

    unsubscribe();
    emit(IpcChannels.WINDOW_DEMAND_STATE_CHANNEL, true);

    // Repeats and non-boolean payloads never reach a listener, and the state
    // keeps advancing for `getWindowDemandState` after the listener is gone.
    expect(seen).toStrictEqual([false]);
    expect(exposed.getWindowDemandState()).toBe(true);
  });

  it("subscribes the demand channel once no matter how many bridges are exposed", () => {
    const before = subscriptions().filter(
      ([channel]) => channel === IpcChannels.WINDOW_DEMAND_STATE_CHANNEL,
    ).length;

    exposePreviewCapability({} as PreviewCapableDesktopBridge);
    exposePreviewCapability({} as PreviewCapableDesktopBridge);

    // The listener belongs to the preload module, not to a bridge, so a repeat
    // call never adds a second `ipcRenderer` subscription.
    expect(
      subscriptions().filter(([channel]) => channel === IpcChannels.WINDOW_DEMAND_STATE_CHANNEL)
        .length,
    ).toBe(before);
    expect(before).toBe(1);
  });

  effectIt.effect("keeps project preview events out of hub compatibility listeners", () => {
    const operations = makeOperationsFactory();

    return Effect.gen(function* () {
      const policy = yield* WindowPolicy.makeWindowOwnership(operations.create, ownershipError);
      const hubDeliveries: string[] = [];
      yield* policy.subscribeStateChanges((tabId) => Effect.sync(() => hubDeliveries.push(tabId)));
      const project = yield* policy.forWindow(firstWindowId);

      yield* project.createTab("project-tab");
      yield* policy.app.createTab("hub-tab");

      expect(operations.tabSets[1]?.has("project-tab")).toBe(true);
      expect(hubDeliveries).toEqual(["hub-tab"]);
    }).pipe(Effect.scoped);
  });

  effectIt.effect("forwards an event only to its owning window", () => {
    const firstSend = vi.fn();
    const secondSend = vi.fn();
    const getById = vi.fn((windowId: WindowId) =>
      Effect.succeed(
        Option.some({
          webContents: { send: windowId === firstWindowId ? firstSend : secondSend },
        } as never),
      ),
    );
    let stateListener: (
      owner: WindowPolicy.PreviewOwner,
      tabId: string,
      state: PreviewTabState,
    ) => Effect.Effect<void> = () => Effect.void;

    return Effect.gen(function* () {
      yield* WindowPolicy.installEventForwarding(
        { getById } as never,
        {
          subscribeOwnedStateChanges: (listener: typeof stateListener) =>
            Effect.sync(() => {
              stateListener = listener;
            }),
          subscribeOwnedRecordingFrames: () => Effect.void,
          subscribeOwnedRecordingInputs: () => Effect.void,
          subscribeOwnedPointerEvents: () => Effect.void,
        } as never,
        {
          stateChange: "preview-state",
          recordingFrame: "preview-recording",
          recordingInput: "preview-recording-input",
          pointerEvent: "preview-pointer",
        },
      );

      yield* stateListener(firstWindowId, "tab-1", idleState("tab-1"));
      // The app owner has no renderer of its own; its events stay in main.
      yield* stateListener(WindowPolicy.APP_PREVIEW_OWNER, "app-tab", idleState("app-tab"));

      expect(getById).toHaveBeenCalledOnce();
      expect(getById).toHaveBeenCalledWith(firstWindowId);
      expect(firstSend).toHaveBeenCalledOnce();
      expect(firstSend).toHaveBeenCalledWith("preview-state", "tab-1", idleState("tab-1"));
      expect(secondSend).not.toHaveBeenCalled();
    }).pipe(Effect.scoped);
  });

  effectIt.effect("namespaces tabs and reports cross-window ownership", () => {
    const operations = makeOperationsFactory();

    return Effect.gen(function* () {
      const policy = yield* WindowPolicy.makeWindowOwnership(operations.create, ownershipError);
      const first = yield* policy.forWindow(firstWindowId);
      const second = yield* policy.forWindow(secondWindowId);
      const deliveries: string[] = [];
      yield* policy.subscribeOwnedStateChanges((owner, tabId) =>
        Effect.sync(() => deliveries.push(`${owner}:${tabId}`)),
      );

      yield* first.createTab("shared-tab");
      yield* second.createTab("shared-tab");
      yield* first.createTab("first-only");
      const exit = yield* Effect.exit(second.closeTab("first-only"));

      expect(operations.tabSets).toHaveLength(3); // eager hub plus two project windows
      expect(deliveries).toEqual([
        `${firstWindowId}:shared-tab`,
        `${secondWindowId}:shared-tab`,
        `${firstWindowId}:first-only`,
      ]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "PreviewTabOwnershipError",
          tabId: "first-only",
        });
      }
    }).pipe(Effect.scoped);
  });

  effectIt.effect("recreates disposed window state without disturbing other windows", () => {
    const operations = makeOperationsFactory();

    return Effect.gen(function* () {
      const policy = yield* WindowPolicy.makeWindowOwnership(operations.create, ownershipError);
      const deliveries: string[] = [];
      yield* policy.subscribeOwnedStateChanges((_owner, tabId) =>
        Effect.sync(() => deliveries.push(tabId)),
      );
      yield* (yield* policy.forWindow(firstWindowId)).createTab("old-tab");
      yield* policy.disposeWindow(firstWindowId);
      const staleListener = operations.stateListeners[1];
      if (staleListener === undefined) return yield* Effect.die("missing project listener");
      yield* staleListener("stale-tab", idleState("stale-tab"));
      yield* (yield* policy.forWindow(firstWindowId)).createTab("new-tab");

      expect(operations.tabSets).toHaveLength(3);
      expect(operations.tabSets[1]?.has("old-tab")).toBe(false);
      expect(operations.tabSets[2]?.has("new-tab")).toBe(true);
      expect(operations.stateListenerRemovals).toBe(1);
      expect(deliveries).toEqual(["old-tab", "new-tab"]);
    }).pipe(Effect.scoped);
  });

  effectIt.effect("keeps a replacement window registered when the old close races it", () => {
    const first = makeWindow();
    const replacement = makeWindow();

    return Effect.gen(function* () {
      const replacementStarted = yield* Deferred.make<void>();
      const replacementReleased = yield* Deferred.make<void>();
      const operations = makeOperationsFactory((window) =>
        window === replacement.window
          ? Deferred.succeed(replacementStarted, undefined).pipe(
              Effect.andThen(Deferred.await(replacementReleased)),
            )
          : Effect.void,
      );
      const policy = yield* WindowPolicy.makeWindowOwnership(operations.create, ownershipError);
      yield* policy.setWindow(firstWindowId, first.window);
      const replacing = yield* policy
        .setWindow(firstWindowId, replacement.window)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(replacementStarted);

      first.close();
      yield* Effect.yieldNow;
      yield* Deferred.succeed(replacementReleased, undefined);
      yield* Fiber.join(replacing);
      yield* Effect.yieldNow;
      yield* (yield* policy.forWindow(firstWindowId)).createTab("replacement-tab");

      expect(operations.tabSets).toHaveLength(2); // eager hub plus the retained project window
      expect(operations.tabSets[1]?.has("replacement-tab")).toBe(true);
      expect(operations.stateListenerRemovals).toBe(0);
    }).pipe(Effect.scoped);
  });

  effectIt.effect("authorizes a registered sender and selects its window manager", () => {
    const sender = { id: 1 } as Electron.WebContents;
    const senderWindow = {} as Electron.BrowserWindow;
    const windowManager = { closeTab: vi.fn() };
    const forWindow = vi.fn(() => Effect.succeed(windowManager));
    fromId.mockReturnValue(sender);
    fromWebContents.mockReturnValue(senderWindow);

    return Effect.gen(function* () {
      const resolved = yield* WindowPolicy.resolvePreviewForSender(
        { sender },
        { windowIdFor: () => Effect.succeed(Option.some(firstWindowId)) } as never,
        { forWindow } as never,
        authorizationError,
      );

      expect(resolved.windowId).toBe(firstWindowId);
      expect(forWindow).toHaveBeenCalledWith(firstWindowId);
      expect(resolved.windowManager).toBe(windowManager);
    });
  });

  effectIt.effect("rejects a sender outside the desktop window registry", () => {
    const sender = { id: 1 } as Electron.WebContents;
    fromId.mockReturnValue(sender);
    fromWebContents.mockReturnValue({} as Electron.BrowserWindow);

    return WindowPolicy.resolvePreviewForSender(
      { sender },
      { windowIdFor: () => Effect.succeed(Option.none()) } as never,
      null as never,
      authorizationError,
    ).pipe(
      Effect.exit,
      Effect.map((exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "PreviewIpcSenderNotAuthorizedError",
          reason: "unregistered-window",
        });
      }),
    );
  });
});
