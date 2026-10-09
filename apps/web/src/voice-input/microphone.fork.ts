const STORAGE_KEY = "t3.voice-input.microphone.fork";

/** Device IDs belong to this desktop, never the selected server environment. */
export function readVoiceMicrophoneFork(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveVoiceMicrophoneFork(deviceId: string) {
  window.localStorage.setItem(STORAGE_KEY, deviceId);
}

export function voiceMicrophoneConstraintsFork(deviceId: string): MediaStreamConstraints {
  return { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
}
