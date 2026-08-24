import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/** The workspace file trees' ignored-files toggle, on the General page. */
export function ShowIgnoredFilesSettingFork() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  return (
    <SettingsSection title="Files">
      <SettingsSwitchRow
        icon="eye"
        label="Show ignored files"
        value={AsyncResult.isSuccess(preferences) && preferences.value.showIgnoredFiles === true}
        onValueChange={(value) => savePreferences({ showIgnoredFiles: value })}
      />
    </SettingsSection>
  );
}
