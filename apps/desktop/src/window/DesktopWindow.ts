import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Electron from "electron";

import { type DesktopSnapShotEvent, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  MENU_ACTION_CHANNEL,
  QUIT_SHORTCUT_CHANNEL,
  SNAP_SHOT_EVENT_CHANNEL,
  TRACKPAD_SCROLL_END_CHANNEL,
  WINDOW_FULLSCREEN_STATE_CHANNEL,
} from "../ipc/channels.ts";
import { PASSKEY_BRIDGE_ARGUMENT } from "../preview/GuestProtocol.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import {
  makePinnedSnapShotDispatch,
  endSnapShotReveal,
  withSnapShotRevealTarget,
} from "../snapShot/SnapShotTarget.fork.ts"; // fork-hook: multi-window/window-targets-snap-shot-import
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import { makeStartupDrain, makeStartupDrainOpeners } from "./DesktopStartupDrain.fork.ts"; // fork-hook: multi-window/startup-drain-import
import * as DesktopWindowSession from "./DesktopWindowSession.ts"; // fork-hook: multi-window/window-session-import
import { HyprlandPlacement } from "./HyprlandPlacement.ts"; // fork-hook: multi-window/hyprland-placement-import
import type { WindowId } from "./WindowId.fork.ts"; // fork-hook: multi-window/window-id-import
import {
  HUB_WINDOW_IDENTITY,
  type WindowIdentity,
  windowPreloadArguments,
} from "./WindowIdentity.ts"; // fork-hook: multi-window/window-identity-import
import { makeQuitShortcutHandler } from "./QuitHold.ts";
import { copyContextMenuImage } from "./ContextMenuImage.ts";
import * as WindowDispatch from "./DesktopWindowDispatch.fork.ts"; // fork-hook: multi-window/dispatch-import
import * as WindowPlacement from "./WindowPlacement.fork.ts"; // fork-hook: multi-window/placement-import
import { hubFilterTitleFork } from "@t3tools/shared/windowTitle.fork"; // fork-hook: workspaces/window-title-import
import { bindWindowDemandStateFork } from "./WindowDemandState.fork.ts"; // fork-hook: zmux-estate/window-demand-state-import
import { trimAppContextMenuFork } from "./AppContextMenu.fork.ts"; // fork-hook: upstream-fixes/themed-context-menu-import
import {
  resolveLaunchRequest,
  type WindowCreateRequest,
  type WindowRequest,
} from "./WindowDispatch.fork.ts"; // fork-hook: multi-window/dispatch-type-import

const TITLEBAR_HEIGHT = 40;
// Matches --workspace-topbar-height in apps/web/src/index.css. Native macOS
// buttons are 14 points tall and do not scale with the renderer's zoom.
const MACOS_WORKSPACE_TOPBAR_HEIGHT = 52;
const MACOS_WINDOW_BUTTON_RADIUS = 7;

function syncMacosWindowButtons(window: Electron.BrowserWindow): void {
  if (window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition({
    x: 16,
    y: Math.round(
      (MACOS_WORKSPACE_TOPBAR_HEIGHT * window.webContents.getZoomFactor()) / 2 -
        MACOS_WINDOW_BUTTON_RADIUS,
    ),
  });
}

const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";
const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;
const DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES = new Set([-2, -7, -9, -102, -105, -106, -118]);

type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopState.DesktopState
  | DesktopAssets.DesktopAssets
  | DesktopAppSettings.DesktopAppSettings
  | DesktopClientSettings.DesktopClientSettings
  | ElectronApp.ElectronApp
  | ElectronMenu.ElectronMenu
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow
  | DesktopRendererHistory.DesktopRendererHistory
  | PreviewManager.PreviewManager;

export type DesktopWindowError =
  | ElectronWindow.ElectronWindowCreateError
  | PreviewManager.PreviewManagerError;

export type MainWindowZoomDirection = "in" | "out" | "reset";
export type MainWindowContentsCommand = "reload" | "forceReload" | "toggleDevTools";

export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    readonly createMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly ensureMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly revealOrCreateMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly requestWindow: (request: WindowRequest) => Effect.Effect<void, DesktopWindowError>; // fork-hook: multi-window/dispatch-request
    readonly openArguments: (argv: readonly string[]) => Effect.Effect<void, DesktopWindowError>; // fork-hook: multi-window/open-arguments-type
    readonly restoreWindowSession: Effect.Effect<void>; // fork-hook: multi-window/restore-window-session-type
    readonly closeIdentity: (identity: WindowIdentity) => Effect.Effect<void>; // fork-hook: multi-window/close-identity-type
    readonly activate: Effect.Effect<void, DesktopWindowError>;
    readonly createMainIfBackendReady: Effect.Effect<void, DesktopWindowError>;
    readonly showConnectingSplash: Effect.Effect<void>;
    readonly handleRendererReady: Effect.Effect<void, DesktopWindowError>; // fork-hook: backend-attach/renderer-ready-type
    readonly handleBackendReady: (httpBaseUrl: URL) => Effect.Effect<void, DesktopWindowError>;
    readonly handleBackendNotReady: Effect.Effect<void>;
    readonly flushMainWindowBounds: Effect.Effect<void>;
    readonly prepareCaptureReveal: Effect.Effect<void>;
    readonly dispatchMenuAction: (
      action: string,
      options?: { readonly reveal?: boolean },
    ) => Effect.Effect<void, DesktopWindowError>;
    readonly dispatchSnapShotEvent: (
      event: DesktopSnapShotEvent,
    ) => Effect.Effect<void, DesktopWindowError>;
    // The Electron `zoomIn`/`zoomOut` menu roles act on whichever webContents
    // has keyboard focus, so with an embedded preview WebContentsView (or
    // DevTools) focused they zoom the guest page instead of the app UI.
    readonly zoomMain: (direction: MainWindowZoomDirection) => Effect.Effect<void>;
    readonly runMainContentsCommand: (command: MainWindowContentsCommand) => Effect.Effect<void>;
    readonly syncAppearance: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopWindow") {}

const { logInfo: logWindowInfo, logWarning: logWindowWarning } =
  makeComponentLogger("desktop-window");

function getIconOption(
  iconPaths: DesktopAssets.DesktopIconPaths,
  platform: NodeJS.Platform,
): { icon: string } | Record<string, never> {
  if (platform === "darwin") return {};
  const ext = platform === "win32" ? "ico" : "png";
  return Option.match(iconPaths[ext], {
    onNone: () => ({}),
    onSome: (icon) => ({ icon }),
  });
}

function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

type DisplayBounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

function windowFitsWithinDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): boolean {
  return (
    windowBounds.x >= displayBounds.x &&
    windowBounds.y >= displayBounds.y &&
    windowBounds.x + windowBounds.width <= displayBounds.x + displayBounds.width &&
    windowBounds.y + windowBounds.height <= displayBounds.y + displayBounds.height
  );
}

