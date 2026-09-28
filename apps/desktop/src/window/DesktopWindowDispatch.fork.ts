import type { ScopedProjectRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import type * as ElectronWindow from "../electron/ElectronWindow.ts";
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

/** The saved main-window bounds, for the primary window only. */
export const primaryWindowBoundsFork = <B>(primary: boolean, bounds: B | null): B | null =>
  primary ? bounds : null;

/**
 * The renderer URL a dispatched window opens at: its requested route on the
 * same origin, or the identity's own URL when the window was not dispatched.
 */
export const dispatchedWindowUrlFork = (
  identityUrl: string,
  dispatched: WindowCreateRequest | undefined,
): string => {
  if (dispatched === undefined) return identityUrl;
  const url = new URL(identityUrl);
  url.hash = dispatched.route === NEW_WINDOW_ROUTE ? "" : dispatched.route;
  return url.href;
};

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
