import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("emits paced little-endian PCM frames, downmixes channels, and flushes the tail", async () => {
  const emitted: Array<ArrayBuffer | string> = [];
  const port = {
    onmessage: null as ((event: { data: string }) => void) | null,
    addEventListener: (_type: string, listener: (event: { data: string }) => void) => {
      port.onmessage = listener;
    },
    start: () => {},
    postMessage: (data: ArrayBuffer | string) => emitted.push(data),
  };
  let Processor: (new () => { process(inputs: Float32Array[][]): boolean }) | undefined;
  vi.stubGlobal("sampleRate", 16000);
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      port = port;
    },
  );
  vi.stubGlobal(
    "registerProcessor",
    (_name: string, constructor: NonNullable<typeof Processor>) => {
      Processor = constructor;
    },
  );
  await import("./pcm.worklet.fork");
  const processor = new Processor!();
  processor.process([[new Float32Array(1280).fill(1)]]);
  expect(emitted).toEqual([]);
  port.onmessage?.({ data: "start" });
  processor.process([[new Float32Array(1280).fill(2), new Float32Array(1280).fill(-1)]]);
  expect(emitted).toHaveLength(1);
  expect((emitted[0] as ArrayBuffer).byteLength).toBe(2560);
  expect(new DataView(emitted[0] as ArrayBuffer).getInt16(0, true)).toBe(16384);
  processor.process([[new Float32Array([-2, 0, 2])]]);
  port.onmessage?.({ data: "stop" });
  expect(Array.from(new Int16Array(emitted[1] as ArrayBuffer))).toEqual([-32768, 0, 32767]);
  expect(emitted[2]).toBe("stopped");
  processor.process([[new Float32Array(1280).fill(1)]]);
  expect(emitted).toHaveLength(3);
});
