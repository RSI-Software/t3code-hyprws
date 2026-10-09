import { afterEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_VOICE_DUCKING_SETTINGS_FORK } from "@t3tools/contracts";
import { SpeakerDuckingFork } from "./ducking.fork.ts";
import type { AudioOutputFork } from "./audioOutputs.fork.ts";

afterEach(() => vi.useRealTimers());
const settings = { ...DEFAULT_VOICE_DUCKING_SETTINGS_FORK, enabled: true };
function fixture() {
  const devices: AudioOutputFork[] = [
    { id: "speakers", label: "Speakers", isDefault: true, volumes: [60000, 30000] },
    { id: "headphones", label: "Headphones", isDefault: false, volumes: [10000, 10000] },
  ];
  const write = vi.fn(async (id: string, volumes: readonly number[]) => {
    const index = devices.findIndex((device) => device.id === id);
    if (index < 0) throw new Error("Output disconnected");
    devices[index] = { ...devices[index]!, volumes: [...volumes] };
    return devices[index]!.volumes;
  });
  const list = vi.fn(async () =>
    devices.map((device) => ({ ...device, volumes: [...device.volumes] })),
  );
  const error = vi.fn();
  const manager = new SpeakerDuckingFork({ list, setVolumes: write }, error);
  return {
    manager,
    devices,
    write,
    list,
    error,
    volume: (id = "speakers") => devices.find((device) => device.id === id)!.volumes,
  };
}

it("ducks only selected outputs relative to their own volume, preserving channel balance", async () => {
  const f = fixture();
  await f.manager.start(1, "recording", {
    ...settings,
    outputIds: ["speakers", "headphones"],
    fadeUpMs: 0,
  });
  expect(f.volume()).toEqual([12000, 6000]);
  expect(f.volume("headphones")).toEqual([2000, 2000]);
  await f.manager.stop(1, "recording");
  expect(f.volume()).toEqual([60000, 30000]);
  expect(f.volume("headphones")).toEqual([10000, 10000]);
  await f.manager.close();
});

it("has independent fade-down and fade-up durations", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.manager.start(1, "recording", { ...settings, fadeDownMs: 200, fadeUpMs: 1000 });
  expect(f.volume()).toEqual([60000, 30000]);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.volume()).toEqual([36000, 18000]);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.volume()).toEqual([12000, 6000]);
  const reads = f.list.mock.calls.length;
  await vi.advanceTimersByTimeAsync(500);
  expect(f.list).toHaveBeenCalledTimes(reads);
  await f.manager.stop(1, "recording");
  await vi.advanceTimersByTimeAsync(500);
  expect(f.volume()).toEqual([36000, 18000]);
  await vi.advanceTimersByTimeAsync(500);
  expect(f.volume()).toEqual([60000, 30000]);
  await f.manager.close();
});

it("restores hardware-rounded volumes while preserving later manual changes", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.devices[0] = { ...f.devices[0]!, volumes: [36700, 36700] };
  f.write.mockImplementation(async (id, volumes) => {
    const accepted = volumes
      .map((volume) => Math.round(volume / 1310.72) * 1310.72)
      .map(Math.round);
    const index = f.devices.findIndex((device) => device.id === id);
    f.devices[index] = { ...f.devices[index]!, volumes: accepted };
    return accepted;
  });
  await f.manager.start(1, "rounded", settings);
  expect(f.volume()).toEqual([7864, 7864]);
  await f.manager.stop(1, "rounded");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.volume()).toEqual([36700, 36700]);
  await f.manager.start(1, "manual", settings);
  f.devices[0] = { ...f.devices[0]!, volumes: [26214, 26214] };
  await f.manager.stop(1, "manual");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.volume()).toEqual([26214, 26214]);
  await f.manager.close();
});

it("rolls back a hardware write when its readback fails", async () => {
  const f = fixture();
  f.write.mockImplementationOnce(async (_id, volumes) => {
    f.devices[0] = { ...f.devices[0]!, volumes: volumes.map((volume) => volume + 524) };
    throw new Error("Audio readback failed");
  });
  await expect(f.manager.start(1, "failed", settings)).rejects.toThrow("Audio readback failed");
  expect(f.volume()).toEqual([60000, 30000]);
  await f.manager.close();
});

it("uses one original volume across windows, releasing only the caller's recording", async () => {
  const f = fixture();
  await f.manager.start(1, "a", { ...settings, fadeUpMs: 0 });
  await f.manager.start(2, "a", { ...settings, targetPercent: 10, fadeUpMs: 0 });
  expect(f.volume()).toEqual([6000, 3000]);
  await f.manager.stop(1, "a");
  expect(f.volume()).toEqual([6000, 3000]);
  await f.manager.stop(2, "a");
  expect(f.volume()).toEqual([60000, 30000]);
  await f.manager.close();
});

