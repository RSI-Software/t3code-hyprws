// Fork seam for the external workspace symlinks settings row, mounted through one
// marked JSX hook in `SettingsPanels.tsx`; the restore label comes from
// `externalSymlinksRestoreLabelFork`. The row is server-scoped: the policy is
// server-authoritative, so one toggle covers every project on the server.
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";

import type { UnifiedSettings } from "@t3tools/contracts";

import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
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
  const searchableSetting = useSearchableSetting();
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
            ariaLabel="Reset external workspace symlinks to default"
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

/** The Settings → General row for showing gitignored paths in workspace file trees. */
export function ShowIgnoredFilesSettingsRowFork() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      {...searchableSetting("show-ignored-files")}
      description="Include gitignored paths in workspace file trees. They remain hidden by default."
      resetAction={
        settings.showIgnoredFiles !== DEFAULT_UNIFIED_SETTINGS.showIgnoredFiles ? (
          <SettingResetButton
            ariaLabel="Reset ignored files to default"
            onClick={() =>
              updateSettings({ showIgnoredFiles: DEFAULT_UNIFIED_SETTINGS.showIgnoredFiles })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.showIgnoredFiles}
          onCheckedChange={(checked) => updateSettings({ showIgnoredFiles: Boolean(checked) })}
          aria-label="Show ignored files in workspace file trees"
        />
      }
    />
  );
}
