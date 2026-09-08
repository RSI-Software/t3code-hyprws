// Fork-owned seam for the external workspace symlinks settings row
// (RSI-Software/t3code-hyprws#951, reshaping 565594bd75).
//
// Everything the fork renders for this setting lives here: the General-panel
// row mounts `ExternalSymlinksSettingsRowFork` through one marked JSX hook in
// `SettingsPanels.tsx`, and the restore-label entry comes from
// `externalSymlinksRestoreLabelFork`. The row is server-scoped: the policy is
// server-authoritative, so one toggle covers every project on the server.
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import type { UnifiedSettings } from "@t3tools/contracts";

import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { Switch } from "../ui/switch";

/** Restore-dialog label shown when the global symlink toggle differs from its default. */
export const externalSymlinksRestoreLabelFork = (settings: UnifiedSettings): Array<string> =>
  settings.followExternalWorkspaceSymlinks !==
  DEFAULT_UNIFIED_SETTINGS.followExternalWorkspaceSymlinks
    ? ["External workspace symlinks"]
    : [];

/** The Settings → General row for following external workspace symlinks. */
export function ExternalSymlinksSettingsRowFork() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("external-workspace-symlinks")}
      description="Allow file previews to follow symlinks whose targets are outside the project. Applies to every project on this server."
      resetAction={
        settings.followExternalWorkspaceSymlinks !==
        DEFAULT_UNIFIED_SETTINGS.followExternalWorkspaceSymlinks ? (
          <SettingResetButton
            label="external workspace symlinks"
            onClick={() =>
              updateSettings({
                followExternalWorkspaceSymlinks:
                  DEFAULT_UNIFIED_SETTINGS.followExternalWorkspaceSymlinks,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.followExternalWorkspaceSymlinks}
          onCheckedChange={(checked) =>
            updateSettings({ followExternalWorkspaceSymlinks: Boolean(checked) })
          }
          aria-label="Follow external workspace symlinks"
        />
      }
    />
  );
}
