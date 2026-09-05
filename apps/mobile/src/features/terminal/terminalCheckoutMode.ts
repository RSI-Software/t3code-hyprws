import type { Preferences } from "../../persistence/imperative";

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
