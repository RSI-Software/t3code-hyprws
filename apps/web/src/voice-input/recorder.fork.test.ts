import { afterEach, expect, it, vi } from "vite-plus/test";
import { DesktopVoiceRecorderFork, voiceWavFork } from "./recorder.fork";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("wraps captured PCM chunks in a mono 16 kHz WAV header", () => {
  const wav = voiceWavFork([new Int16Array([-32768, 0]).buffer, new Int16Array([32767]).buffer]);
  const view = new DataView(wav.buffer);
  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
  expect(view.getUint32(4, true)).toBe(wav.length - 8);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16_000);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(6);
  expect(Array.from(new Int16Array(wav.buffer, 44))).toEqual([-32768, 0, 32767]);
});

function microphoneFixture() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const close = vi.fn(async () => {});
  const sent: string[] = [];
  const events = new EventTarget();
  const tail = new Int16Array([1, 2, 3]).buffer;
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
  const analyser = {
    fftSize: 0,
    getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
  };
  vi.stubGlobal(
    "AudioContext",
    class {
      audioWorklet = { addModule: vi.fn(async () => {}) };
      destination = {};
      close = close;
      resume = async () => {};
      createAnalyser = () => analyser;
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
    result: Promise.resolve({ text: "words" }),
    send: vi.fn(),
    finish: vi.fn(() => {
      active = false;
    }),
    cancel: vi.fn(() => {
      active = false;
    }),
  };
  return { track, getUserMedia, node, live, close, sent, tail };
}

it("releases the microphone on Stop, keeps the WAV, and deletes it", async () => {
  const h = microphoneFixture();
  const status = vi.fn();
  const recorder = new DesktopVoiceRecorderFork(status);
  await recorder.prepareToRecordAsync();
  const uri = recorder.uri!;
  recorder.record({ forDuration: 300 });
  await recorder.stop();
  expect(h.track.stop).toHaveBeenCalledOnce();
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.node.port.close).toHaveBeenCalledOnce();
  expect(recorder.read(uri)).toEqual(voiceWavFork([h.tail]));
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

it("releases a stream when capture setup fails", async () => {
  const { track } = microphoneFixture();
  vi.stubGlobal("AudioWorkletNode", function () {
    throw new Error("unsupported");
  });
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

it("meters only while recording", async () => {
  microphoneFixture();
  const recorder = new DesktopVoiceRecorderFork(vi.fn());
  expect(recorder.readLevel()).toBe(0);
  await recorder.prepareToRecordAsync();
  expect(recorder.readLevel()).toBe(0);
  recorder.record({ forDuration: 300 });
  expect(recorder.readLevel()).toBeGreaterThan(0);
  expect(recorder.readLevel()).toBeLessThan(1);
  await recorder.stop();
  expect(recorder.readLevel()).toBe(0);
});

it("flushes live PCM before ending input and keeps the WAV for fallback", async () => {
  const h = microphoneFixture();
  const status = vi.fn();
  const recorder = new DesktopVoiceRecorderFork(status);
  recorder.useLiveSession(h.live);
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 300 });
  await Promise.all([recorder.stop(), recorder.stop()]);
  expect(h.sent).toEqual(["start", "stop"]);
  expect(h.live.send).toHaveBeenCalledWith(h.tail);
  expect(h.live.send.mock.invocationCallOrder[0]).toBeLessThan(
    h.live.finish.mock.invocationCallOrder[0]!,
  );
  expect(h.live.finish).toHaveBeenCalledOnce();
  expect(h.live.cancel).not.toHaveBeenCalled();
  expect(recorder.read(recorder.uri!)).toEqual(voiceWavFork([h.tail]));
  expect(status).toHaveBeenCalledOnce();
});

it("keeps recording when the live session drops", async () => {
  const h = microphoneFixture();
  const recorder = new DesktopVoiceRecorderFork(vi.fn());
  recorder.useLiveSession(h.live);
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 300 });
  h.live.cancel();
  await recorder.stop();
  expect(h.live.send).not.toHaveBeenCalled();
  expect(h.live.finish).not.toHaveBeenCalled();
  expect(recorder.read(recorder.uri!)).toEqual(voiceWavFork([h.tail]));
});

it("cancels live capture on release", async () => {
  const h = microphoneFixture();
  const recorder = new DesktopVoiceRecorderFork(vi.fn());
  recorder.useLiveSession(h.live);
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 300 });
  recorder.release();
  expect(h.live.cancel).toHaveBeenCalledOnce();
  expect(h.track.stop).toHaveBeenCalledOnce();
});
