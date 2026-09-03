import { it as effectIt } from "@effect/vitest";
import { EnvironmentId, ProjectId, type DesktopBridge } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { describe, expect, it, vi } from "vite-plus/test";

import { projectWindowIdentity } from "../window/WindowIdentity.ts";
import { PROJECT_WINDOW_PRELOAD_ARGUMENT } from "../window/projectWindowArgument.ts";
import type { PreviewTabState } from "./Manager.ts";
import { exposePreviewCapability } from "./WindowPolicy.preload.ts";
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

class TestOwnershipError extends Data.TaggedError("PreviewTabOwnershipError")<{
  readonly tabId: string;
  readonly requestingWindow: string;
}> {}

class TestAuthorizationError extends Data.TaggedError("PreviewIpcSenderNotAuthorizedError")<{
  readonly reason: "missing-sender" | "unregistered-window";
}> {}

const ownershipError = (tabId: string, requestingWindow: string) =>
  new TestOwnershipError({ tabId, requestingWindow }) as never;

const authorizationError = (reason: "missing-sender" | "unregistered-window") =>
  new TestAuthorizationError({ reason }) as never;

const makeOperationsFactory = () => {
  const tabSets: Set<string>[] = [];
  const stateListeners: Array<(tabId: string, state: PreviewTabState) => Effect.Effect<void>> = [];

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
        setMainWindow: () => Effect.void,
        destroy: () => Effect.void,
        subscribeStateChanges: (listener: typeof stateListener) =>
          Effect.sync(() => {
            stateListener = listener;
          }),
        subscribePointerEvents: () => Effect.void,
        subscribeRecordingFrames: () => Effect.void,
      } as unknown as WindowPolicy.OwnedPreviewOperations;
    });

  return { create, stateListeners, tabSets };
};

describe("desktop preview window policy", () => {
  it("exposes preview only in the hub preload", () => {
    const bridge = {} as Omit<DesktopBridge, "preview">;
    const preview = {} as NonNullable<DesktopBridge["preview"]>;

    expect(exposePreviewCapability(["electron"], bridge, preview).preview).toBe(preview);
    expect(
      exposePreviewCapability(
        ["electron", `${PROJECT_WINDOW_PRELOAD_ARGUMENT}=environment/project`],
        bridge,
        preview,
      ).preview,
    ).toBeUndefined();
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
      yield* (yield* policy.forWindow(identity)).createTab("old-tab");
      yield* policy.disposeWindow(identity);
      yield* (yield* policy.forWindow(identity)).createTab("new-tab");

      expect(operations.tabSets).toHaveLength(3);
      expect(operations.tabSets[1]?.has("old-tab")).toBe(false);
      expect(operations.tabSets[2]?.has("new-tab")).toBe(true);
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
