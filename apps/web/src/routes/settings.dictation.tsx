// Fork-owned desktop dictation settings.
import { createFileRoute } from "@tanstack/react-router";
import { VoiceInputSettingsFork } from "../components/settings/VoiceInputSettings.fork";
import { VoiceMicrophoneSettingsFork } from "../components/settings/VoiceMicrophoneSettings.fork";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function DictationSettingsRoute() {
  const { scope, environment } = useSettingsScope();
  const environmentId =
    scope.environmentIds.length === 1 ? (environment?.environmentId ?? null) : null;
  return (
    <SettingsPageContainer>
      {window.desktopBridge ? (
        <>
          <VoiceMicrophoneSettingsFork />
          <VoiceInputSettingsFork key={environmentId ?? "none"} environmentId={environmentId} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Dictation is available in the desktop app.</p>
      )}
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/dictation")({ component: DictationSettingsRoute });
