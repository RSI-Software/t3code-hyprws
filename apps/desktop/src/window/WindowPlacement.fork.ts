// Fork-only: how a window meets Hyprland when it maps
// (RSI-Software/t3code-hyprws#1345). `DesktopWindow.ts` carries one-line hooks
// into these helpers.
//
// Hyprland matches windows by exact title, and generic windows share one (two
// all-projects windows are both "T3 Code"). So a window restored onto a
// captured workspace maps under a title carrying its WindowId and keeps it
// until claimed; only then does it take its normal title. Every other window
// maps under its normal title, so the user's own rules on it still fire. The
// workspace is still the user's choice: a restore replays the one captured,
// dev:desktop:agent names one explicitly, and anything else maps wherever
// Hyprland puts it.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import type { DesktopDevAgentPlacement } from "../app/DesktopEnvironment.ts";
import type { HyprlandPlacement } from "./HyprlandPlacement.ts";
import type { HyprlandWorkspaceRef } from "./hyprland.ts";
import type { WindowId } from "./WindowId.fork.ts";

/** The title a window maps under until claimed; unique per window, never a comma. */
export const windowClaimTitle = (windowId: WindowId): string => `t3code-window-${windowId}`;

export interface MapPlacement {
  readonly title: string;
  /** Staged before map so the window never appears elsewhere first. */
  readonly workspace: HyprlandWorkspaceRef;
  /** A claim token: every rule staged on it is removed once placement ends. */
  readonly transient: boolean;
}

/**
 * How this window maps: the dev agent's explicit target, else on Hyprland a
 * restored workspace under the window's claim title, else nothing to arrange.
 */
export const resolveMapPlacementFork = (input: {
  readonly hyprlandAvailable: boolean;
  readonly windowId: WindowId;
  readonly devAgent: Option.Option<DesktopDevAgentPlacement>;
  readonly restoredWorkspace: HyprlandWorkspaceRef | null | undefined;
}): MapPlacement | null => {
  if (Option.isSome(input.devAgent)) {
    const { title, workspace } = input.devAgent.value;
    return { title, workspace: { id: workspace, name: String(workspace) }, transient: false };
  }
  if (!input.hyprlandAvailable || input.restoredWorkspace == null) return null;
  return {
    title: windowClaimTitle(input.windowId),
    workspace: input.restoredWorkspace,
    transient: true,
  };
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
  const { workspace, transient } = placement;
  return Effect.gen(function* () {
    yield* hyprlandPlacement.stageWorkspaceRule(placement.title, workspace, { transient });
    yield* pin;
    if (!window.isDestroyed()) window.showInactive();
    if (input.maximize && !window.isDestroyed()) window.maximize();
    yield* input.dismissSplash;
    yield* hyprlandPlacement.claim(windowId, placement.title);
    yield* release;
    yield* hyprlandPlacement.moveToWorkspace(windowId, workspace);
  }).pipe(
    Effect.ensuring(release),
    Effect.ensuring(hyprlandPlacement.clearWorkspaceRule(placement.title, { transient })),
    Effect.withSpan("desktop.window.placeAtMap"),
  );
};

/**
 * Claims a window shown under its normal title. `knownAddresses` was read
 * before the show, so a renderer retitle before the claim still finds the
 * window as the one new client that appeared.
 */
export const claimShownFork = (input: {
  readonly hyprlandPlacement: HyprlandPlacement["Service"];
  readonly windowId: WindowId;
  readonly title: string;
  readonly knownAddresses: Promise<ReadonlySet<string>>;
}): Effect.Effect<void> =>
  Effect.promise(() => input.knownAddresses).pipe(
    Effect.flatMap((knownAddresses) =>
      input.hyprlandPlacement.claim(input.windowId, input.title, { knownAddresses }),
    ),
  );
