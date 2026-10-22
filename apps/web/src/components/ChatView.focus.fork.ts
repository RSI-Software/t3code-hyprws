// Fork-owned composer/terminal focus routing for thread changes. Upstream
// owns the focus request counter
// (`terminalFocusRequestId`) and its setter call sites; this module adapts
// around them: a single upstream bump is routed to the pane that asked for it
// (drawer vs right panel) so an explicit request never focuses the other
// pane, stale requests are not replayed on thread change, and returning to a
// thread focuses the composer through upstream's own window-focus predicate.
import { useEffect, useEffectEvent, useState, type Dispatch, type SetStateAction } from "react";
import { shouldRefocusComposerOnWindowFocus } from "./ChatView.logic";

// Returning to a thread should land in the composer, unless something that
// deliberately holds typing focus — a text field, a drawer or panel terminal,
// a dialog or popup — would be steamrolled. Upstream's window-focus predicate
// already encodes exactly those exceptions, so thread-change autofocus is one
// call into it.
export function shouldAutoFocusComposerOnThreadChange(
  activeElement: Parameters<typeof shouldRefocusComposerOnWindowFocus>[0],
): boolean {
  return shouldRefocusComposerOnWindowFocus(activeElement);
}

// An optional spread overrides the upstream prop without replacing its line.
export function terminalFocusPropsFork(requestId: number): { focusRequestId?: number } {
  return { focusRequestId: requestId };
}

export function requestTerminalFocusFork(
  pane: TerminalFocusPaneFork,
  setRequestId: Dispatch<SetStateAction<number>>,
): void {
  noteTerminalFocusIntentFork(pane);
  setRequestId((value) => value + 1);
}

export function useOpenDrawerComposerFocusFork(
  threadKey: string | null,
  drawerOpen: boolean,
  focusComposer: () => void,
): void {
  // Visibility changes belong to upstream; only navigation needs this repair.
  const shouldFocus = useEffectEvent(
    () => drawerOpen && shouldAutoFocusComposerOnThreadChange(document.activeElement),
  );
  useEffect(() => {
    if (!threadKey || !shouldFocus()) return;
    const frame = window.requestAnimationFrame(focusComposer);
    return () => window.cancelAnimationFrame(frame);
  }, [threadKey, focusComposer]);
}

export type TerminalFocusPaneFork = "drawer" | "panel";

// Set synchronously next to an upstream `setTerminalFocusRequestId` call so
// the gate below can attribute the bump to the requesting pane. Module-level
// because the upstream call sites are not fork-owned.
let lastTerminalFocusIntentFork: TerminalFocusPaneFork | null = null;

export function noteTerminalFocusIntentFork(pane: TerminalFocusPaneFork): void {
  lastTerminalFocusIntentFork = pane;
}

function takeTerminalFocusIntentFork(): TerminalFocusPaneFork | null {
  const intent = lastTerminalFocusIntentFork;
  lastTerminalFocusIntentFork = null;
  return intent;
}

export interface TerminalFocusGateStateFork {
  threadKey: string | null;
  drawerRequestId: number;
  panelRequestId: number;
}

export interface TerminalFocusGateInputFork {
  requestId: number;
  threadKey: string | null;
  intent: TerminalFocusPaneFork | null;
}

// Splits the single upstream request counter into per-pane request ids: a bump
// is routed to the pane that recorded its intent immediately before the
// upstream setter, a request never reaches the other pane, and a thread change
// resets both panes so a remounted drawer cannot replay a stale request. A
// request id of 0 is the no-request sentinel and is never assigned.
export function reduceTerminalFocusGateFork(
  state: TerminalFocusGateStateFork,
  input: TerminalFocusGateInputFork,
): TerminalFocusGateStateFork {
  if (state.threadKey !== input.threadKey) {
    return { threadKey: input.threadKey, drawerRequestId: 0, panelRequestId: 0 };
  }
  if (input.requestId === 0 || input.intent === null) {
    return state;
  }
  return input.intent === "drawer"
    ? { ...state, drawerRequestId: input.requestId }
    : { ...state, panelRequestId: input.requestId };
}

export interface TerminalFocusGateForkResult {
  drawerRequestId: number;
  panelRequestId: number;
}

// The gate must re-reduce whenever the thread key moves, even without a
// request bump: pane requests do not survive a thread change, so revisiting a
// thread (away and back) must present the remounted drawer the zero
// no-request sentinel instead of the stale pre-navigation request id.
export function shouldAdvanceTerminalFocusGateFork(
  state: TerminalFocusGateStateFork,
  input: { requestId: number; threadKey: string | null; lastSeenRequestId: number },
): boolean {
  return input.lastSeenRequestId !== input.requestId || state.threadKey !== input.threadKey;
}

export function useTerminalFocusGateFork(input: {
  requestId: number;
  threadKey: string | null;
}): TerminalFocusGateForkResult {
  const [state, setState] = useState<
    TerminalFocusGateStateFork & { readonly lastSeenRequestId: number }
  >({
    threadKey: input.threadKey,
    drawerRequestId: 0,
    panelRequestId: 0,
    lastSeenRequestId: input.requestId,
  });

  if (
    shouldAdvanceTerminalFocusGateFork(state, {
      requestId: input.requestId,
      threadKey: input.threadKey,
      lastSeenRequestId: state.lastSeenRequestId,
    })
  ) {
    const bumped = state.lastSeenRequestId !== input.requestId;
    setState({
      ...reduceTerminalFocusGateFork(state, {
        requestId: input.requestId,
        threadKey: input.threadKey,
        intent: bumped ? takeTerminalFocusIntentFork() : null,
      }),
      lastSeenRequestId: input.requestId,
    });
  }

  return { drawerRequestId: state.drawerRequestId, panelRequestId: state.panelRequestId };
}
