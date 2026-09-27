import type { ContextMenuItem, ProviderDriverKind } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
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

/** Providers whose native sessions the server can fork. */
const FORKABLE_THREAD_PROVIDERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

export interface ForkableThreadProviderState {
  readonly provider: ProviderDriverKind;
  /** A running or queued turn or a pending request blocks the fork client-side too. */
  readonly busy: boolean;
  readonly inFlight: boolean;
}

/**
 * Menu state for the Fork action: present only for Claude and Codex threads,
 * disabled while the thread is busy (the server guard stays authoritative)
 * or while a fork RPC for any thread is still in flight.
 */
/** The quiescence slice of the shell the fork busy check reads. */
export type ForkThreadShell = Pick<
  EnvironmentThreadShell,
  "latestTurn" | "session" | "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt"
>;

export function forkThreadMenuStateFork(
  driver: ProviderDriverKind | null | undefined,
  inFlight: boolean,
  thread: ForkThreadShell,
  now: string,
): ForkableThreadProviderState | null {
  if (driver === null || driver === undefined || !FORKABLE_THREAD_PROVIDERS.has(driver)) {
    return null;
  }
  const busy =
    thread.latestTurn?.state === "running" ||
    thread.session?.activeTurnId != null ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    hasQueuedTurnStart(
      {
        latestUserMessageAt: thread.latestUserMessageAt,
        latestTurn: thread.latestTurn,
        session: thread.session,
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
      disabled: state.fork.inFlight || state.fork.busy,
    },
  ];
}
