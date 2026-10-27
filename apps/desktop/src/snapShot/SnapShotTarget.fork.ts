import type { DesktopSnapShotEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import { IpcRequester } from "../electron/WindowTargets.fork.ts";

// The window each capture in flight reports to, by capture id. A capture
// starts from a global shortcut, so it has no sender: it pins the most recent
// app window when it is requested and keeps reporting there until it settles,
// even if another window is focused before it is ready.
const pinned = new Map<string, Electron.BrowserWindow>();

// The capture whose reveal is pending. Captures run one at a time behind the
// snapshot mutex, so only the latest `requested` capture can still reveal a
// window; its `started` event (or, without an animation, its activation)
// reveals the pinned window and closes the phase.
let revealing: string | undefined;

const release = (captureId: string) => {
  pinned.delete(captureId);
  if (revealing === captureId) revealing = undefined;
};

const livePin = (captureId: string): Electron.BrowserWindow | undefined => {
  const window = pinned.get(captureId);
  if (window === undefined || !window.isDestroyed()) return window;
  release(captureId);
  return undefined;
};

/** The window a capture reports to, once `requested` has pinned it. */
export const snapShotCaptureTarget = (captureId: string): Electron.BrowserWindow | undefined =>
  livePin(captureId);

/**
 * Resolves the window a capture reveals or activates: the pinned requester of
 * the capture being acquired, otherwise `fallback`. An app activation during
 * that phase lands on the same window, which the capture is about to reveal.
 */
export const withSnapShotRevealTarget = <E, R>(
  fallback: Effect.Effect<Option.Option<Electron.BrowserWindow>, E, R>,
): Effect.Effect<Option.Option<Electron.BrowserWindow>, E, R> =>
  Effect.suspend(() => {
    const window = revealing === undefined ? undefined : livePin(revealing);
    return window === undefined ? fallback : Effect.succeedSome(window);
  });

/**
 * Ends the reveal phase once the capture has activated its window, so later
 * app activations, while the capture persists outside the snapshot mutex,
 * go back to the most recent window.
 */
export const endSnapShotReveal = Effect.sync(() => {
  revealing = undefined;
});

/**
 * Routes every event of one capture to the window its `requested` event pinned;
 * false means no pin, so the caller's own dispatch applies. The pin is released
 * when the capture settles or its requesting fiber ends.
 */
export const makePinnedSnapShotDispatch =
  <E, R>(
    resolveTarget: Effect.Effect<Option.Option<Electron.BrowserWindow>, E, R>,
    dispatch: (event: DesktopSnapShotEvent) => Effect.Effect<void, E, R>,
  ) =>
  (event: DesktopSnapShotEvent): Effect.Effect<boolean, E, R> =>
    Effect.gen(function* () {
      const captureId = "id" in event ? event.id : undefined;
      if (captureId === undefined) return false;
      if (event.type === "started" && revealing === captureId) revealing = undefined;
      if (event.type === "requested") {
        revealing = captureId;
        const target = yield* resolveTarget;
        if (Option.isSome(target)) {
          pinned.set(captureId, target.value);
          (yield* Effect.fiber).addObserver(() => release(captureId));
        }
      }
      const window = livePin(captureId);
      if (window === undefined) return false;
      yield* dispatch(event).pipe(
        Effect.provideService(IpcRequester, Option.some(window.webContents.id)),
        Effect.ensuring(
          Effect.sync(() => {
            if (event.type === "ready" || event.type === "failed") release(captureId);
          }),
        ),
      );
      return true;
    });
