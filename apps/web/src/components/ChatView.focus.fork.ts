// Fork-owned composer/terminal focus routing for thread changes and the
// terminal hop command. Upstream owns the focus request counter
// (`terminalFocusRequestId`) and its setter call sites; this module adapts
// around them: a single upstream bump is routed to the pane that asked for it
// (drawer vs right panel) so an explicit request never focuses the other
// pane, stale requests are not replayed on thread change, and returning to a
// thread focuses the composer through upstream's own window-focus predicate.
import { useCallback, useRef, useState } from "react";
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

export function useTerminalFocusGateFork(input: {
  requestId: number;
  threadKey: string | null;
}): TerminalFocusGateForkResult {
  const [state, setState] = useState<TerminalFocusGateStateFork>({
    threadKey: input.threadKey,
    drawerRequestId: 0,
    panelRequestId: 0,
  });
  const lastSeenRequestIdRef = useRef(input.requestId);

  if (lastSeenRequestIdRef.current !== input.requestId) {
    lastSeenRequestIdRef.current = input.requestId;
    setState(
      reduceTerminalFocusGateFork(state, {
        requestId: input.requestId,
        threadKey: input.threadKey,
        intent: takeTerminalFocusIntentFork(),
      }),
    );
  }

  return { drawerRequestId: state.drawerRequestId, panelRequestId: state.panelRequestId };
}

export interface ComposerFocusCommandForkInput {
  command: string;
  event: { preventDefault(): void; stopPropagation(): void };
  rightPanelMaximized: boolean;
  toggleRightPanelMaximized: () => void;
  drawerOpen: boolean;
  toggleDrawer: () => void;
  requestDrawerFocus: () => void;
  scheduleComposerFocus: () => void;
  focusComposer: () => void;
}

// The terminal hop: `` ctrl+` `` focuses the drawer terminal (opening it if
// needed) from the composer, and returns to the composer without closing the
// drawer from the terminal. Returns true when the command was consumed.
export function handleComposerFocusCommandFork(input: ComposerFocusCommandForkInput): boolean {
  if (input.command === "terminal.focus") {
    input.event.preventDefault();
    input.event.stopPropagation();
    if (input.rightPanelMaximized) {
      input.toggleRightPanelMaximized();
    }
    if (!input.drawerOpen) {
      input.toggleDrawer();
      return true;
    }
    input.requestDrawerFocus();
    return true;
  }

  if (input.command === "chat.focusComposer") {
    input.event.preventDefault();
    input.event.stopPropagation();
    if (input.rightPanelMaximized) {
      input.toggleRightPanelMaximized();
      input.scheduleComposerFocus();
      return true;
    }
    input.focusComposer();
    return true;
  }

  return false;
}
