// Fork-owned composer focus routing. Returning to a thread focuses the
// composer through upstream's own window-focus predicate, and the composer and
// terminal focus commands leave a maximized right panel first.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { focusActiveDrawerTerminal } from "../lib/terminalFocus";
import { shouldRefocusComposerOnWindowFocus } from "./ChatView.logic";

// Returning to a thread lands in the composer unless something deliberately holds
// typing focus (a text field, a terminal, a dialog or popup). Upstream's
// window-focus predicate already encodes exactly those exceptions.
export function shouldAutoFocusComposerOnThreadChange(
  activeElement: Parameters<typeof shouldRefocusComposerOnWindowFocus>[0],
): boolean {
  return shouldRefocusComposerOnWindowFocus(activeElement);
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
  // oxlint-disable-next-line t3code/react-effect-budget -- schedules a DOM focus on the next animation frame after thread navigation.
  useEffect(() => {
    if (!threadKey || !shouldFocus()) return;
    const frame = window.requestAnimationFrame(focusComposer);
    return () => window.cancelAnimationFrame(frame);
  }, [threadKey, focusComposer]);
}

export function composerFocusCommandsFork(input: {
  maximized: boolean;
  toggleMaximized: () => void;
  drawerOpen: boolean;
  toggleDrawer: () => void;
  threadRef: ScopedThreadRef | null;
  focusComposer: () => void;
  scheduleComposerFocus: () => void;
}) {
  return {
    "terminal.focus": () => {
      if (input.maximized) input.toggleMaximized();
      if (!input.drawerOpen) return void input.toggleDrawer();
      if (input.threadRef) focusActiveDrawerTerminal(input.threadRef);
    },
    "chat.focusComposer": () => {
      if (input.maximized) {
        input.toggleMaximized();
        input.scheduleComposerFocus();
        return;
      }
      input.focusComposer();
    },
  };
}
