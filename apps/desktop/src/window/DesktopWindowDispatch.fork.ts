import type { ScopedProjectRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import type * as ElectronWindow from "../electron/ElectronWindow.ts";
import type { DesktopWindowBounds } from "../settings/DesktopAppSettings.ts";
import type { WindowRestoreEntry } from "./DesktopWindowSession.ts";
import {
  dispatchWindowRequest,
  NEW_WINDOW_ROUTE,
  windowIdentityForSeed,
  type WindowCreateRequest,
  type WindowRequest,
} from "./WindowDispatch.fork.ts";
import type { WindowId } from "./WindowId.fork.ts";
import type { WindowIdentity } from "./WindowIdentity.ts";

// Fork-only: DesktopWindow's side of the window dispatch table
// (RSI-Software/t3code-hyprws#1343). `DesktopWindow.ts` carries one-line hooks
// into these helpers.

const { logInfo: logWindowInfo } = makeComponentLogger("desktop-window");

/**
 * Whether a window is the primary one the app opened itself. A dispatched
 * window (New Window, Open in New Window) is never primary: it leaves the one
 * saved bounds slot to the primary window.
 */
export const isPrimaryWindowFork = (
  identity: WindowIdentity,
  dispatched: WindowCreateRequest | undefined,
): boolean => identity.kind === "hub" && dispatched === undefined;

/**
 * The bounds a window opens with, before the display check: a restored
 * window's own, else the saved main-window slot for the primary window or a
 * restored all-projects window captured without bounds. Every other window
 * opens at the default size.
 */
export const initialWindowBoundsFork = (
  identity: WindowIdentity,
  dispatched: WindowCreateRequest | undefined,
  saved: DesktopWindowBounds | null,
): DesktopWindowBounds | null => {
  const restored = dispatched?.restored;
  if (restored !== undefined) return restored.bounds ?? (identity.kind === "hub" ? saved : null);
  return isPrimaryWindowFork(identity, dispatched) ? saved : null;
};

/** The renderer URL a new window opens at: the app root, or its dispatched route as the hash. */
export const dispatchedWindowUrlFork = (
  rootUrl: string,
  dispatched: WindowCreateRequest | undefined,
): string => {
  if (dispatched === undefined || dispatched.route === NEW_WINDOW_ROUTE) return rootUrl;
  const url = new URL(rootUrl);
  url.hash = dispatched.route;
  return url.href;
};

/**
 * Builds the startup drain's restore opener. Every manifest entry is its own
 * new window under its previous id, so extra all-projects or same-project
 * windows come back too instead of collapsing onto one per identity.
 */
export const makeDesktopWindowRestoreFork = <E>(input: {
  readonly electronWindow: ElectronWindow.ElectronWindow["Service"];
  readonly createWindow: (
    identity: WindowIdentity,
    windowId: WindowId,
    dispatched: WindowCreateRequest,
  ) => Effect.Effect<Electron.BrowserWindow, E>;
}) =>
  Effect.fn("desktop.window.restoreWindow")(function* (entry: WindowRestoreEntry) {
    const identity = windowIdentityForSeed(entry.seed);
    const request: WindowCreateRequest = {
      route: entry.route,
      seed: entry.seed,
      restored: { bounds: entry.bounds, workspace: entry.workspace },
    };
    const { window } = yield* input.electronWindow.createNew(
      identity,
      (windowId) => input.createWindow(identity, windowId, request),
      entry.windowId,
    );
    return window;
  });

/**
 * Builds DesktopWindow's `requestWindow` over the window registry. A
 * dispatched window's `request.seed` reaches `createWindow`, which hands it to
 * the renderer as its sidebar scope seed.
 */
export const makeDesktopWindowRequestFork = <E>(input: {
  readonly electronWindow: ElectronWindow.ElectronWindow["Service"];
  readonly createWindow: (
    identity: WindowIdentity,
    windowId: WindowId,
    dispatched: WindowCreateRequest,
  ) => Effect.Effect<Electron.BrowserWindow, E>;
  readonly openPrimary: Effect.Effect<unknown, E>;
  readonly createPrimary: Effect.Effect<unknown, E>;
}): ((request: WindowRequest) => Effect.Effect<void, E>) => {
  const { electronWindow } = input;
  const create = Effect.fn("desktop.window.createDispatchedWindow")(function* (
    request: WindowCreateRequest,
  ) {
    const identity = windowIdentityForSeed(request.seed);
    const { window } = yield* electronWindow.createNew(identity, (windowId) =>
      input.createWindow(identity, windowId, request),
    );
    yield* logWindowInfo("window opened by request", {
      route: request.route,
      seeded: request.seed !== "all-projects",
    });
    return window;
  });
  return dispatchWindowRequest({
    create,
    openPrimary: input.openPrimary,
    createPrimary: input.createPrimary,
    mostRecent: electronWindow.windowsByRecency.pipe(
      Effect.map((windows) => Option.fromNullishOr(windows[0])),
    ),
    showing: (ref: ScopedProjectRef) => electronWindow.get({ kind: "project", ref }),
    byId: electronWindow.getById,
    reveal: electronWindow.reveal,
  });
};

/**
 * Every all-projects window tracks its bounds flush; only the current main one
 * writes the saved slot, so a New Window that outlives main takes it over.
 */
export const makeCurrentMainBoundsFork = (
  readCurrentMain: () => Option.Option<Electron.BrowserWindow>,
) => {
  const flushes = new Map<Electron.BrowserWindow, Effect.Effect<void>>();
  return {
    track: (window: Electron.BrowserWindow, flush: Effect.Effect<void>) =>
      void flushes.set(window, flush),
    untrack: (window: Electron.BrowserWindow) => void flushes.delete(window),
    isCurrentMain: (window: Electron.BrowserWindow) =>
      Option.getOrUndefined(readCurrentMain()) === window,
    flush: Effect.suspend(() => {
      const main = Option.getOrUndefined(readCurrentMain());
      return (main === undefined ? undefined : flushes.get(main)) ?? Effect.void;
    }),
  };
};
