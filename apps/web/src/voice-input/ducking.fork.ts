import { DEFAULT_VOICE_DUCKING_SETTINGS_FORK, VoiceDuckingSettingsFork } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { randomUUID } from "../lib/utils";

const STORAGE_KEY = "t3.voice-input.ducking.fork";
export const VOICE_DUCKING_CHANGED_FORK = "t3:voice-ducking-changed-fork";
const decodeSettings = Schema.decodeUnknownSync(VoiceDuckingSettingsFork);
const validateSettings = Schema.decodeSync(VoiceDuckingSettingsFork);

export function readVoiceDuckingFork(): VoiceDuckingSettingsFork {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? decodeSettings(JSON.parse(raw)) : DEFAULT_VOICE_DUCKING_SETTINGS_FORK;
  } catch {
    return DEFAULT_VOICE_DUCKING_SETTINGS_FORK;
  }
}

export function saveVoiceDuckingFork(settings: VoiceDuckingSettingsFork) {
  const valid = validateSettings(settings);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(valid));
  window.dispatchEvent(new Event(VOICE_DUCKING_CHANGED_FORK));
}

/** Settings and output IDs belong to the recording desktop, not the transcription server. */
export class VoiceRecorderDuckingFork {
  private sessionId: string | null = null;
  async start() {
    const settings = readVoiceDuckingFork();
    if (!settings.enabled) return;
    const bridge = window.desktopBridge?.voiceDuckingFork;
    if (!bridge) throw new Error("Speaker ducking requires a newer desktop build.");
    const id = randomUUID();
    await bridge.start(id, settings);
    this.sessionId = id;
  }
  async stop() {
    const id = this.sessionId;
    this.sessionId = null;
    if (id) await window.desktopBridge?.voiceDuckingFork?.stop(id);
  }
}