it("restarts during restoration without treating the partly restored volume as the baseline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.manager.start(1, "a", settings);
  await f.manager.stop(1, "a");
  await vi.advanceTimersByTimeAsync(500);
  expect(f.volume()).toEqual([36000, 18000]);
  await f.manager.start(1, "b", settings);
  expect(f.volume()).toEqual([12000, 6000]);
  await f.manager.stop(1, "b");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.volume()).toEqual([60000, 30000]);
  await f.manager.close();
});

it.each([0, 500])("finishes restoration when closed %i ms after stop", async (elapsed) => {
  vi.useFakeTimers();
  const f = fixture();
  await f.manager.start(1, "recording", settings);
  await f.manager.stop(1, "recording");
  await vi.advanceTimersByTimeAsync(elapsed);
  await f.manager.close();
  expect(f.volume()).toEqual([60000, 30000]);
  expect(vi.getTimerCount()).toBe(0);
  const writes = f.write.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  await f.manager.close();
  expect(f.write).toHaveBeenCalledTimes(writes);
  await expect(f.manager.start(1, "late", settings)).rejects.toThrow("shutting down");
});

it("preserves manual volume changes during a recording and during restoration", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.manager.start(1, "a", settings);
  f.devices[0] = { ...f.devices[0]!, volumes: [40000, 40000] };
  await f.manager.stop(1, "a");
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.volume()).toEqual([40000, 40000]);
  await f.manager.start(1, "b", settings);
  await f.manager.stop(1, "b");
  await vi.advanceTimersByTimeAsync(500);
  f.devices[0] = { ...f.devices[0]!, volumes: [50000, 50000] };
  await vi.advanceTimersByTimeAsync(500);
  expect(f.volume()).toEqual([50000, 50000]);
  await f.manager.close();
});

it("restores a closing owner's outputs without releasing another window", async () => {
  const f = fixture();
  await f.manager.start(1, "a", { ...settings, fadeUpMs: 0 });
  await f.manager.start(2, "b", { ...settings, outputIds: ["headphones"], fadeUpMs: 0 });
  await f.manager.stop(1);
  expect(f.volume()).toEqual([60000, 30000]);
  expect(f.volume("headphones")).toEqual([2000, 2000]);
  await f.manager.close();
  expect(f.volume("headphones")).toEqual([10000, 10000]);
});

it("rolls back an output already ducked when another selected output fails", async () => {
  const f = fixture();
  f.write
    .mockImplementationOnce(async (id, volumes) => {
      f.devices[0] = { ...f.devices[0]!, volumes: [...volumes] };
      expect(id).toBe("speakers");
      return f.devices[0]!.volumes;
    })
    .mockRejectedValueOnce(new Error("Output disconnected"));
  await expect(
    f.manager.start(1, "a", { ...settings, outputIds: ["speakers", "headphones"] }),
  ).rejects.toThrow("Output disconnected");
  expect(f.volume()).toEqual([60000, 30000]);
  expect(f.volume("headphones")).toEqual([10000, 10000]);
  await f.manager.close();
});

it("resolves default output once per recording and deduplicates explicit selections", async () => {
  const f = fixture();
  await f.manager.start(1, "a", {
    ...settings,
    outputIds: ["system-default", "speakers"],
    fadeUpMs: 0,
  });
  expect(f.write).toHaveBeenCalledOnce();
  f.devices[0] = { ...f.devices[0]!, isDefault: false };
  f.devices[1] = { ...f.devices[1]!, isDefault: true };
  await f.manager.stop(1, "a");
  expect(f.volume()).toEqual([60000, 30000]);
  await f.manager.start(1, "b", { ...settings, fadeUpMs: 0 });
  expect(f.volume()).toEqual([60000, 30000]);
  expect(f.volume("headphones")).toEqual([2000, 2000]);
  await f.manager.close();
});

it("ignores unavailable outputs while ducking available selected outputs", async () => {
  const f = fixture();
  await expect(
    f.manager.start(1, "none", { ...settings, outputIds: ["unplugged"] }),
  ).rejects.toThrow("No selected speaker output");
  await f.manager.start(1, "a", { ...settings, outputIds: ["unplugged", "speakers"] });
  expect(f.volume()).toEqual([12000, 6000]);
  f.devices.splice(0, 1);
  await f.manager.stop(1, "a");
  await f.manager.close();
});

it("retries restoration after a transient audio-server failure", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.manager.start(1, "a", { ...settings, fadeUpMs: 0 });
  f.list.mockRejectedValueOnce(new Error("Audio server unavailable"));
  await expect(f.manager.stop(1, "a")).rejects.toThrow("Audio server unavailable");
  await vi.advanceTimersByTimeAsync(50);
  expect(f.volume()).toEqual([60000, 30000]);
  await f.manager.close();
});
