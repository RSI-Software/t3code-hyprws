import { afterEach, expect, it, vi } from "vite-plus/test";
import { DesktopVoiceRecorderFork, encodeVoiceWavFork } from "./recorder.fork";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("encodes bounded signed PCM with a mono 16 kHz WAV header", () => {
  const wav = encodeVoiceWavFork(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]));
  const view = new DataView(wav.buffer);
  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
  expect(view.getUint32(4, true)).toBe(wav.length - 8);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16_000);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(14);
  expect(Array.from({ length: 7 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([
    -32768, -32768, -16384, 0, 16384, 32767, 32767,
  ]);
});

function microphoneFixture() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  class Recorder {
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["recorded audio"]) });
      this.onstop?.();
    }
  }
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", Recorder);
  return { track, getUserMedia };
}

it("releases the microphone on Stop and deletes the in-memory recording", async () => {
  const { track } = microphoneFixture();
  const status = vi.fn();
  const recorder = new DesktopVoiceRecorderFork(status);
  await recorder.prepareToRecordAsync();
  const uri = recorder.uri!;
  recorder.record({ forDuration: 300 });
  await recorder.stop();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(await recorder.read(uri).text()).toBe("recorded audio");
  expect(status).toHaveBeenCalledWith({ isFinished: true, hasError: false, error: null, url: uri });
  recorder.delete(uri);
  expect(() => recorder.read(uri)).toThrow("no longer available");
});

it("stops automatically at the recording limit", async () => {
  vi.useFakeTimers();
  const { track } = microphoneFixture();
  const status = vi.fn();
  const recorder = new DesktopVoiceRecorderFork(status);
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 300 });
  await vi.advanceTimersByTimeAsync(300_000);
  expect(track.stop).toHaveBeenCalledOnce();
  expect(status).toHaveBeenCalledOnce();
});

it("releases a stream when MediaRecorder construction fails", async () => {
  const { track } = microphoneFixture();
  vi.stubGlobal(
    "MediaRecorder",
    class {
      constructor() {
        throw new Error("unsupported");
      }
    },
  );
  const recorder = new DesktopVoiceRecorderFork(vi.fn());
  await expect(recorder.prepareToRecordAsync()).rejects.toThrow("unsupported");
  expect(track.stop).toHaveBeenCalledOnce();
});

it("records from the selected microphone and reads changes on the next recording", async () => {
  const { getUserMedia } = microphoneFixture();
  let deviceId = "usb-mic";
  const recorder = new DesktopVoiceRecorderFork(vi.fn(), () => deviceId);
  await recorder.prepareToRecordAsync();
  expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: "usb-mic" } } });
  recorder.release();
  deviceId = "";
  await recorder.prepareToRecordAsync();
  expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true });
  recorder.release();
});

it("reports an unavailable selected microphone instead of recording from another device", async () => {
  const { getUserMedia } = microphoneFixture();
  getUserMedia.mockRejectedValueOnce(new DOMException("Device missing", "NotFoundError"));
  const recorder = new DesktopVoiceRecorderFork(vi.fn(), () => "unplugged-mic");
  await expect(recorder.prepareToRecordAsync()).rejects.toThrow("Device missing");
  expect(getUserMedia).toHaveBeenCalledOnce();
});

it("meters the active microphone and closes its audio context on Stop", async () => {
  microphoneFixture();
  const close = vi.fn(async () => {});
  const connect = vi.fn();
  const analyser = {
    fftSize: 0,
    getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
  };
  vi.stubGlobal(
    "AudioContext",
    class {
      close = close;
      createAnalyser = () => analyser;
      createMediaStreamSource = () => ({ connect });
    },
  );
  const recorder = new DesktopVoiceRecorderFork(vi.fn());
  expect(recorder.readLevel()).toBe(0);
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 300 });
  expect(recorder.readLevel()).toBeGreaterThan(0);
  expect(recorder.readLevel()).toBeLessThan(1);
  expect(connect).toHaveBeenCalledOnce();
  await recorder.stop();
  expect(close).toHaveBeenCalledOnce();
  expect(recorder.readLevel()).toBe(0);
});
