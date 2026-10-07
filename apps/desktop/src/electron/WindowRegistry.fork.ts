import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Semaphore from "effect/Semaphore";
import type * as Electron from "electron";

import { IpcRequester } from "./WindowTargets.fork.ts";
import { normalizeMainWindowBounds } from "../settings/DesktopAppSettings.ts";
import type { CapturedWindow } from "../window/DesktopWindowSession.ts";
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
 *
 * Only windows main created are registered, so the connecting splash, DevTools
 * and popups are never a request target.
 */
export interface RegisteredWindow {
  readonly windowId: WindowId;
  readonly identity: WindowIdentity;
  readonly window: Electron.BrowserWindow;
}

/**
 * What an update restore needs to reopen `entry`: the hash route it shows and
 * its restorable (never maximized or minimized) bounds. A window that cannot
 * answer reopens at its home with default bounds.
 */
function captureWindow(entry: RegisteredWindow): CapturedWindow {
  const { windowId, identity, window } = entry;
  let route = "/";
  try {
    route = new URL(window.webContents.getURL()).hash.slice(1) || "/";
  } catch {
    // An unloaded or unparsable URL keeps the window's home.
  }
  let bounds: CapturedWindow["bounds"] = null;
  try {
    const current =
      window.isFullScreen() || window.isMaximized() || window.isMinimized()
        ? window.getNormalBounds()
        : window.getBounds();
    bounds = normalizeMainWindowBounds({
      x: Math.round(current.x),
      y: Math.round(current.y),
      width: Math.round(current.width),
      height: Math.round(current.height),
    });
  } catch {
    // Default bounds on reopen.
  }
  return { windowId, identity, route, bounds };
}

/**
 * Mints one `WindowId`. A main process that cannot random is broken beyond
 * window creation, so a crypto failure dies.
 */
const makeWindowId: Effect.Effect<WindowId> = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map((uuid) => uuid as WindowId),
  Effect.provide(NodeCrypto.layer),
  Effect.orDie,
);

export function makeWindowRegistry() {
  const entries = new Map<WindowId, RegisteredWindow>();
  // Recency order for app-wide requests: registering or focusing a window
  // touches it. A window is watched for focus once, however often it re-registers.
  const touchedAt = new Map<WindowId, number>();
  const watchedForFocus = new WeakSet<Electron.BrowserWindow>();
  let clock = 0;

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

  const findByWebContentsId = (webContentsId: number): RegisteredWindow | undefined =>
    list().find((entry) => entry.window.webContents.id === webContentsId);

  const touch = (window: Electron.BrowserWindow) => {
    const entry = findByWindow(window);
    if (entry !== undefined) touchedAt.set(entry.windowId, ++clock);
  };

  /** Live registered windows, most recently focused or registered first. */
  const byRecency = (): RegisteredWindow[] =>
    list().toSorted((a, b) => (touchedAt.get(b.windowId) ?? 0) - (touchedAt.get(a.windowId) ?? 0));

  const mostRecent = (): RegisteredWindow | undefined => byRecency()[0];

  /**
   * The window a request acts on: the requesting renderer's window when it is
   * one main created, otherwise the most recently focused app window.
   */
  const requestTarget = (requester: Option.Option<number>): RegisteredWindow | undefined =>
    (Option.isSome(requester) ? findByWebContentsId(requester.value) : undefined) ?? mostRecent();

  /**
   * The id a new window will be registered under. A requested id (an update
   * restore carrying the previous launch's id) is honoured unless a live
   * window already holds it; otherwise main mints a fresh one.
   */
  const reserveId = (requested?: WindowId): Effect.Effect<WindowId> =>
    requested !== undefined && live(entries.get(requested)) === undefined
      ? Effect.succeed(requested)
      : makeWindowId;

  const register = (
    windowId: WindowId,
    identity: WindowIdentity,
    window: Electron.BrowserWindow,
  ): RegisteredWindow => {
    const entry: RegisteredWindow = { windowId, identity, window };
    entries.set(windowId, entry);
    touchedAt.set(windowId, ++clock);
    window.once("closed", () => {
      if (entries.get(windowId) !== entry) return;
      entries.delete(windowId);
      touchedAt.delete(windowId);
    });
    if (!watchedForFocus.has(window)) {
      watchedForFocus.add(window);
      window.on("focus", () => touch(window));
    }
    return entry;
  };

  const remove = (windowId: WindowId) => {
    entries.delete(windowId);
    touchedAt.delete(windowId);
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
    findByWebContentsId,
    requestTarget,
    byRecency,
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
  /**
   * Always creates a window, even when one already shows `identity`: a New
   * Window request asks for another window, never for the existing one.
   */
  readonly createNew: <E>(
    identity: WindowIdentity,
    create: (windowId: WindowId) => Effect.Effect<Electron.BrowserWindow, E>,
    /** An update restore's previous id, honoured unless a live window holds it. */
    windowId?: WindowId,
  ) => Effect.Effect<{ readonly window: Electron.BrowserWindow; readonly windowId: WindowId }, E>;
  readonly close: (identity: WindowIdentity) => Effect.Effect<void>;
  readonly windowIdFor: (window: Electron.BrowserWindow) => Effect.Effect<Option.Option<WindowId>>;
  /** Every live registered window, in registration order, as an update captures it. */
  readonly listWindows: Effect.Effect<readonly CapturedWindow[]>;
  /**
   * The registered window the current request targets: the IPC sender's own
   * window, else the most recently focused one. None only when main has not
   * registered a window yet.
   */
  readonly requestTarget: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
  /** Every live registered window, most recently focused first. */
  readonly windowsByRecency: Effect.Effect<readonly Electron.BrowserWindow[]>;
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
        const windowId = yield* registry.reserveId(requestedId);
        const window = yield* create(windowId);
        registry.register(windowId, identity, window);
        if (identity.kind === "hub") {
          yield* Ref.set(mainWindowRef, Option.some(window));
        }
        return { window, windowId, created: true } as const;
      }),
    ),
  createNew: (identity, create, requestedId) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const windowId = yield* registry.reserveId(requestedId);
        const window = yield* create(windowId);
        registry.register(windowId, identity, window);
        return { window, windowId } as const;
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
  listWindows: Effect.sync(() => registry.list().map(captureWindow)),
  windowIdFor: (window) =>
    Effect.sync(() => Option.fromNullishOr(registry.findByWindow(window)?.windowId)),
  requestTarget: Effect.gen(function* () {
    const requester = yield* IpcRequester;
    return Option.fromNullishOr(registry.requestTarget(requester)?.window);
  }),
  windowsByRecency: Effect.sync(() => registry.byRecency().map((entry) => entry.window)),
});
