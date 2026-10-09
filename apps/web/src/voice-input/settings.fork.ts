import type { VoiceInputSettingsFork } from "@t3tools/contracts";

/** A saved configuration must be usable before opening the microphone. */
export function voiceInputUnavailableReasonFork(settings: VoiceInputSettingsFork | null) {
  if (!settings) return "Loading dictation settings…";
  if (!settings.enabled) return "Enable dictation in Settings.";
  if (!settings.providers.some((p) => p.id === settings.provider && p.available))
    return "Choose an available speech service in Settings.";
  if (!settings.endpoint.trim()) return "Set the dictation endpoint in Settings.";
  if (settings.provider !== "local" && !settings.model.trim())
    return "Set the dictation model in Settings.";
  if (settings.provider === "meta" && !settings.hasApiKey) return "Add a Meta API key in Settings.";
  return null;
}
