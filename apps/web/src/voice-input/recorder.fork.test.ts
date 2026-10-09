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

it("ducks outputs before capture and releases ducking as soon as the microphone stops", async () => {
  const { track } = microphoneFixture();
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {
    expect(track.stop).toHaveBeenCalled();
  });
  const recorder = new DesktopVoiceRecorderFork(vi.fn(), () => "", { start, stop });
  await recorder.prepareToRecordAsync();
  expect(start).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  recorder.record({ forDuration: 300 });
  await recorder.stop();
  expect(stop).toHaveBeenCalled();
});

it("releases the microphone and any partial ducking when output control fails", async () => {
  const { track } = microphoneFixture();
  const stop = vi.fn(async () => {});
  const recorder = new DesktopVoiceRecorderFork(vi.fn(), () => "", {
    start: async () => {
      throw new Error("Speaker unavailable");
    },
    stop,
  });
  await expect(recorder.prepareToRecordAsync()).rejects.toThrow("Speaker unavailable");
  expect(track.stop).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
});

it("restores ducking on the automatic recording limit", async () => {
  vi.useFakeTimers();
  microphoneFixture();
  const stop = vi.fn(async () => {});
  const recorder = new DesktopVoiceRecorderFork(vi.fn(), () => "", { start: async () => {}, stop });
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(stop).toHaveBeenCalled();
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

function liveMicrophoneFixture() {
  const microphone = microphoneFixture();
  const close = vi.fn(async () => {});
  const sent: string[] = [];
  const events = new EventTarget();
  const tail = new ArrayBuffer(128);
  const node = {
    port: {
      addEventListener: events.addEventListener.bind(events),
      start: vi.fn(),
      close: vi.fn(),
      postMessage: (message: string) => {
        sent.push(message);
        if (message === "stop") {
          events.dispatchEvent(new MessageEvent("message", { data: tail }));
          events.dispatchEvent(new MessageEvent("message", { data: "stopped" }));
        }
      },
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    addEventListener: vi.fn(),
  };
  vi.stubGlobal(
    "AudioContext",
    class {
      audioWorklet = { addModule: vi.fn(async () => {}) };
      destination = {};
      close = close;
      resume = async () => {};
      createAnalyser = () => ({ fftSize: 256 });
      createMediaStreamSource = () => ({ connect: vi.fn() });
    },
  );
  vi.stubGlobal("AudioWorkletNode", function () {
    return node;
  });
  let active = true;
  const live = {
    get active() {
      return active;
    },
    result: Promise.resolve("words"),
    send: vi.fn(),
    finish: vi.fn(() => {
      active = false;
    }),
    cancel: vi.fn(() => {
      active = false;
    }),
  };
  return { ...microphone, node, live, close, sent, tail };
}
it("flushes live PCM before ending input and releases the microphone without cancelling the final", async () => {
  const h = liveMicrophoneFixture();
  const status = vi.fn();
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.live.finish).toHaveBeenCalledOnce();
  });
  const recorder = new DesktopVoiceRecorderFork(status, () => "", { start, stop });
  recorder.useLiveSession(h.live);
  await recorder.prepareToRecordAsync();
  expect(start).toHaveBeenCalledOnce();
  recorder.record({ forDuration: 300 });
  await Promise.all([recorder.stop(), recorder.stop()]);
  expect(h.sent).toEqual(["start", "stop"]);
  expect(h.live.send).toHaveBeenCalledWith(h.tail);
  expect(h.live.send.mock.invocationCallOrder[0]).toBeLessThan(
    h.live.finish.mock.invocationCallOrder[0]!,
  );
  expect(h.live.finish).toHaveBeenCalledOnce();
  expect(h.live.cancel).not.toHaveBeenCalled();
  expect(h.track.stop).toHaveBeenCalledOnce();
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.node.port.close).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(status).toHaveBeenCalledOnce();
  recorder.delete(recorder.uri!);
});
it("cancels live capture on release and can then record through the upload path", async () => {
  const h = liveMicrophoneFixture();
  const stop = vi.fn(async () => {});
  const recorder = new DesktopVoiceRecorderFork(vi.fn(), () => "", { start: async () => {}, stop });
  recorder.useLiveSession(h.live);
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 300 });
  recorder.release();
  expect(h.live.cancel).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  recorder.delete(recorder.uri!);
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 300 });
  await recorder.stop();
  expect(await recorder.read(recorder.uri!).text()).toBe("recorded audio");
});
