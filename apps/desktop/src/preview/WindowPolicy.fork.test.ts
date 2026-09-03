import { it as effectIt } from "@effect/vitest";
import { EnvironmentId, ProjectId, type DesktopBridge } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { describe, expect, it, vi } from "vite-plus/test";

import { projectWindowIdentity, windowIdentityKey } from "../window/WindowIdentity.ts";
import { PreviewTabOwnershipError, type PreviewTabState } from "./Manager.ts";
import {
  exposePreviewCapability,
  type PreviewCapableDesktopBridge,
} from "./WindowPolicy.preload.ts";
import * as WindowPolicy from "./WindowPolicy.ts";

const { fromWebContents } = vi.hoisted(() => ({
  fromWebContents: vi.fn(() => null as Electron.BrowserWindow | null),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents },
}));

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
    const bridge = { preview } as PreviewCapableDesktopBridge;

    expect(exposePreviewCapability(bridge)).toBe(bridge);
    expect(exposePreviewCapability(bridge).preview).toBe(preview);
  });

  effectIt.effect("keeps project preview events out of hub compatibility listeners", () => {
    const operations = makeOperationsFactory();
    const identity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );

    return Effect.gen(function* () {
      const policy = yield* WindowPolicy.makeWindowOwnership(operations.create, ownershipError);
      const hubDeliveries: string[] = [];
      yield* policy.subscribeStateChanges((tabId) => Effect.sync(() => hubDeliveries.push(tabId)));
      const project = yield* policy.forWindow(identity);

      yield* project.createTab("project-tab");
      yield* policy.hub.createTab("hub-tab");

      expect(operations.tabSets[1]?.has("project-tab")).toBe(true);
      expect(hubDeliveries).toEqual(["hub-tab"]);
    }).pipe(Effect.scoped);
  });

  effectIt.effect("forwards an event only to its owning window", () => {
    const firstIdentity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );
    const secondIdentity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-2"),
    );
    const firstSend = vi.fn();
    const secondSend = vi.fn();
    const get = vi.fn((identity: WindowPolicy.WindowIdentity) =>
      Effect.succeed(
        Option.some({
          webContents: {
            send:
              windowIdentityKey(identity) === windowIdentityKey(firstIdentity)
                ? firstSend
                : secondSend,
          },
        } as never),
      ),
    );
    let stateListener: (
      identity: WindowPolicy.WindowIdentity,
      tabId: string,
      state: PreviewTabState,
    ) => Effect.Effect<void> = () => Effect.void;

    return Effect.gen(function* () {
      yield* WindowPolicy.installEventForwarding(
        { get } as never,
        {
          subscribeOwnedStateChanges: (listener: typeof stateListener) =>
            Effect.sync(() => {
              stateListener = listener;
            }),
          subscribeOwnedRecordingFrames: () => Effect.void,
          subscribeOwnedPointerEvents: () => Effect.void,
        } as never,
        {
          stateChange: "preview-state",
          recordingFrame: "preview-recording",
          pointerEvent: "preview-pointer",
        },
      );

      yield* stateListener(firstIdentity, "tab-1", idleState("tab-1"));

      expect(get).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledWith(firstIdentity);
      expect(firstSend).toHaveBeenCalledOnce();
      expect(firstSend).toHaveBeenCalledWith("preview-state", "tab-1", idleState("tab-1"));
      expect(secondSend).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalledWith(secondIdentity);
    }).pipe(Effect.scoped);
  });

  effectIt.effect("namespaces tabs and reports cross-window ownership", () => {
    const operations = makeOperationsFactory();
    const firstIdentity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );
    const secondIdentity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-2"),
    );

    return Effect.gen(function* () {
      const policy = yield* WindowPolicy.makeWindowOwnership(operations.create, ownershipError);
      const first = yield* policy.forWindow(firstIdentity);
      const second = yield* policy.forWindow(secondIdentity);
      const deliveries: string[] = [];
      yield* policy.subscribeOwnedStateChanges((identity, tabId) =>
        Effect.sync(() => deliveries.push(`${identity.kind}:${tabId}`)),
      );

      yield* first.createTab("shared-tab");
      yield* second.createTab("shared-tab");
      yield* first.createTab("first-only");
      const exit = yield* Effect.exit(second.closeTab("first-only"));

      expect(operations.tabSets).toHaveLength(3); // eager hub plus two project windows
      expect(deliveries).toEqual([
        "project:shared-tab",
        "project:shared-tab",
        "project:first-only",
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
    const identity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );

    return Effect.gen(function* () {
      const policy = yield* WindowPolicy.makeWindowOwnership(operations.create, ownershipError);
      const deliveries: string[] = [];
      yield* policy.subscribeOwnedStateChanges((_identity, tabId) =>
        Effect.sync(() => deliveries.push(tabId)),
      );
      yield* (yield* policy.forWindow(identity)).createTab("old-tab");
      yield* policy.disposeWindow(identity);
      const staleListener = operations.stateListeners[1];
      if (staleListener === undefined) return yield* Effect.die("missing project listener");
      yield* staleListener("stale-tab", idleState("stale-tab"));
      yield* (yield* policy.forWindow(identity)).createTab("new-tab");

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
    const identity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );

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
      yield* policy.setWindow(identity, first.window);
      const replacing = yield* policy
        .setWindow(identity, replacement.window)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(replacementStarted);

      first.close();
      yield* Effect.yieldNow;
      yield* Deferred.succeed(replacementReleased, undefined);
      yield* Fiber.join(replacing);
      yield* Effect.yieldNow;
      yield* (yield* policy.forWindow(identity)).createTab("replacement-tab");

      expect(operations.tabSets).toHaveLength(2); // eager hub plus the retained project window
      expect(operations.tabSets[1]?.has("replacement-tab")).toBe(true);
      expect(operations.stateListenerRemovals).toBe(0);
    }).pipe(Effect.scoped);
  });

  effectIt.effect("authorizes a registered sender and selects its window manager", () => {
    const sender = {} as Electron.WebContents;
    const senderWindow = {} as Electron.BrowserWindow;
    const identity = projectWindowIdentity(
      EnvironmentId.make("environment-1"),
      ProjectId.make("project-1"),
    );
    const windowManager = { closeTab: vi.fn() };
    fromWebContents.mockReturnValue(senderWindow);

    return Effect.gen(function* () {
      const resolved = yield* WindowPolicy.resolvePreviewForSender(
        { sender },
        { identityFor: () => Effect.succeed(Option.some(identity)) } as never,
        { forWindow: () => Effect.succeed(windowManager) } as never,
        authorizationError,
      );

      expect(resolved.identity).toEqual(identity);
      expect(resolved.windowManager).toBe(windowManager);
    });
  });

  effectIt.effect("rejects a sender outside the desktop window registry", () => {
    const sender = {} as Electron.WebContents;
    fromWebContents.mockReturnValue({} as Electron.BrowserWindow);

    return WindowPolicy.resolvePreviewForSender(
      { sender },
      { identityFor: () => Effect.succeed(Option.none()) } as never,
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
