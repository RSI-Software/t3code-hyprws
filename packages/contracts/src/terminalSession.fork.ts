import type { TerminalSessionMode } from "./settings.ts";

/**
 * Fork (zmux-estate): whether new worktrees and unsettled threads get a
 * managed zmux session. An unset toggle follows the default launch mode, so
 * settings saved before the toggle existed keep their behavior.
 */
export const zmuxAutoSessionsEnabled = (settings: {
  readonly terminalSessionMode: TerminalSessionMode;
  readonly zmuxAutoSessions: boolean | null;
}): boolean => settings.zmuxAutoSessions ?? settings.terminalSessionMode === "zmux";
