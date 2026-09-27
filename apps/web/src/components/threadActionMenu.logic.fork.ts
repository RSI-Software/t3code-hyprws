import type { ContextMenuItem, ProviderDriverKind } from "@t3tools/contracts";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { hasQueuedTurnStart } from "@t3tools/client-runtime/state/thread-settled";

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

/**
 * Fork: Open in New Window for a thread (RSI-Software/t3code-hyprws#1343).
 * Present only where the client can open desktop windows.
 */
export function openInNewWindowMenuItems(
  state: Pick<ThreadActionMenuState, "openInNewWindow">,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return state.openInNewWindow === true
    ? [{ id: "open-in-new-window" as const, label: "Open in New Window", icon: "external-link" }]
    : [];
}

export interface ForkableThreadProviderState {
  readonly provider: ProviderDriverKind;
  /** A running or queued turn or a pending request blocks the fork client-side too. */
  readonly busy: boolean;
  readonly inFlight: boolean;
}

/** The quiescence slice of the shell the fork busy check reads. */
export type ForkThreadShell = Pick<
  EnvironmentThreadShell,
  "latestRun" | "runtime" | "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt"
>;

/**
 * Menu state for the Fork action. V2 `thread.fork` copies the thread from its
 * latest stable run: natively when the provider can fork, otherwise as a
 * portable context handoff, so any configured provider qualifies once the
 * thread has run. Disabled while the thread is busy (the orchestrator stays
 * authoritative) or while a fork for that thread is still in flight.
 */
export function forkThreadMenuStateFork(
  driver: ProviderDriverKind | null | undefined,
  inFlight: boolean,
  thread: ForkThreadShell,
  now: string,
): ForkableThreadProviderState | null {
  if (driver === null || driver === undefined || thread.latestRun === null) return null;
  const busy =
    threadRuntimeIsActive(thread.runtime) ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    hasQueuedTurnStart(
      {
        latestUserMessageAt: thread.latestUserMessageAt,
        latestRun: thread.latestRun,
        runtime: thread.runtime,
      },
      { now },
    );
  return { provider: driver, busy, inFlight };
}

/**
 * The `thread` + `now` tail arguments for `forkThreadMenuStateFork` call
 * sites, as a spreadable tuple so each upstream builder file takes the fork
 * state through one marked line.
 */
export const forkThreadStateTailFork = (
  thread: ForkThreadShell,
  now: string,
): [thread: ForkThreadShell, now: string] => [thread, now];

/** The Fork entry, hidden until the thread has a run to fork from. */
export function forkThreadMenuItems(
  state: Pick<ThreadActionMenuState, "fork">,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  if (state.fork === undefined || state.fork === null) return [];
  return [
    {
      id: "fork" as const,
      label: "Fork thread",
      icon: "git-fork",
      disabled: state.fork.inFlight || state.fork.busy,
    },
  ];
}
