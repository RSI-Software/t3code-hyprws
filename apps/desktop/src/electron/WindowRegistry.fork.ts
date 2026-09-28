import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Semaphore from "effect/Semaphore";
import type * as Electron from "electron";

import type { WindowId } from "../window/WindowId.fork.ts";
import {
  HUB_WINDOW_IDENTITY,
  type WindowIdentity,
  windowIdentityKey,
} from "../window/WindowIdentity.ts";

/**
 * Fork-owned registry of the app windows main created, keyed by `WindowId`.
 *
 * What a window shows (`identity`) is data on its record, never its key; a
 * lookup by identity is a scan. A record leaves the registry when its window
 * closes or is found destroyed, so no caller ever reads a dead window back.
 */
export interface RegisteredWindow {
  readonly windowId: WindowId;
  readonly identity: WindowIdentity;
  readonly window: Electron.BrowserWindow;
}

const makeWindowId = (): WindowId => NodeCrypto.randomUUID() as WindowId;

export function makeWindowRegistry() {
  const entries = new Map<WindowId, RegisteredWindow>();

  const live = (entry: RegisteredWindow | undefined): RegisteredWindow | undefined => {
    if (entry === undefined) return undefined;
    if (!entry.window.isDestroyed()) return entry;
    if (entries.get(entry.windowId) === entry) entries.delete(entry.windowId);
    return undefined;
  };

  const list = (): readonly RegisteredWindow[] =>
    Array.from(entries.values()).filter((entry) => live(entry) !== undefined);

  const findByIdentity = (identity: WindowIdentity): RegisteredWindow | undefined => {
    const key = windowIdentityKey(identity);
    return list().find((entry) => windowIdentityKey(entry.identity) === key);
  };

  const findByWindow = (window: Electron.BrowserWindow): RegisteredWindow | undefined =>
    list().find((entry) => entry.window === window);

  /**
   * The id a new window will be registered under. A requested id (an update
   * restore carrying the previous launch's id) is honoured unless a live
   * window already holds it; otherwise main mints a fresh one.
   */
  const reserveId = (requested?: WindowId): WindowId =>
    requested !== undefined && live(entries.get(requested)) === undefined
      ? requested
      : makeWindowId();

  const register = (
    windowId: WindowId,
    identity: WindowIdentity,
    window: Electron.BrowserWindow,
  ): RegisteredWindow => {
    const entry: RegisteredWindow = { windowId, identity, window };
    entries.set(windowId, entry);
    window.once("closed", () => {
      if (entries.get(windowId) === entry) entries.delete(windowId);
    });
    return entry;
  };

  const remove = (windowId: WindowId) => {
    entries.delete(windowId);
  };

  /**
   * Makes a registered window the one hub window. Only a window main created
   * has an id its preload read, so an unregistered window is not given one.
   */
  const registerMain = (window: Electron.BrowserWindow) => {
    const existing = findByWindow(window);
    if (existing === undefined) return;
    for (const entry of list()) {
      if (entry.identity.kind === "hub" && entry.window !== window) remove(entry.windowId);
    }
    register(existing.windowId, HUB_WINDOW_IDENTITY, window);
  };

  return {
    byId: (windowId: WindowId) => live(entries.get(windowId)),
    get: (identity: WindowIdentity) => Option.fromNullishOr(findByIdentity(identity)?.window),
    findByIdentity,
    findByWindow,
    list,
    reserveId,
    register,
    registerMain,
    remove,
  } as const;
}

export type WindowRegistry = ReturnType<typeof makeWindowRegistry>;

/** The `ElectronWindow` members the fork serves from the registry. */
export interface WindowRegistryService {
  readonly getById: (windowId: WindowId) => Effect.Effect<Option.Option<Electron.BrowserWindow>>;
  /**
   * Returns the window showing `identity`, or creates one. `create` receives
   * the WindowId main minted for it (or the requested one, on an update
   * restore) so the id can ride into the renderer.
   */
  readonly getOrCreate: <E>(
    identity: WindowIdentity,
    create: (windowId: WindowId) => Effect.Effect<Electron.BrowserWindow, E>,
    windowId?: WindowId,
  ) => Effect.Effect<
    {
      readonly window: Electron.BrowserWindow;
      readonly windowId: WindowId;
      readonly created: boolean;
    },
    E
  >;
  readonly close: (identity: WindowIdentity) => Effect.Effect<void>;
  readonly windowIdFor: (window: Electron.BrowserWindow) => Effect.Effect<Option.Option<WindowId>>;
  /** Every live registered window, in registration order. */
  readonly listWindows: Effect.Effect<
    readonly { readonly windowId: WindowId; readonly identity: WindowIdentity }[]
  >;
}

export const makeWindowRegistryService = (
  registry: WindowRegistry,
  semaphore: Semaphore.Semaphore,
  mainWindowRef: Ref.Ref<Option.Option<Electron.BrowserWindow>>,
): WindowRegistryService => ({
  getById: (windowId) => Effect.sync(() => Option.fromNullishOr(registry.byId(windowId)?.window)),
  getOrCreate: (identity, create, requestedId) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const existing = registry.findByIdentity(identity);
        if (existing !== undefined) {
          return { window: existing.window, windowId: existing.windowId, created: false } as const;
        }
        const windowId = registry.reserveId(requestedId);
        const window = yield* create(windowId);
        registry.register(windowId, identity, window);
        if (identity.kind === "hub") {
          yield* Ref.set(mainWindowRef, Option.some(window));
        }
        return { window, windowId, created: true } as const;
      }),
    ),
  close: (identity) =>
    semaphore.withPermits(1)(
      Effect.sync(() => {
        const existing = registry.findByIdentity(identity);
        if (existing === undefined) return;
        registry.remove(existing.windowId);
        existing.window.close();
      }),
    ),
  listWindows: Effect.sync(() =>
    registry.list().map(({ windowId, identity }) => ({ windowId, identity })),
  ),
  windowIdFor: (window) =>
    Effect.sync(() => Option.fromNullishOr(registry.findByWindow(window)?.windowId)),
});
