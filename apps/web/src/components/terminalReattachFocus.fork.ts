import { type TerminalSessionState } from "@t3tools/client-runtime/state/terminal";
import { type RefObject, useEffect, useState } from "react";

type TerminalStatus = TerminalSessionState["status"];

export function shouldRestoreTerminalFocusAfterResume(input: {
  attached: boolean;
  status: TerminalStatus;
  restoreRequested: boolean;
  focusPending: boolean;
}): boolean {
  return (
    input.attached && input.status === "running" && input.restoreRequested && input.focusPending
  );
}

/** A terminal that held focus when its zmux attachment detached refocuses once it runs again. */
function createReattachFocusFork(initiallyAttached: boolean) {
  let attached = initiallyAttached;
  let status: TerminalStatus | null = null;
  let restore = false;
  let pending = false;
  let focus = () => {};
  const tryFocus = () => {
    if (status === null) return;
    if (
      !shouldRestoreTerminalFocusAfterResume({
        attached,
        status,
        restoreRequested: restore,
        focusPending: pending,
      })
    ) {
      return;
    }
    restore = false;
    pending = false;
    const focusNow = focus;
    window.requestAnimationFrame(() => {
      if (attached) focusNow();
    });
  };
  return {
    attach(next: boolean, restoreOnReattach: boolean, container: HTMLElement | null) {
      const wasAttached = attached;
      attached = next;
      if (!next) {
        if (wasAttached) {
          restore = restoreOnReattach && (container?.contains(document.activeElement) ?? false);
        } else if (!restoreOnReattach) {
          restore = false;
        }
        return;
      }
      if (!wasAttached && restore) {
        pending = true;
        tryFocus();
      }
    },
    resume(next: TerminalStatus, nextFocus: () => void) {
      status = next;
      focus = nextFocus;
      tryFocus();
    },
  };
}

export function useReattachFocusFork(
  attached: boolean,
  restoreOnReattach: boolean,
  containerRef: RefObject<HTMLElement | null>,
) {
  const [controller] = useState(() => createReattachFocusFork(attached));
  // oxlint-disable-next-line t3code/react-effect-budget -- Reads DOM focus as the zmux attachment detaches.
  useEffect(() => {
    controller.attach(attached, restoreOnReattach, containerRef.current);
  }, [attached, containerRef, controller, restoreOnReattach]);
  return controller;
}
