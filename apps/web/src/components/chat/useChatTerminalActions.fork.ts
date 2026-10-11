import type { ScopedThreadRef, TerminalSessionMode } from "@t3tools/contracts";
import type { Dispatch, SetStateAction } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { terminalSessionModeChoiceFork } from "../TerminalNewMenu.fork";
import type { useThreadTerminalActions } from "../terminal/useThreadTerminalActions";

export function useTerminalPanelActionsFork(
  threadRef: ScopedThreadRef | null,
  terminalActions: ReturnType<typeof useThreadTerminalActions>,
  launchDefault: () => void,
  setFocusRequestId: Dispatch<SetStateAction<number>>,
) {
  const addTerminalSurfaceStable = useStableCallback((modeArg?: TerminalSessionMode) => {
    const sessionMode = terminalSessionModeChoiceFork(modeArg);
    // Preserve upstream's default path, including callbacks invoked by click events.
    if (!sessionMode) return launchDefault();
    if (!threadRef) return;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) => {
        useTerminalUiStateStore
          .getState()
          .setTerminalSessionModeFork(threadRef, terminalId, sessionMode);
        useRightPanelStore.getState().openTerminal(threadRef, terminalId);
      },
      sessionModeFork: sessionMode,
    });
    if (!launched) return;
    setFocusRequestId((value) => value + 1);
    void launched.result;
  });
  return threadRef ? { addTerminalSurfaceStable } : null;
}