function windowBoundsEqual(
  left: DesktopAppSettings.DesktopWindowBounds,
  right: DesktopAppSettings.DesktopWindowBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function resolveInitialMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
): DesktopAppSettings.DesktopWindowBounds | typeof DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE {
  if (
    persistedBounds !== null &&
    displays.some((display) => windowFitsWithinDisplay(persistedBounds, display))
  ) {
    return persistedBounds;
  }
  return DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE;
}

function buildConnectingSplashDataUrl(shouldUseDarkColors: boolean): string {
  const background = getInitialWindowBackgroundColor(shouldUseDarkColors);
  const label = shouldUseDarkColors ? "#9ca3af" : "#6b7280";
  const accent = shouldUseDarkColors ? "#f8fafc" : "#1f2937";
  const track = shouldUseDarkColors ? "rgba(248,250,252,0.18)" : "rgba(31,41,55,0.18)";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%}body{background:${background};color:${label};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}.spinner{width:26px;height:26px;border:3px solid ${track};border-top-color:${accent};border-radius:50%;animation:spin .8s linear infinite}.label{font-size:13px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="spinner"></div><div class="label">Connecting to WSL…</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function isSameOriginRendererNavigation(input: {
  readonly applicationUrl: string;
  readonly navigationUrl: string;
}): boolean {
  try {
    return new URL(input.applicationUrl).origin === new URL(input.navigationUrl).origin;
  } catch {
    return false;
  }
}

function isRetryableDevelopmentRendererLoadFailure(input: {
  readonly applicationUrl: string;
  readonly errorCode: number;
  readonly isMainFrame: boolean;
  readonly validatedUrl: string;
}): boolean {
  return (
    input.isMainFrame &&
    DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES.has(input.errorCode) &&
    isSameOriginRendererNavigation({
      applicationUrl: input.applicationUrl,
      navigationUrl: input.validatedUrl,
    })
  );
}

function concealPendingQuitWindow(
  window: Pick<
    Electron.BrowserWindow,
    "isDestroyed" | "isFullScreen" | "setFullScreen" | "setOpacity"
  >,
): void {
  if (window.isDestroyed()) return;
  if (window.isFullScreen()) {
    window.setFullScreen(false);
  }
  // Electron implements window opacity on macOS and Windows. Linux keeps the
  // release-gated quit behavior but cannot make the pending window disappear.
  window.setOpacity(0);
}

function getWindowTitleBarOptions(
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): WindowTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {
        x: 16,
        y: MACOS_WORKSPACE_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
      },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncWindowAppearance(
  window: Electron.BrowserWindow,
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(getInitialWindowBackgroundColor(shouldUseDarkColors));
    const { titleBarOverlay } = getWindowTitleBarOptions(shouldUseDarkColors, platform);
    if (typeof titleBarOverlay === "object") {
      window.setTitleBarOverlay(titleBarOverlay);
    }
  });
}

type RevealSubscription = (listener: () => void) => void;

