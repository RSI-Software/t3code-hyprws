import { useEffect, useState } from "react";
import { loadOrCreateAgentAwarenessDeviceId, loadPreferences } from "../../persistence/imperative";
import { readTerminalCheckoutMode, type TerminalCheckoutMode } from "./terminalCheckoutMode";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "An unexpected error occurred.";

export function useTerminalSetupPreferencesFork(
  checkoutModeKey: string,
  terminalSetupAttempt: number,
) {
  const [terminalDeviceState, setTerminalDeviceState] = useState<{
    readonly id: string | null;
    readonly error: string | null;
  }>({ id: null, error: null });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loads the persisted device identity for a terminal attachment and cancels stale setup requests.
  useEffect(() => {
    let active = true;
    void loadOrCreateAgentAwarenessDeviceId()
      .then((deviceId) => {
        if (active) setTerminalDeviceState({ id: deviceId, error: null });
      })
      .catch((error: unknown) => {
        if (active) setTerminalDeviceState({ id: null, error: errorMessage(error) });
      });
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A setup retry reloads the device id. // fork-hook: zmux-estate/terminal-setup-retry
  }, [terminalSetupAttempt]);
  const [checkoutModeState, setCheckoutModeState] = useState<{
    readonly key: string;
    readonly mode: TerminalCheckoutMode;
    readonly resolved: boolean;
    readonly error: string | null;
  }>({ key: checkoutModeKey, mode: "follow", resolved: false, error: null });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Loads the persisted terminal checkout preference and cancels stale setup requests.
  useEffect(() => {
    let active = true;
    void loadPreferences()
      .then((preferences) => {
        if (active) {
          setCheckoutModeState({
            key: checkoutModeKey,
            mode: readTerminalCheckoutMode(preferences, checkoutModeKey),
            resolved: true,
            error: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setCheckoutModeState({
            key: checkoutModeKey,
            mode: "follow",
            resolved: false,
            error: errorMessage(error),
          });
        }
      });
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A setup retry reloads the checkout mode. // fork-hook: zmux-estate/terminal-setup-retry
  }, [checkoutModeKey, terminalSetupAttempt]);
  return { terminalDeviceState, setTerminalDeviceState, checkoutModeState, setCheckoutModeState };
}
