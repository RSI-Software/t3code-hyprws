import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";
import { readVoiceMicrophoneFork, voiceMicrophoneConstraintsFork } from "./microphone.fork";
import pcmWorkletUrl from "./pcm.worklet.fork.ts?worker&url";
import type { LiveVoiceSessionFork } from "./realtime.fork";
import { VoiceRecorderDuckingFork } from "./ducking.fork";

/** Mono PCM16 at 16 kHz is accepted by every implemented dictation adapter. */
export function encodeVoiceWavFork(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
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
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export async function recordingToWavFork(blob: Blob, signal: AbortSignal) {
  signal.throwIfAborted();
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await context.close();
  }
  signal.throwIfAborted();
  if (decoded.duration > 300 || decoded.length === 0) throw new Error("Invalid recording length.");
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16_000), 16_000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const mono = await offline.startRendering();
  signal.throwIfAborted();
  return encodeVoiceWavFork(mono.getChannelData(0));
}

/** Recordings stay in memory; tracks stop before conversion or upload. */
export class DesktopVoiceRecorderFork implements VoiceRecorder {
  uri: string | null = null;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private blob: Blob | null = null;
  private finished: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private live: LiveVoiceSessionFork | null = null;
  private pcm: AudioWorkletNode | null = null;
  private flush: (() => void) | null = null;
  private liveRecording = false;
  private stopping: Promise<void> | null = null;
  private restoration: Promise<void> = Promise.resolve();
  private meter: {
    context: AudioContext;
    analyser: AnalyserNode;
    samples: Float32Array<ArrayBuffer>;
  } | null = null;

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
      if (this.live) {
        const context = new AudioContext({ sampleRate: 16000 });
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        this.meter = { context, analyser, samples: new Float32Array(analyser.fftSize) };
        await context.audioWorklet.addModule(pcmWorkletUrl);
        this.pcm = new AudioWorkletNode(context, "voice-pcm-fork", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        this.pcm.port.addEventListener("message", ({ data }) => {
          if (data === "stopped") this.flush?.();
          else if (data instanceof ArrayBuffer && this.live?.active) this.live.send(data);
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
        this.stopping = null;
        return;
      }
      this.recorder = new MediaRecorder(this.stream);
      await this.ducking.start();
      this.uri = String(++this.sequence);
      this.chunks = [];
      this.blob = null;
      this.finished = new Promise<void>((resolve) => {
        this.recorder!.ondataavailable = (event) => {
          if (event.data.size) this.chunks.push(event.data);
        };
        this.recorder!.onerror = () => {
          this.release();
          resolve();
          this.onStatus({
            isFinished: false,
            hasError: true,
            error: "Microphone recording failed.",
            url: this.uri,
          });
        };
        this.recorder!.onstop = () => {
          this.blob = new Blob(this.chunks, { type: this.recorder?.mimeType ?? "" });
          this.chunks = [];
          this.release();
          resolve();
          this.onStatus({ isFinished: true, hasError: false, error: null, url: this.uri });
        };
      });
    } catch (error) {
      this.release();
      throw error;
    }
  }

  record({ forDuration }: { readonly forDuration: number }) {
    if (this.live) {
      if (!this.pcm || !this.live.active) throw new Error("Live dictation is not ready.");
      this.liveRecording = true;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Private MessagePort, not Window.
      this.pcm.port.postMessage("start");
    } else {
      if (!this.recorder) throw new Error("Microphone is not prepared.");
      this.recorder.start(1000);
    }
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

  async stop() {
    if (this.live && this.pcm) {
      this.stopping ??= this.stopLive();
      return this.stopping;
    }
    if (this.recorder?.state !== "inactive") this.recorder?.stop();
    this.release();
    if (this.finished) await this.finished;
    await this.restoration;
  }

  private async stopLive() {
    const wasRecording = this.liveRecording;
    this.liveRecording = false;
    try {
      if (wasRecording && this.live?.active) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Could not stop microphone.")), 2000);
          this.flush = () => {
            clearTimeout(timer);
            resolve();
          };
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Private MessagePort, not Window.
          this.pcm!.port.postMessage("stop");
        });
        this.live.finish();
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
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.live?.active) this.live.cancel();
    this.live = null;
    this.pcm?.disconnect();
    this.pcm?.port.close();
    this.pcm = null;
    this.restoration = Promise.all([this.restoration, this.ducking.stop()])
      .then(() => {})
      .catch((error) => {
        console.warn("Could not restore speaker output after dictation:", error);
      });
    if (this.meter) {
      void this.meter.context.close().catch(() => {});
      this.meter = null;
    }
  }

  /** Meter only while the recording toolbar is visible; never connects to speakers. */
  readLevel() {
    if (!this.stream || (!this.liveRecording && this.recorder?.state !== "recording")) return 0;
    if (!this.meter) {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(this.stream).connect(analyser);
      this.meter = { context, analyser, samples: new Float32Array(analyser.fftSize) };
    }
    const { analyser, samples } = this.meter;
    analyser.getFloatTimeDomainData(samples);
    const amplitude = Math.sqrt(
      samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
    );
    return Math.sqrt(Math.max(0, Math.min(1, (amplitude - 0.001) / 0.999)));
  }

  read(uri: string) {
    if (this.uri !== uri || !this.blob) throw new Error("Recording is no longer available.");
    return this.blob;
  }

  delete(uri: string) {
    if (this.uri !== uri) return;
    this.blob = null;
    this.chunks = [];
    this.uri = null;
    this.recorder = null;
    this.finished = null;
    this.live?.cancel();
    this.live = null;
    this.stopping = null;
  }
}