function bindFirstRevealTrigger(
  subscribers: readonly RevealSubscription[],
  reveal: () => void,
): void {
  let revealed = false;
  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };
  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const previewManager = yield* PreviewManager.PreviewManager;
  const previewPasskeys = yield* PreviewPasskeys.PreviewPasskeys;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronApp = yield* ElectronApp.ElectronApp;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  const hyprlandPlacement = yield* HyprlandPlacement; // fork-hook: multi-window/hyprland-placement
  const titleClaimsFork = WindowPlacement.makeTitleClaimsFork(); // fork-hook: multi-window/claim-title-gate
  const windowSession = yield* DesktopWindowSession.DesktopWindowSession; // fork-hook: multi-window/window-session
  const backendReadyRef = yield* Ref.make(false);
  const startupDrain = yield* makeStartupDrain; // fork-hook: multi-window/startup-drain-state
  const splashWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  let flushMainWindowBounds: Effect.Effect<void> = Effect.void;

  const dismissConnectingSplash = Effect.gen(function* () {
    const splash = yield* Ref.getAndSet(splashWindowRef, Option.none());
    if (Option.isSome(splash) && !splash.value.isDestroyed()) {
      splash.value.close();
    }
  });

  // currentMainOrFirst / focusedMainOrFirst fall back to "any first window",
  // which during WSL-only boot is the connecting splash. The splash is never
  // registered via setMain, so it must be treated as "no real main window" --
  // otherwise ensureMain/activate/dispatchMenuAction latch onto it and never
  // open (or retry) the real main.
  const withoutSplash = (window: Option.Option<Electron.BrowserWindow>) =>
    Ref.get(splashWindowRef).pipe(
      Effect.map((splash) =>
        Option.isSome(splash) && Option.isSome(window) && window.value === splash.value
          ? Option.none<Electron.BrowserWindow>()
          : window,
      ),
    );

  const currentMainWindow = electronWindow
    .get(HUB_WINDOW_IDENTITY)
    .pipe(Effect.flatMap(withoutSplash));
  const currentMainBoundsFork = WindowDispatch.makeCurrentMainBoundsFork(() =>
    Effect.runSyncWith(context)(currentMainWindow),
  ); // fork-hook: multi-window/bounds-current-main
  const focusedMainWindow = electronWindow.focusedMainOrFirst.pipe(Effect.flatMap(withoutSplash));
  const requestTargetWindow = electronWindow.currentMainOrFirst.pipe(Effect.flatMap(withoutSplash)); // fork-hook: multi-window/window-targets-request-target
  const captureRevealWindow = withSnapShotRevealTarget(requestTargetWindow); // fork-hook: multi-window/window-targets-capture-reveal-target

  const preserveGuestZoomsFork = yield* WindowDispatch.makeWindowGuestZoomsFork; // fork-hook: multi-window/window-zoom-factory
  const zoomWindow = Effect.fn("desktop.window.zoomWindow")(function* (
    window: Electron.BrowserWindow,
    direction: MainWindowZoomDirection,
  ) {
    const webContents = window.webContents;
    yield* preserveGuestZoomsFork(window, () => {
      webContents.setZoomLevel(
        direction === "reset" ? 0 : webContents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5),
      );
    }); // fork-hook: multi-window/window-id-zoom
    if (environment.platform === "darwin") syncMacosWindowButtons(window);
  });

  const createWindow = Effect.fn("desktop.window.createWindow")(function* (): Effect.fn.Return<
    Option.Option<Electron.BrowserWindow>,
    DesktopWindowError
  > {
    const { identity, windowId, dispatched } = yield* WindowDispatch.requireWindowCreateTargetFork; // fork-hook: multi-window/create-target
    if (yield* Ref.get(desktopState.quitting)) return Option.none();
    if (identity.kind === "hub") yield* previewManager.getBrowserSession(); // fork-hook: multi-window/hub-preview-session
    const applicationUrl = getDesktopUrl(environment.isDevelopment);
    const dispatchedUrlFork = WindowDispatch.dispatchedWindowUrlFork(applicationUrl, dispatched); // fork-hook: multi-window/dispatch-url
    const normalWindowTitle =
      identity.kind === "hub" ? environment.displayName : identity.ref.projectId; // fork-hook: multi-window/placement-title
    const mapPlacementFork = WindowPlacement.resolveMapPlacementFork({
      hyprlandAvailable: hyprlandPlacement.isAvailable,
      windowId,
      restoredWorkspace: dispatched?.restored?.workspace,
    }); // fork-hook: multi-window/placement-resolve
    const claimTitleFork = WindowPlacement.reserveClaimTitleFork({
      hyprlandAvailable: hyprlandPlacement.isAvailable,
      windowId,
      placement: mapPlacementFork,
      titleClaims: titleClaimsFork,
    }); // fork-hook: multi-window/claim-title
    const initialWindowTitle = mapPlacementFork?.title ?? claimTitleFork ?? normalWindowTitle; // fork-hook: multi-window/placement-title
    const iconPaths = yield* assets.iconPaths;
    const iconOption = getIconOption(iconPaths, environment.platform);
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const persistedSettings = yield* desktopSettings.get;
    const persistedBounds = WindowDispatch.initialWindowBoundsFork(
      identity,
      dispatched,
      persistedSettings.mainWindowBounds,
    ); // fork-hook: multi-window/restore-initial-bounds
    const displayBoundsResult = yield* Effect.sync(() => {
      try {
        return {
          _tag: "Success" as const,
          bounds: Electron.screen.getAllDisplays().map((display) => display.bounds),
        };
      } catch (cause) {
        return { _tag: "Failure" as const, cause };
      }
    });
    const displayBounds =
      displayBoundsResult._tag === "Success"
        ? displayBoundsResult.bounds
        : yield* logWindowWarning("failed to read connected displays; using defaults", {
            cause: displayBoundsResult.cause,
          }).pipe(Effect.as<readonly Electron.Rectangle[]>([]));
    const initialBounds = resolveInitialMainWindowBounds(persistedBounds, displayBounds);
    const restoredPersistedBounds = persistedBounds !== null && initialBounds === persistedBounds;
    if (persistedBounds !== null && initialBounds === DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE) {
      yield* logWindowWarning("saved main window bounds could not be restored; using defaults");
    }
    if (yield* Ref.get(desktopState.quitting)) return Option.none();
    const window = yield* electronWindow.create({
      ...initialBounds,
      minWidth: 840,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      ...(environment.platform === "darwin" ? { disableAutoHideCursor: true } : {}),
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      ...iconOption,
      title: environment.displayName,
      ...WindowPlacement.titleOptionFork(initialWindowTitle), // fork-hook: multi-window/placement-title
      ...getWindowTitleBarOptions(shouldUseDarkColors, environment.platform),
      webPreferences: {
        preload: environment.preloadPath,
        additionalArguments: windowPreloadArguments(windowId, dispatched?.seed), // fork-hook: multi-window/window-id-preload-argument
        // Chromium throttles hidden renderers: timers coalesce and rAF stops,
        // which stalls first paint. Boot unthrottled; the first-reveal trigger
        // re-enables throttling so a hidden or minimized window goes back to
        // being cheap after it has been shown once.
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
        // A preview guest's fullscreen request is mirrored onto this embedder,
        // which would otherwise put the whole window into OS fullscreen. With
        // both sides opted out the page fills its webview and the window stays.
        disableHtmlFullscreenWindowResize: true,
      },
    });
    if (yield* Ref.get(desktopState.quitting)) {
      yield* electronWindow.destroyAll;
      return Option.none();
    }

    yield* rendererHistory.register(window.webContents, { surface: "main" });
    if (environment.platform === "darwin") {
      window.setAutoHideCursor(false);
    }
    WindowPlacement.retitleWindowFork(window, environment.displayName, (pageTitle) =>
      identity.kind === "hub" ? null : pageTitle.trim() || null,
    ); // fork-hook: multi-window/project-title
    WindowPlacement.retitleWindowFork(window, environment.displayName, (pageTitle) =>
      hubFilterTitleFork(identity.kind, environment.displayName, pageTitle),
    ); // fork-hook: workspaces/window-title
    const titleHoldFork =
      mapPlacementFork === null && claimTitleFork === null
        ? null
        : WindowPlacement.holdWindowTitleFork(window, initialWindowTitle, normalWindowTitle); // fork-hook: multi-window/placement-title-hold
    const knownAddressesFork = runPromise(hyprlandPlacement.snapshotAddresses); // fork-hook: multi-window/claim-baseline
    let boundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let pendingBoundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let boundsPersistenceEnabled = persistedBounds === null || restoredPersistedBounds;
    const readPersistableBounds = (): DesktopAppSettings.DesktopWindowBounds | null => {
      if (window.isDestroyed()) {
        return null;
      }
      const bounds =
        window.isFullScreen() || window.isMaximized() || window.isMinimized()
          ? window.getNormalBounds()
          : window.getBounds();
      return DesktopAppSettings.normalizeMainWindowBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };
    const fallbackWindowBounds = boundsPersistenceEnabled ? null : readPersistableBounds();
    const fallbackWindowMaximized = persistedSettings.mainWindowMaximized;
    const persistCurrentBounds = (): Fiber.Fiber<void, never> | undefined => {
      if (!boundsPersistenceEnabled) {
        return pendingBoundsPersistFiber;
      }
      if (!currentMainBoundsFork.isCurrentMain(window)) return pendingBoundsPersistFiber; // fork-hook: multi-window/bounds-current-main
      const bounds = readPersistableBounds();
      if (bounds === null) {
        return pendingBoundsPersistFiber;
      }
      pendingBoundsPersistFiber = runFork(
        desktopSettings.setMainWindowBounds(bounds, window.isMaximized()).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            logWindowWarning("failed to persist main window bounds", {
              message: error.message,
            }),
          ),
        ),
      );
      return pendingBoundsPersistFiber;
    };
    const scheduleBoundsPersist = () => {
      if (!boundsPersistenceEnabled) {
        const currentBounds = readPersistableBounds();
        if (
          currentBounds === null ||
          (fallbackWindowBounds !== null &&
            windowBoundsEqual(currentBounds, fallbackWindowBounds) &&
            window.isMaximized() === fallbackWindowMaximized)
        ) {
          return;
        }
      }
      boundsPersistenceEnabled = true;
      if (boundsPersistFiber !== undefined) {
        const fiber = boundsPersistFiber;
        boundsPersistFiber = undefined;
        runFork(Fiber.interrupt(fiber));
      }
      boundsPersistFiber = runFork(
        Effect.sleep(MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              boundsPersistFiber = undefined;
              void persistCurrentBounds();
            }),
          ),
        ),
      );
    };
    const clearBoundsPersist = () => {
      if (boundsPersistFiber === undefined) {
        return;
      }
      const fiber = boundsPersistFiber;
      boundsPersistFiber = undefined;
      runFork(Fiber.interrupt(fiber));
    };
    const flushBoundsPersist = Effect.sync(() => {
      clearBoundsPersist();
      return persistCurrentBounds();
    }).pipe(
      Effect.flatMap((fiber) =>
        fiber === undefined ? Effect.void : Fiber.join(fiber).pipe(Effect.asVoid),
      ),
    );
    flushMainWindowBounds = flushBoundsPersist;
    flushMainWindowBounds = currentMainBoundsFork.flush; // fork-hook: multi-window/bounds-current-main
    if (identity.kind === "hub") currentMainBoundsFork.track(window, flushBoundsPersist); // fork-hook: multi-window/bounds-current-main

    yield* previewManager.setWindow(windowId, window); // fork-hook: multi-window/window-id-preview-owner
    if (yield* Ref.get(desktopState.quitting)) {
      yield* electronWindow.destroyAll;
      return Option.none();
    }
    window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      if (
        typeof params.partition !== "string" ||
        !previewManager.isBrowserPartition(params.partition)
      ) {
        event.preventDefault();
        return;
      }
      webPreferences.sandbox = true;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = false;
      webPreferences.disableHtmlFullscreenWindowResize = true;
      if (previewPasskeys.bridgeEnabled) {
        webPreferences.additionalArguments = [
          ...(webPreferences.additionalArguments ?? []),
          PASSKEY_BRIDGE_ARGUMENT,
        ];
      }
    });

    const contextMenuContents = new WeakSet<Electron.WebContents>();
    const installContextMenu = (
      ownerWindow: Electron.BrowserWindow,
      contents: Electron.WebContents,
    ): void => {
      if (contextMenuContents.has(contents)) return;
      contextMenuContents.add(contents);
      contents.on("context-menu", (event, params) => {
        event.preventDefault();
        if (contents.isDestroyed() || ownerWindow.isDestroyed()) return;
        // Native editing roles act on the focused contents, which may still be
        // the host renderer when the user right-clicks inside a browser guest.
        contents.focus();

        const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

        if (params.misspelledWord) {
          for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
            menuTemplate.push({
              label: suggestion,
              click: () => {
                if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion);
              },
            });
          }
          if (params.dictionarySuggestions.length === 0) {
            menuTemplate.push({ label: "No suggestions", enabled: false });
          }
          menuTemplate.push({ type: "separator" });
        }

        if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
          menuTemplate.push(
            {
              label: "Copy Link",
              click: () => {
                void runPromise(electronShell.copyText(params.linkURL));
              },
            },
            { type: "separator" },
          );
        }

        if (params.mediaType === "image") {
          menuTemplate.push({
            label: "Copy Image",
            click: () => {
              void runPromise(
                Effect.tryPromise(() => copyContextMenuImage(contents, params)).pipe(
                  Effect.catch(() => logWindowWarning("failed to copy context-menu image")),
                ),
              );
            },
          });
          menuTemplate.push({ type: "separator" });
        }

        menuTemplate.push(
          { role: "cut", enabled: params.editFlags.canCut },
          { role: "copy", enabled: params.editFlags.canCopy },
          { role: "paste", enabled: params.editFlags.canPaste },
          { role: "selectAll", enabled: params.editFlags.canSelectAll },
        );
        if (!trimAppContextMenuFork(menuTemplate, params, contents === window.webContents)) return; // fork-hook: upstream-fixes/themed-context-menu

        void runPromise(
          electronMenu.popupTemplate({
            window: ownerWindow,
            template: menuTemplate,
            ...(params.frame ? { frame: params.frame } : {}),
          }),
        );
      });
      contents.on("did-create-window", (popup) => {
        installContextMenu(popup, popup.webContents);
      });
    };
    installContextMenu(window, window.webContents);
    window.webContents.on("did-attach-webview", (_event, contents) => {
      installContextMenu(window, contents);
      void runPromise(previewManager.prepareWebview(contents));
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (
        isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: url,
        })
      ) {
        return;
      }

      event.preventDefault();
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
    });

    // Electron's windowMenu close role owns CmdOrCtrl+W. Holding the
    // close-terminal shortcut can outlive the terminal that handled its first
    // press, so reject repeats before they reach the native window accelerator.
    const quitShortcutHandler = makeQuitShortcutHandler({
      platform: environment.platform,
      getMode: () =>
        runPromise(
          Effect.map(
            clientSettings.get,
            Option.match({
              onNone: () => DEFAULT_CLIENT_SETTINGS.confirmQuit,
              onSome: (settings) => settings.confirmQuit,
            }),
          ),
        ),
      notify: (hint) => {
        if (!window.isDestroyed()) {
          window.webContents.send(QUIT_SHORTCUT_CHANNEL, hint);
        }
      },
      // Keep the transparent window focused until the physical shortcut is
      // released so its remaining repeats cannot reach the next app.
      concealWindow: () => concealPendingQuitWindow(window),
      quit: () => {
        void runPromise(electronApp.quit);
      },
    });
    window.webContents.on("before-input-event", (event, input) => {
      quitShortcutHandler(event, input);
      if (input.type !== "keyDown" || !input.isAutoRepeat) return;
      const modifier = environment.platform === "darwin" ? input.meta : input.control;
      if (modifier && !input.alt && !input.shift && input.key.toLowerCase() === "w") {
        event.preventDefault();
      }
    });
    window.webContents.on("input-event", (_event, input) => {
      if (input.type === "gestureScrollEnd") window.webContents.send(TRACKPAD_SCROLL_END_CHANNEL);
    });
    // Ctrl+wheel never reaches the menu accelerators: Chromium reports it here
    // and leaves applying the zoom to the app. A preview guest under the
    // pointer emits this on its own webContents and keeps its own zoom.
    window.webContents.on("zoom-changed", (_event, direction) => {
      if (window.isDestroyed()) return;
      runFork(zoomWindow(window, direction));
    });

    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(environment.displayName);
    });
    const publishWindowDemandStateFork = bindWindowDemandStateFork(window); // fork-hook: zmux-estate/window-demand-state
    window.on("resize", scheduleBoundsPersist);
    window.on("move", scheduleBoundsPersist);
    window.on("maximize", scheduleBoundsPersist);
    window.on("unmaximize", scheduleBoundsPersist);
    window.on("close", () => {
      runFork(flushBoundsPersist);
    });

    if (environment.platform === "darwin") {
      window.on("enter-full-screen", () => {
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, true);
      });
      window.on("leave-full-screen", () => {
        syncMacosWindowButtons(window);
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, false);
      });
    }

    let developmentLoadRetryIndex = 0;
    let developmentLoadRetryFiber: Fiber.Fiber<void, never> | undefined;
    let rendererRecoveryTimestamps: number[] = [];
    const clearDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber === undefined) {
        return;
      }
      const retryFiber = developmentLoadRetryFiber;
      developmentLoadRetryFiber = undefined;
      runFork(Fiber.interrupt(retryFiber));
    };
    const loadApplication = () => {
      if (window.isDestroyed()) {
        return;
      }
      if (dispatchedUrlFork !== applicationUrl)
        return void window.loadURL(dispatchedUrlFork).catch(() => undefined); // fork-hook: multi-window/dispatch-url
      void window.loadURL(applicationUrl).catch(() => undefined);
    };
    const scheduleDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber !== undefined || window.isDestroyed()) {
        return undefined;
      }

      const retryIndex = Math.min(
        developmentLoadRetryIndex,
        DEVELOPMENT_LOAD_RETRY_DELAYS_MS.length - 1,
      );
      const retryInMs = DEVELOPMENT_LOAD_RETRY_DELAYS_MS[retryIndex] ?? 2_000;
      developmentLoadRetryIndex += 1;
      developmentLoadRetryFiber = runFork(
        Effect.sleep(retryInMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              developmentLoadRetryFiber = undefined;
              if (!window.isDestroyed()) {
                loadApplication();
              }
            }),
          ),
        ),
      );
      return retryInMs;
    };

    window.webContents.on("did-finish-load", () => {
      if (
        environment.isDevelopment &&
        !isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: window.webContents.getURL(),
        })
      ) {
        return;
      }
      clearDevelopmentLoadRetry();
      developmentLoadRetryIndex = 0;
      publishWindowDemandStateFork(); // fork-hook: zmux-estate/window-demand-state
      window.setTitle(environment.displayName);
      if (environment.platform === "darwin") syncMacosWindowButtons(window);
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        const retryInMs =
          environment.isDevelopment &&
          isRetryableDevelopmentRendererLoadFailure({
            applicationUrl,
            errorCode,
            isMainFrame,
            validatedUrl: validatedURL,
          })
            ? scheduleDevelopmentLoadRetry()
            : undefined;
        void runPromise(
          logWindowWarning("main window failed to load", {
            errorCode,
            errorDescription,
            url: validatedURL,
            ...(retryInMs === undefined ? {} : { retryInMs }),
          }),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      const recoverable =
        details.reason === "crashed" ||
        details.reason === "oom" ||
        details.reason === "killed" ||
        details.reason === "abnormal-exit";
      // Recovery attempts are bounded so a renderer that dies immediately on
      // boot cannot reload-loop forever.

      runFork(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          rendererRecoveryTimestamps = rendererRecoveryTimestamps.filter(
            (timestamp) => now - timestamp < RENDERER_RECOVERY_WINDOW_MS,
          );
          const shouldRecover =
            recoverable &&
            !window.isDestroyed() &&
            rendererRecoveryTimestamps.length < RENDERER_RECOVERY_MAX_ATTEMPTS;
          yield* logWindowWarning("main window render process gone", {
            reason: details.reason,
            exitCode: details.exitCode,
            recovering: shouldRecover,
          });
          if (!shouldRecover) {
            return;
          }
          rendererRecoveryTimestamps.push(now);
          yield* Effect.sleep(RENDERER_RECOVERY_RELOAD_DELAY_MS);
          if (!window.isDestroyed()) {
            loadApplication();
          }
        }),
      );
    });

    const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];
    if (environment.platform === "linux") {
      revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
    }
    bindFirstRevealTrigger(revealSubscribers, () => {
      if (!window.isDestroyed()) {
        window.webContents.setBackgroundThrottling(true);
      }
      const mapFork =
        mapPlacementFork === null || titleHoldFork === null
          ? null
          : WindowPlacement.placeAtMapFork({
              hyprlandPlacement,
              window,
              windowId,
              placement: mapPlacementFork,
              titleHold: titleHoldFork,
              maximize: persistedSettings.mainWindowMaximized, // fork-hook: multi-window/placement-maximize
              dismissSplash: dismissConnectingSplash,
            }); // fork-hook: multi-window/placement-map-effect
      if (mapFork !== null) return void runPromise(mapFork); // fork-hook: multi-window/placement-map
      if (persistedSettings.mainWindowMaximized) {
        window.maximize();
      }
      void runPromise(Effect.andThen(electronWindow.reveal(window), dismissConnectingSplash));
      void runPromise(
        // The compositor maps the window a beat after it is shown, so bind it to
        // its Hyprland client now while the title is still the one it mapped with.
        WindowPlacement.claimShownFork({
          hyprlandPlacement,
          windowId,
          title: window.getTitle(),
          knownAddresses: knownAddressesFork,
          titleHold: titleHoldFork, // fork-hook: multi-window/claim-title-hold
          titleClaims: titleClaimsFork, // fork-hook: multi-window/claim-title-release
        }),
      ); // fork-hook: multi-window/window-id-claim
    });

    loadApplication();
    if (environment.isDevelopment && environment.devToolsEnabled) {
      window.webContents.openDevTools({ mode: "detach" });
    }

    window.on("closed", () => {
      clearDevelopmentLoadRetry();
      clearBoundsPersist();
      void runPromise(hyprlandPlacement.forget(windowId)); // fork-hook: multi-window/window-id-forget
      titleClaimsFork.release(windowId); // fork-hook: multi-window/claim-title-closed
      currentMainBoundsFork.untrack(window); // fork-hook: multi-window/bounds-current-main
      void runPromise(electronWindow.clearMain(Option.some(window)));
    });

    return Option.some(window);
  });

  const requireWindow = (window: Option.Option<Electron.BrowserWindow>) =>
    Option.match(window, {
      onNone: () => Effect.interrupt,
      onSome: Effect.succeed,
    });
  const createWindowOrInterrupt = (
    identity: WindowIdentity,
    windowId: WindowId,
    dispatched: WindowCreateRequest,
  ) =>
    createWindow().pipe(
      WindowDispatch.withWindowCreateTargetFork({ identity, windowId, dispatched }),
      Effect.flatMap(requireWindow),
    ); // fork-hook: multi-window/quit-create-or-interrupt

  const ensureIdentity = yield* WindowDispatch.makeEnsureIdentityFork(createWindow); // fork-hook: multi-window/ensure-identity

  const revealOrCreateIdentity = Effect.fn("desktop.window.revealOrCreateIdentity")(function* (
    identity: WindowIdentity,
  ) {
    const window = yield* ensureIdentity(identity).pipe(
      Effect.map(Option.map((ensured) => ensured.window)),
      Effect.flatMap(requireWindow),
    ); // fork-hook: multi-window/window-id-reveal
    yield* electronWindow.reveal(window);
    return window;
  }); // fork-hook: multi-window/reveal-or-create-identity

  const createMain = ensureIdentity(HUB_WINDOW_IDENTITY).pipe(
    Effect.map(Option.map(({ window }) => window)), // fork-hook: multi-window/window-id-create-main
    Effect.withSpan("desktop.window.createMain"),
  );
  const ensureMain = ensureIdentity(HUB_WINDOW_IDENTITY).pipe(
    Effect.map(Option.map(({ window }) => window)), // fork-hook: multi-window/window-id-ensure-main
    Effect.withSpan("desktop.window.ensureMain"),
  );
  const revealOrCreateMain = revealOrCreateIdentity(HUB_WINDOW_IDENTITY).pipe(
    Effect.withSpan("desktop.window.revealOrCreateMain"),
  );

  const waitingForBackend = Effect.gen(function* () {
    if (yield* Ref.get(backendReadyRef)) return false;
    return (yield* desktopSettings.get).localEnvironmentEnabled;
  });

  const createMainIfBackendReady = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;
    if (yield* waitingForBackend) return;
    const existingWindow = yield* currentMainWindow;
    if (Option.isSome(existingWindow)) return;
    yield* ensureMain;
  }).pipe(Effect.withSpan("desktop.window.createMainIfBackendReady"));

  const showConnectingSplash = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;
    const existingSplash = yield* Ref.get(splashWindowRef);
    if (Option.isSome(existingSplash)) return;
    const existingWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existingWindow)) return;

    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    if (yield* Ref.get(desktopState.quitting)) return;
    const splash = yield* electronWindow.create({
      width: 360,
      height: 220,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      center: true,
      show: false,
      skipTaskbar: false,
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      title: environment.displayName,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    if (yield* Ref.get(desktopState.quitting)) {
      yield* electronWindow.destroyAll;
      return;
    }
    yield* rendererHistory.register(splash.webContents, { surface: "splash" });
    yield* Ref.set(splashWindowRef, Option.some(splash));
    splash.once("closed", () => {
      void runPromise(Ref.set(splashWindowRef, Option.none()));
    });
    splash.once("ready-to-show", () => {
      if (!splash.isDestroyed()) {
        splash.show();
      }
    });
    void splash.loadURL(buildConnectingSplashDataUrl(shouldUseDarkColors));
    yield* logWindowInfo("connecting splash shown");
  }).pipe(
    Effect.catch((error) =>
      logWindowWarning("failed to show connecting splash", { message: error.message }),
    ),
    Effect.withSpan("desktop.window.showConnectingSplash"),
  );

  const dispatchRendererEvent = Effect.fn("desktop.window.dispatchRendererEvent")(function* (
    channel: string,
    payload: unknown,
    { reveal = true }: { readonly reveal?: boolean } = {},
  ) {
    if (yield* Ref.get(desktopState.quitting)) return;
    const existingWindow = yield* reveal ? focusedMainWindow : electronWindow.main;
    if (Option.isNone(existingWindow) && (!reveal || (yield* waitingForBackend))) return;
    const window = Option.isSome(existingWindow) ? existingWindow : yield* ensureMain;
    if (Option.isNone(window) || window.value.isDestroyed()) return;
    const targetWindow = window.value;
    const send = Effect.sync(() => {
      if (!targetWindow.isDestroyed()) targetWindow.webContents.send(channel, payload);
    });
    // The renderer must learn about the event even when another process refuses to
    // yield the foreground, so send first and treat the reveal as best effort.
    const dispatch = reveal
      ? send.pipe(Effect.andThen(electronWindow.reveal(targetWindow).pipe(Effect.ignoreCause)))
      : send;
    if (targetWindow.webContents.isLoadingMainFrame()) {
      targetWindow.webContents.once("did-finish-load", () => void runPromise(dispatch));
      return;
    }
    yield* dispatch;
  });

  const forkSnapShotDispatch = makePinnedSnapShotDispatch(requestTargetWindow, (event) =>
    dispatchRendererEvent(SNAP_SHOT_EVENT_CHANNEL, event, { reveal: event.type === "started" }),
  ); // fork-hook: multi-window/window-targets-snap-shot-dispatch

  const requestWindow = WindowDispatch.makeDesktopWindowRequestFork({
    electronWindow,
    createWindow: createWindowOrInterrupt,
    openPrimary: revealOrCreateMain,
    createPrimary: createMainIfBackendReady,
  }); // fork-hook: multi-window/dispatch-request-def

  const restoreWindow = WindowDispatch.makeDesktopWindowRestoreFork({
    electronWindow,
    createWindow: createWindowOrInterrupt,
  }); // fork-hook: multi-window/restore-opener
  const drainServices = { windowSession }; // fork-hook: multi-window/startup-drain-services
  const resolveDrainOpeners = makeStartupDrainOpeners(
    () => restoreWindow, // fork-hook: multi-window/restore-opener
    () => requestWindow, // fork-hook: multi-window/dispatch-drain-opener
    () => createMainIfBackendReady,
  ); // fork-hook: multi-window/startup-drain-openers

  const startupDrainRestore = startupDrain
    .stageRestore(drainServices)
    .pipe(Effect.withSpan("desktop.window.restoreWindowSession")); // fork-hook: multi-window/startup-drain-stage-restore-def
  const startupDrainOpenArguments = Effect.fn("desktop.window.openArguments")(
    (argv: readonly string[]) =>
      startupDrain
        .stageArguments(drainServices, resolveLaunchRequest, argv) // fork-hook: multi-window/dispatch-drain-arguments
        .pipe(
          Effect.flatMap((staged) => (staged.queued ? Effect.void : requestWindow(staged.request))), // fork-hook: multi-window/dispatch-drain-arguments
        ),
  ); // fork-hook: multi-window/startup-drain-stage-arguments-def
  const handleRendererReady = Ref.set(backendReadyRef, true).pipe(
    // The packaged or Vite renderer is loadable whether or not this desktop
    // process owns a backend.
    Effect.andThen(Effect.suspend(() => startupDrain.drain(drainServices, resolveDrainOpeners))),
    Effect.withSpan("desktop.window.handleRendererReady"),
  ); // fork-hook: backend-attach/renderer-ready

  return DesktopWindow.of({
    createMain: createMain.pipe(Effect.flatMap(requireWindow)),
    ensureMain: ensureMain.pipe(Effect.flatMap(requireWindow)),
    revealOrCreateMain,
    prepareCaptureReveal: Effect.gen(function* () {
      const forkTarget = yield* captureRevealWindow; // fork-hook: multi-window/window-targets-capture-reveal
      if (Option.isSome(forkTarget)) return yield* electronWindow.prepareReveal(forkTarget.value); // fork-hook: multi-window/window-targets-capture-reveal-return
      const existingWindow = yield* currentMainWindow;
      if (Option.isSome(existingWindow)) {
        yield* electronWindow.prepareReveal(existingWindow.value);
      }
    }),
    requestWindow, // fork-hook: multi-window/dispatch-request
    restoreWindowSession: startupDrainRestore, // fork-hook: multi-window/startup-drain-stage-restore
    openArguments: startupDrainOpenArguments, // fork-hook: multi-window/startup-drain-stage-arguments
    closeIdentity: electronWindow.close, // fork-hook: multi-window/close-identity
    activate: Effect.gen(function* () {
      if (yield* Ref.get(desktopState.quitting)) return;
      const forkTarget = yield* captureRevealWindow; // fork-hook: multi-window/window-targets-activate
      yield* endSnapShotReveal; // fork-hook: multi-window/window-targets-activate-end-reveal
      if (Option.isSome(forkTarget)) return yield* electronWindow.reveal(forkTarget.value); // fork-hook: multi-window/window-targets-activate-return
      const existingWindow = yield* currentMainWindow;
      if (Option.isSome(existingWindow)) {
        yield* electronWindow.reveal(existingWindow.value);
        return;
      }
      const backendReady = yield* Ref.get(backendReadyRef);
      if (!backendReady) {
        const splash = yield* Ref.get(splashWindowRef);
        if (Option.isSome(splash)) {
          yield* electronWindow.reveal(splash.value);
          return;
        }
      }
      yield* createMainIfBackendReady;
    }).pipe(Effect.withSpan("desktop.window.activate")),
    createMainIfBackendReady,
    showConnectingSplash,
    handleRendererReady, // fork-hook: backend-attach/renderer-ready-entry
    handleBackendReady: Effect.fn("desktop.window.handleBackendReady")(function* (httpBaseUrl) {
      yield* Ref.set(backendReadyRef, true);
      yield* logWindowInfo("backend ready", { source: "http", url: httpBaseUrl.href });
      const createMainIfBackendReady = Effect.suspend(() =>
        // The drain opens the restore and queued intents, and the main window only on a cold start.
        startupDrain.drain(drainServices, resolveDrainOpeners),
      ); // fork-hook: multi-window/startup-drain-backend-ready
      yield* createMainIfBackendReady;
    }),
    handleBackendNotReady: Ref.set(backendReadyRef, false).pipe(
      Effect.withSpan("desktop.window.handleBackendNotReady"),
      Effect.andThen(startupDrain.markNotReady), // fork-hook: multi-window/startup-drain-not-ready
    ),
    flushMainWindowBounds: Effect.suspend(() => flushMainWindowBounds).pipe(
      Effect.withSpan("desktop.window.flushMainWindowBounds"),
    ),
    dispatchMenuAction: Effect.fn("desktop.window.dispatchMenuAction")(function* (action, options) {
      yield* Effect.annotateCurrentSpan({ action });
      yield* dispatchRendererEvent(MENU_ACTION_CHANNEL, action, options);
    }),
    dispatchSnapShotEvent: Effect.fn("desktop.window.dispatchSnapShotEvent")(function* (event) {
      yield* Effect.annotateCurrentSpan({
        event: event.type,
        captureId: "id" in event ? (event.id ?? null) : null,
      });
      if (yield* forkSnapShotDispatch(event)) return; // fork-hook: multi-window/window-targets-snap-shot
      yield* dispatchRendererEvent(SNAP_SHOT_EVENT_CHANNEL, event, {
        reveal: event.type === "started",
      });
    }),
    zoomMain: Effect.fn("desktop.window.zoomMain")(function* (direction) {
      yield* Effect.annotateCurrentSpan({ direction });
      const window = yield* electronWindow.main;
      if (Option.isNone(window) || window.value.isDestroyed()) {
        return;
      }
      yield* zoomWindow(window.value, direction);
    }),
    runMainContentsCommand: Effect.fn("desktop.window.runMainContentsCommand")(function* (command) {
      yield* Effect.annotateCurrentSpan({ command });
      // The registered main window, never the focused one: with an OAuth popup
      // focused, Reload would otherwise reload the popup mid sign-in.
      const window = yield* electronWindow.main;
      if (Option.isNone(window) || window.value.isDestroyed()) return;
      const webContents = window.value.webContents;
      if (command === "reload") webContents.reload();
      else if (command === "forceReload") webContents.reloadIgnoringCache();
      else webContents.toggleDevTools();
    }),
    syncAppearance: Effect.gen(function* () {
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window) =>
        syncWindowAppearance(window, shouldUseDarkColors, environment.platform),
      );
    }).pipe(Effect.withSpan("desktop.window.syncAppearance")),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
