// Hyprland matches windows by exact title, and generic windows share one. A
// restored window, or one opened while another is unclaimed under the same
// title, maps under its WindowId claim title until claimed; others map under
// their normal title so user rules still fire. Hooks live in `DesktopWindow.ts`.
import * as Effect from "effect/Effect";
import type * as Electron from "electron";

import type { HyprlandPlacement } from "./HyprlandPlacement.ts";
import type { HyprlandWorkspaceRef } from "./hyprland.ts";
import type { WindowId } from "./WindowId.fork.ts";

/** The title a window maps under until claimed; unique per window, never a comma. */
export const windowClaimTitle = (windowId: WindowId): string => `t3code-window-${windowId}`;

export interface MapPlacement {
  readonly title: string;
  /** Staged before map so the window never appears elsewhere first. */
  readonly workspace: HyprlandWorkspaceRef;
}

/**
 * How this window maps: on Hyprland a restored workspace under the window's
 * claim title, else nothing to arrange.
 */
export const resolveMapPlacementFork = (input: {
  readonly hyprlandAvailable: boolean;
  readonly windowId: WindowId;
  readonly restoredWorkspace: HyprlandWorkspaceRef | null | undefined;
}): MapPlacement | null => {
  if (!input.hyprlandAvailable || input.restoredWorkspace == null) return null;
  return {
    title: windowClaimTitle(input.windowId),
    workspace: input.restoredWorkspace,
  };
};

/** The windows still unclaimed under their normal title, one app-wide set. */
export const makeTitleClaimsFork = () => {
  const pending = new Set<WindowId>();
  return {
    /** Takes the normal-title slot for `windowId`; false while another window holds it. */
    reserve: (windowId: WindowId): boolean => {
      if (pending.size > 0 && !pending.has(windowId)) return false;
      pending.add(windowId);
      return true;
    },
    release: (windowId: WindowId): void => void pending.delete(windowId),
  };
};

export type TitleClaims = ReturnType<typeof makeTitleClaimsFork>;

/**
 * The claim title a window without a placement maps under, or null for its
 * normal title: null off Hyprland, and null when no other window is still
 * unclaimed under its normal title.
 */
export const reserveClaimTitleFork = (input: {
  readonly hyprlandAvailable: boolean;
  readonly windowId: WindowId;
  readonly placement: MapPlacement | null;
  readonly titleClaims: TitleClaims;
}): string | null =>
  !input.hyprlandAvailable || input.placement !== null || input.titleClaims.reserve(input.windowId)
    ? null
    : windowClaimTitle(input.windowId);

/** The title a window is built with, as an option that overrides upstream's app name. */
export const titleOptionFork = (
  title: string,
): Pick<Electron.BrowserWindowConstructorOptions, "title"> => ({ title });

/**
 * Rewrites upstream's app-name title from the latest page title (`resolve`
 * returns null to keep it). Install before the title hold, which restores the
 * `setTitle` it found, and before upstream's `page-title-updated` listener, so
 * the page title is current when that listener sets the title.
 */
export const retitleWindowFork = (
  window: Electron.BrowserWindow,
  appTitle: string,
  resolve: (pageTitle: string) => string | null,
): void => {
  let pageTitle = "";
  window.on("page-title-updated", (_event, title) => {
    pageTitle = title;
  });
  const setTitle = window.setTitle;
  window.setTitle = (title: string) =>
    setTitle.call(window, title === appTitle ? (resolve(pageTitle) ?? title) : title);
};

export interface TitleHold {
  /** Shows the held title again, over anything set since the window was built. */
  readonly pin: () => void;
  /** Drops the hold and shows the last title anything asked for. */
  readonly release: () => void;
}

/**
 * Holds `title` on `window`, which was built with it, until released. Renderer
 * document titles and the load handlers keep calling `setTitle` while the
 * window maps; the hold records each request instead, so the claim title is
 * still what the compositor sees.
 */
export const holdWindowTitleFork = (
  window: Electron.BrowserWindow,
  title: string,
  normalTitle: string,
): TitleHold => {
  const setTitle = window.setTitle;
  let requested = normalTitle;
  window.setTitle = (next: string) => {
    requested = next;
  };
  let held = true;
  return {
    pin: () => {
      if (held && !window.isDestroyed()) setTitle.call(window, title);
    },
    release: () => {
      if (!held) return;
      held = false;
      window.setTitle = setTitle;
      if (!window.isDestroyed()) setTitle.call(window, requested);
    },
  };
};

/**
 * Maps the window under its placement title and claims it by that title. A
 * title-scoped rule is staged before the window shows without activation, and
 * an address-scoped move runs last so the explicit target wins over rules the
 * normal title re-evaluates.
 */
export const placeAtMapFork = (input: {
  readonly hyprlandPlacement: HyprlandPlacement["Service"];
  readonly window: Electron.BrowserWindow;
  readonly windowId: WindowId;
  readonly placement: MapPlacement;
  readonly titleHold: TitleHold;
  /**
   * Maximized only once shown inactive: Electron's maximize() shows a hidden
   * window, which would map it before the rule and give it focus. The caller
   * therefore runs this placement before its own maximize-and-reveal path.
   */
  readonly maximize: boolean;
  readonly dismissSplash: Effect.Effect<void>;
}): Effect.Effect<void> => {
  const { hyprlandPlacement, window, windowId, placement, titleHold } = input;
  const release = Effect.sync(titleHold.release);
  const pin = Effect.sync(titleHold.pin);
  const { workspace } = placement;
  return Effect.gen(function* () {
    yield* hyprlandPlacement.stageWorkspaceRule(placement.title, workspace);
    yield* pin;
    if (!window.isDestroyed()) window.showInactive();
    if (input.maximize && !window.isDestroyed()) window.maximize();
    yield* input.dismissSplash;
    yield* hyprlandPlacement.claim(windowId, placement.title);
    yield* release;
    yield* hyprlandPlacement.moveToWorkspace(windowId, workspace);
  }).pipe(
    Effect.ensuring(release),
    Effect.ensuring(hyprlandPlacement.clearWorkspaceRule(placement.title)),
    Effect.withSpan("desktop.window.placeAtMap"),
  );
};

/**
 * Claims a window shown without a placement, under its normal or claim title.
 * `knownAddresses` was read before the show, so a renderer retitle before the
 * claim still finds the window as the one new client that appeared. The claim
 * title's hold and the normal-title slot both end with the claim.
 */
export const claimShownFork = (input: {
  readonly hyprlandPlacement: HyprlandPlacement["Service"];
  readonly windowId: WindowId;
  readonly title: string;
  readonly knownAddresses: Promise<ReadonlySet<string>>;
  readonly titleHold: TitleHold | null;
  readonly titleClaims: TitleClaims;
}): Effect.Effect<void> =>
  Effect.promise(() => input.knownAddresses).pipe(
    Effect.flatMap((knownAddresses) =>
      input.hyprlandPlacement.claim(input.windowId, input.title, { knownAddresses }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        input.titleHold?.release();
        input.titleClaims.release(input.windowId);
      }),
    ),
  );
