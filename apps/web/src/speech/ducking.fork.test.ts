/// <reference lib="es2024.promise" />
import { DEFAULT_VOICE_DUCKING_SETTINGS_FORK } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { MemoryStorage } from "../testStorage.fork";
import { VoiceRecorderDuckingFork } from "./ducking.fork";

/** A desktop bridge whose `start` settles only when the test says so. */
function stubBridge() {
  const localStorage = new MemoryStorage();
  localStorage.setItem(
    "t3.voice-input.ducking.fork",
    JSON.stringify({ ...DEFAULT_VOICE_DUCKING_SETTINGS_FORK, enabled: true }),
  );
  const started = Promise.withResolvers<void>();
  const bridge = {
    listOutputs: vi.fn(),
    start: vi.fn((_id: string) => started.promise),
    stop: vi.fn(async (_id: string) => undefined),
  };
  vi.stubGlobal("window", { localStorage, desktopBridge: { voiceDuckingFork: bridge } });
  return { bridge, started };
}

describe("speaker ducking while recording", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores speakers once when a recording ends before ducking starts", async () => {
    const { bridge, started } = stubBridge();
    const ducking = new VoiceRecorderDuckingFork();
    ducking.start();
    const stopped = Promise.all([ducking.stop(), ducking.stop()]);
    expect(bridge.stop).not.toHaveBeenCalled();
    started.resolve();
    await stopped;
    expect(bridge.stop.mock.calls).toEqual([[bridge.start.mock.calls[0]?.[0]]]);
  });

  it("restores nothing when ducking never started", async () => {
    const { bridge, started } = stubBridge();
    const ducking = new VoiceRecorderDuckingFork();
    ducking.start();
    started.reject(new Error("no outputs"));
    await ducking.stop();
    expect(bridge.stop).not.toHaveBeenCalled();
  });
});
