import { VOICE_INPUT_MAX_BYTES_FORK } from "@t3tools/contracts";

/** Accept the shared upload format: mono PCM16 WAV, 16 or 24 kHz, at most five minutes. */
export function isVoiceRecordingFork(audio: Uint8Array): boolean {
  if (audio.byteLength < 44 || audio.byteLength > VOICE_INPUT_MAX_BYTES_FORK) return false;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const tag = (at: number) => String.fromCharCode(...audio.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== audio.byteLength)
    return false;
  let rate = 0;
  let dataBytes = 0;
  let at = 12;
  for (; at + 8 <= audio.byteLength;) {
    const size = view.getUint32(at + 4, true);
    const end = at + 8 + size;
    if (end > audio.byteLength) return false;
    if (tag(at) === "fmt ") {
      if (size < 16 || rate !== 0) return false;
      rate = view.getUint32(at + 12, true);
      if (
        view.getUint16(at + 8, true) !== 1 ||
        view.getUint16(at + 10, true) !== 1 ||
        view.getUint16(at + 22, true) !== 16 ||
        view.getUint16(at + 20, true) !== 2 ||
        view.getUint32(at + 16, true) !== rate * 2 ||
        (rate !== 16000 && rate !== 24000)
      )
        return false;
    }
    if (tag(at) === "data") {
      if (dataBytes !== 0 || size === 0 || size % 2 !== 0) return false;
      dataBytes = size;
    }
    at = end + (size % 2);
  }
  return at === audio.byteLength && rate > 0 && dataBytes > 0 && dataBytes <= rate * 2 * 300;
}
