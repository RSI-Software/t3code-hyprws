import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";
import { readVoiceMicrophoneFork, voiceMicrophoneConstraintsFork } from "./microphone.fork";
import pcmWorkletUrl from "./pcm.worklet.fork.ts?worker&url";
import type { LiveVoiceSessionFork } from "./realtime.fork";
import { VoiceRecorderDuckingFork } from "./ducking.fork";

/** Mono PCM16 at 16 kHz is accepted by every implemented dictation adapter. */
export function voiceWavFork(chunks: ReadonlyArray<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(44 + length);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, length, true);
  let offset = 44;
  for (const chunk of chunks) {
    bytes.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * One PCM capture feeds the optional live session and the in-memory WAV that batch
 * transcription uploads; tracks stop before upload.
 */
export class DesktopVoiceRecorderFork implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private pcm: AudioWorkletNode | null = null;
  private meter: { analyser: AnalyserNode; samples: Float32Array<ArrayBuffer> } | null = null;
  private chunks: ArrayBuffer[] = [];
  private wav: Uint8Array<ArrayBuffer> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private live: LiveVoiceSessionFork | null = null;
  private flush: (() => void) | null = null;
  private recording = false;
  private stopping: Promise<void> | null = null;
  private restoration: Promise<void> = Promise.resolve();

  constructor(
    private readonly onStatus: (status: VoiceRecorderStatus) => void,
    private readonly readMicrophone = readVoiceMicrophoneFork,
    private readonly ducking: Pick<
      VoiceRecorderDuckingFork,
      "start" | "stop"
    > = new VoiceRecorderDuckingFork(),
  ) {}

  useLiveSession(session: LiveVoiceSessionFork | null) {
    this.live?.cancel();
    this.live = session;
  }

  async prepareToRecordAsync() {
    this.stream = await navigator.mediaDevices.getUserMedia(
      voiceMicrophoneConstraintsFork(this.readMicrophone()),
    );
    try {
      // The device rate: the worklet downsamples, since Firefox rejects 16 kHz microphone graphs.
      const context = (this.context = new AudioContext());
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      this.meter = { analyser, samples: new Float32Array(analyser.fftSize) };
      await context.audioWorklet.addModule(pcmWorkletUrl);
      this.pcm = new AudioWorkletNode(context, "voice-pcm-fork", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.pcm.port.addEventListener("message", ({ data }) => {
        if (data === "stopped") this.flush?.();
        else if (data instanceof ArrayBuffer) {
          this.chunks.push(data);
          if (this.live?.active) this.live.send(data);
        }
      });
      this.pcm.port.start();
      this.pcm.addEventListener("processorerror", () =>
        this.onStatus({
          isFinished: false,
          hasError: true,
          error: "Microphone recording failed.",
          url: this.uri,
        }),
      );
      const source = context.createMediaStreamSource(this.stream);
      source.connect(analyser);
      source.connect(this.pcm);
      // The processor emits silence; a destination keeps it pulling microphone frames.
      this.pcm.connect(context.destination);
      await context.resume();
      await this.ducking.start();
      this.uri = String(++this.sequence);
      this.chunks = [];
      this.wav = null;
      this.stopping = null;
    } catch (error) {
      this.release();
      throw error;
    }
  }

  record({ forDuration }: { readonly forDuration: number }) {
    if (!this.pcm) throw new Error("Microphone is not prepared.");
    this.recording = true;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Private MessagePort, not Window.
    this.pcm.port.postMessage("start");
    this.timer = setTimeout(() => {
      void this.stop().catch(() =>
        this.onStatus({
          isFinished: false,
          hasError: true,
          error: "Could not finish microphone recording.",
          url: this.uri,
        }),
      );
    }, forDuration * 1000);
  }

  stop() {
    this.stopping ??= this.finishRecording();
    return this.stopping;
  }

  private async finishRecording() {
    const wasRecording = this.recording;
    this.recording = false;
    try {
      if (wasRecording && this.pcm) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Could not stop microphone.")), 2000);
          this.flush = () => {
            clearTimeout(timer);
            resolve();
          };
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Private MessagePort, not Window.
          this.pcm!.port.postMessage("stop");
        });
        this.wav = voiceWavFork(this.chunks);
        this.chunks = [];
        if (this.live?.active) this.live.finish();
      }
    } finally {
      this.flush = null;
      this.release();
      await this.restoration;
    }
    if (wasRecording)
      this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri });
  }

  release() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.recording = false;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.live?.active) this.live.cancel();
    this.live = null;
    this.pcm?.disconnect();
    this.pcm?.port.close();
    this.pcm = null;
    this.meter = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    this.restoration = Promise.all([this.restoration, this.ducking.stop()])
      .then(() => {})
      .catch((error) => {
        console.warn("Could not restore speaker output after dictation:", error);
      });
  }

  /** Meter only while the recording toolbar is visible; never connects to speakers. */
  readLevel() {
    if (!this.recording || !this.meter) return 0;
    const { analyser, samples } = this.meter;
    analyser.getFloatTimeDomainData(samples);
    const amplitude = Math.sqrt(
      samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
    );
    return Math.sqrt(Math.max(0, Math.min(1, (amplitude - 0.001) / 0.999)));
  }

  read(uri: string) {
    if (this.uri !== uri || !this.wav) throw new Error("Recording is no longer available.");
    return this.wav;
  }

  delete(uri: string) {
    if (this.uri !== uri) return;
    this.wav = null;
    this.chunks = [];
    this.uri = null;
    this.live?.cancel();
    this.live = null;
    this.stopping = null;
  }
}
