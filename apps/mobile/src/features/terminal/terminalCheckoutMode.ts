import type { Preferences } from "../../persistence/imperative";
import {
  getCachedTerminalGridSize,
  type TerminalGridSize,
  type TerminalUiStateTarget,
} from "./terminalUiState";

export type TerminalCheckoutMode = "follow" | "pin";

export function terminalCheckoutModeKey(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalId: string;
}): string {
  return JSON.stringify([input.environmentId, input.threadId, input.terminalId]);
}

export function readTerminalCheckoutMode(
  preferences: Preferences,
  key: string,
): TerminalCheckoutMode {
  return preferences.terminalCheckoutModes?.[key] === "pin" ? "pin" : "follow";
}

export function updateTerminalCheckoutMode(
  preferences: Preferences,
  key: string,
  mode: TerminalCheckoutMode,
): Partial<Preferences> {
  const terminalCheckoutModes = { ...preferences.terminalCheckoutModes };
  if (mode === "pin") terminalCheckoutModes[key] = "pin";
  else delete terminalCheckoutModes[key];
  return { terminalCheckoutModes };
}

/** A follow-mode reopen attaches at the last measured grid, else the first attach's. */
export function followGridSizeFork(
  target: TerminalUiStateTarget,
  fallback: TerminalGridSize,
): TerminalGridSize {
  return getCachedTerminalGridSize(target) ?? fallback;
}
