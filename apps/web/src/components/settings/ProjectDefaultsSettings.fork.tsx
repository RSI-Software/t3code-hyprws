// Fork-owned: the worktrunk-aware workspace mode row
// (fix(web): carry the fork thread-env mode through the project-scope path).
// The upstream `ProjectDefaultsSettings.tsx` carries only marked hook lines
// pointing here: the decoded mode hook, the reset action, and the select
// control.
import type { ReactNode } from "react";
import { DEFAULT_SERVER_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import type { StoredThreadEnvMode } from "@t3tools/shared/threadEnvMode.fork";
import {
  fromWireThreadEnvModeFields,
  isWorktreeEnvMode,
  toWireThreadEnvModeOverrideFields,
} from "@t3tools/shared/threadEnvMode.fork";

import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { ScopedSettingsPatch } from "./scopedSettings";
import { SettingResetButton } from "./settingsLayout";

/** The exact stored workspace mode, decoded from the wire slot plus its sibling. */
export const useWorkspaceEnvModeFork = (
  settings: UnifiedSettings,
): StoredThreadEnvMode | null | undefined => fromWireThreadEnvModeFields(settings);

/** The workspace row's reset action, shown only when the mode differs from the default. */
export const useWorkspaceEnvModeResetActionFork = (
  workspaceEnvMode: StoredThreadEnvMode | null | undefined,
  updateSettings: (patch: ScopedSettingsPatch) => void,
): ReactNode => {
  if (workspaceEnvMode === DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode) return null;
  return (
    <SettingResetButton
      label="default workspace"
      onClick={() =>
        updateSettings(
          toWireThreadEnvModeOverrideFields(
            DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode,
          ) as ScopedSettingsPatch,
        )
      }
    />
  );
};

/** The workspace row's mode picker, including the worktrunk option. */
export const useWorkspaceEnvModeSelectFork = (
  mixedWorkspace: boolean,
  workspaceEnvMode: StoredThreadEnvMode | null | undefined,
  unavailable: boolean,
  updateSettings: (patch: ScopedSettingsPatch) => void,
): ReactNode => {
  return (
    <Select
      value={mixedWorkspace ? null : workspaceEnvMode}
      onValueChange={(value) => {
        const mode = value as StoredThreadEnvMode;
        if (mode === "local" || isWorktreeEnvMode(mode))
          updateSettings(toWireThreadEnvModeOverrideFields(mode) as ScopedSettingsPatch);
      }}
    >
      <SelectTrigger size="sm" aria-label="Default workspace">
        <SelectValue>
          {(value: string | null) =>
            value === "local" || isWorktreeEnvMode(value as StoredThreadEnvMode)
              ? resolveEnvModeLabel(value as StoredThreadEnvMode)
              : unavailable
                ? "Unavailable"
                : "Mixed"
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
        <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
        <SelectItem value="worktrunk">{resolveEnvModeLabel("worktrunk")}</SelectItem>
      </SelectPopup>
    </Select>
  );
};
