// Fork-owned Settings → Terminal page (zmux-estate): the default launch mode
// and automatic zmux session creation. Both live in the server's settings.
import {
  DEFAULT_UNIFIED_SETTINGS,
  type TerminalSessionMode,
  type UnifiedSettings,
  zmuxAutoSessionsEnabled,
} from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const LAUNCH_MODE_LABELS: Record<TerminalSessionMode, string> = {
  shell: "Plain shell",
  zmux: "zmux shell",
};

/** Restore-dialog labels for terminal settings that differ from their defaults. */
export const terminalRestoreLabelsFork = (settings: UnifiedSettings): Array<string> => [
  ...(settings.terminalSessionMode !== DEFAULT_UNIFIED_SETTINGS.terminalSessionMode
    ? ["Default terminal"]
    : []),
  ...(settings.zmuxAutoSessions !== DEFAULT_UNIFIED_SETTINGS.zmuxAutoSessions
    ? ["Automatic zmux sessions"]
    : []),
];

export const terminalRestoreDefaultsFork = {
  terminalSessionMode: DEFAULT_UNIFIED_SETTINGS.terminalSessionMode,
  zmuxAutoSessions: DEFAULT_UNIFIED_SETTINGS.zmuxAutoSessions,
};

export function TerminalSettingsFork() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsSection title="Terminal">
      <SettingsRow
        serverScoped
        {...searchableSetting("terminal-session-mode")}
        description="The shell a new terminal opens. The new-terminal menu offers the other one."
        resetAction={
          settings.terminalSessionMode !== DEFAULT_UNIFIED_SETTINGS.terminalSessionMode ? (
            <SettingResetButton
              label="default terminal"
              onClick={() =>
                updateSettings({
                  terminalSessionMode: DEFAULT_UNIFIED_SETTINGS.terminalSessionMode,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.terminalSessionMode}
            onValueChange={(value) => {
              if (value === "shell" || value === "zmux") {
                updateSettings({ terminalSessionMode: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-52" aria-label="Default terminal">
              <SelectValue>{LAUNCH_MODE_LABELS[settings.terminalSessionMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="shell">
                {LAUNCH_MODE_LABELS.shell}
              </SelectItem>
              <SelectItem hideIndicator value="zmux">
                {LAUNCH_MODE_LABELS.zmux}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        {...searchableSetting("zmux-auto-sessions")}
        description="Give each new worktree its own zmux session, and restore it when a settled thread becomes active again. Follows the default terminal until set."
        resetAction={
          settings.zmuxAutoSessions !== DEFAULT_UNIFIED_SETTINGS.zmuxAutoSessions ? (
            <SettingResetButton
              label="automatic zmux sessions"
              onClick={() =>
                updateSettings({ zmuxAutoSessions: DEFAULT_UNIFIED_SETTINGS.zmuxAutoSessions })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={zmuxAutoSessionsEnabled(settings)}
            onCheckedChange={(checked) => updateSettings({ zmuxAutoSessions: Boolean(checked) })}
            aria-label="Create zmux sessions automatically"
          />
        }
      />
    </SettingsSection>
  );
}
