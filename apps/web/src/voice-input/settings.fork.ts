import type { VoiceInputSettingsFork } from "@t3tools/contracts";

/** Browsers need a secure origin and recording APIs; Electron exposes the same APIs. */
export function voiceRecordingUnavailableReasonFork() {
  if (!window.isSecureContext) return "Microphone access requires HTTPS or localhost.";
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
    return "This client does not support microphone recording.";
  return null;
}

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
