declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** Chromium resamples the AudioContext to 16 kHz; emit 80 ms mono PCM16 frames. */
export class VoicePcmProcessorFork extends AudioWorkletProcessor {
  private recording = false;
  private frame = new ArrayBuffer(2560);
  private view = new DataView(this.frame);
  private offset = 0;
  private samples = 0;
  constructor() {
    super();
    if (sampleRate !== 16000) throw new Error("Expected 16 kHz audio.");
    this.port.addEventListener("message", ({ data }) => {
      if (data === "start") this.recording = true;
      if (data === "stop") {
        this.recording = false;
        if (this.offset) this.emit();
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Private MessagePort, not Window.
        this.port.postMessage("stopped");
      }
    });
    this.port.start();
  }
  private emit() {
    const audio = this.frame.slice(0, this.offset);
    this.port.postMessage(audio, [audio]);
    this.frame = new ArrayBuffer(2560);
    this.view = new DataView(this.frame);
    this.offset = 0;
  }
  process(inputs: Float32Array[][]) {
    const channels = inputs[0];
    if (!this.recording || !channels?.length) return true;
    for (let i = 0; i < channels[0]!.length; i++) {
      if (this.samples++ === 16000 * 300) {
        this.recording = false;
        break;
      }
      let sample = 0;
      for (const channel of channels) sample += (channel[i] ?? 0) / channels.length;
      sample = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(this.offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      this.offset += 2;
      if (this.offset === this.frame.byteLength) this.emit();
    }
    return true;
  }
}
registerProcessor("voice-pcm-fork", VoicePcmProcessorFork);
