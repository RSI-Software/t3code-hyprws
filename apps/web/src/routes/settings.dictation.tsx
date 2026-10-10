// Fork-owned dictation settings.
import { createFileRoute } from "@tanstack/react-router";
import { VoiceInputSettingsFork } from "../components/settings/VoiceInputSettings.fork";
import { VoiceMicrophoneSettingsFork } from "../components/settings/VoiceMicrophoneSettings.fork";
import { VoiceDuckingSettingsFork } from "../components/settings/VoiceDuckingSettings.fork";
import { VoiceTextSettingsFork } from "../components/settings/VoiceTextSettings.fork";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function DictationSettingsRoute() {
  const { scope, environment, targets } = useSettingsScope();
  const environmentId =
    scope.environmentIds.length === 1 ? (environment?.environmentId ?? null) : null;
  return (
    <SettingsPageContainer>
      <VoiceMicrophoneSettingsFork />
      {window.desktopBridge ? <VoiceDuckingSettingsFork /> : null}
      <VoiceInputSettingsFork key={environmentId ?? "none"} environmentId={environmentId} />
      {environmentId ? (
        <VoiceTextSettingsFork
          key={`${environmentId}:${targets[0]?.projectId ?? "all"}`}
          environmentId={environmentId}
          projectId={targets.length === 1 ? (targets[0]?.projectId ?? null) : null}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/dictation")({ component: DictationSettingsRoute });
