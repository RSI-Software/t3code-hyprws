import type { ContextMenuItem, ProviderDriverKind } from "@t3tools/contracts";

import type { ThreadActionMenuId, ThreadActionMenuState } from "./threadActionMenu.logic.ts";

/**
 * Fork: the way back from a manual order key to automatic ordering.
 * Returns the Reset order entry only while the thread carries a manual
 * activeOrderKey; selecting it dispatches the existing active-reorder
 * write with a null key.
 */
export function resetOrderMenuItems(
  state: Pick<ThreadActionMenuState, "hasManualOrder">,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return state.hasManualOrder
    ? [{ id: "reset-order" as const, label: "Reset order", icon: "arrow-down-up" }]
    : [];
}

/** Providers whose native sessions the server can fork. */
const FORKABLE_THREAD_PROVIDERS: ReadonlyArray<string> = ["claudeAgent", "codex"];

export interface ForkableThreadProviderState {
  readonly provider: ProviderDriverKind;
  readonly inFlight: boolean;
}

/**
 * Menu state for the Fork action: present only for Claude and Codex threads,
 * disabled while a fork RPC for any thread is still in flight.
 */
export function forkThreadMenuStateFork(
  driver: ProviderDriverKind | null | undefined,
  inFlight: boolean,
): ForkableThreadProviderState | null {
  return driver !== null && driver !== undefined && FORKABLE_THREAD_PROVIDERS.includes(driver)
    ? { provider: driver, inFlight }
    : null;
}

/** The Fork entry, hidden entirely for every other provider. */
export function forkThreadMenuItems(
  state: Pick<ThreadActionMenuState, "fork">,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  if (state.fork === undefined || state.fork === null) return [];
  return [
    {
      id: "fork" as const,
      label: "Fork thread",
      icon: "git-fork",
      disabled: state.fork.inFlight,
    },
  ];
}
