import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import type { WindowId } from "./WindowId.fork.ts";

/** The id a test registry mints for the nth window it creates. */
export const testWindowId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as WindowId;

/**
 * A stand-in for main's window registry in `ElectronWindow` fakes: every
 * created window gets a WindowId, and a requested (restored) id is honoured.
 */
export function makeTestWindowIds() {
  const ids = new Map<Electron.BrowserWindow, WindowId>();
  let minted = 0;
  const idOf = (window: Electron.BrowserWindow) => ids.get(window) ?? testWindowId(0);

  return {
    create: <E>(
      create: (windowId: WindowId) => Effect.Effect<Electron.BrowserWindow, E>,
      requestedId?: WindowId,
    ) => {
      const windowId = requestedId ?? testWindowId((minted += 1));
      return create(windowId).pipe(
        Effect.tap((window) => Effect.sync(() => void ids.set(window, windowId))),
      );
    },
    created: (window: Electron.BrowserWindow) => ({
      window,
      windowId: idOf(window),
      created: true as boolean,
    }),
    existing: (window: Electron.BrowserWindow) =>
      Effect.succeed({ window, windowId: idOf(window), created: false as boolean }),
    getById: (windowId: WindowId) =>
      Effect.sync(() =>
        Option.fromNullishOr([...ids].find(([, candidate]) => candidate === windowId)?.[0]),
      ),
    windowIdFor: (window: Electron.BrowserWindow) =>
      Effect.sync(() => Option.fromNullishOr(ids.get(window))),
  };
}
