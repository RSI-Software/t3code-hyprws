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
  private session: Promise<string | null> | null = null;
  start() {
    const settings = readVoiceDuckingFork();
    const bridge = window.desktopBridge?.voiceDuckingFork;
    if (!settings.enabled || !bridge || this.session) return;
    const id = randomUUID();
    this.session = bridge.start(id, settings).then(
      () => id,
      () => null,
    );
  }
  /** Waits for a start still in flight, so a quick cancel never leaves speakers ducked. */
  async stop() {
    const session = this.session;
    this.session = null;
    const id = await session;
    if (id) await window.desktopBridge?.voiceDuckingFork?.stop(id);
  }
}
