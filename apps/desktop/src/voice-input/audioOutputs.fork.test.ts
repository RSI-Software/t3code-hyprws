// @effect-diagnostics nodeBuiltinImport:off - Mock the native audio adapter's subprocess boundary.
import * as NodeChildProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { linuxAudioOutputsFork } from "./audioOutputs.fork.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("reads stable output names and each channel's raw volume", async () => {
  vi.mocked(NodeChildProcess.execFile).mockImplementation((_file, args, _options, callback) => {
    const response = args?.includes("get-default-sink")
      ? "speakers\n"
      : JSON.stringify([
          {
            name: "speakers",
            description: "USB speakers",
            mute: true,
            volume: { "front-left": { value: 60000 }, "front-right": { value: 30000 } },
          },
          {
            name: "headphones",
            description: "Headphones",
            mute: false,
            volume: { mono: { value: 10000 } },
          },
        ]);
    callback?.(null, response, "");
    return {} as NodeChildProcess.ChildProcess;
  });
  expect(await linuxAudioOutputsFork.list()).toEqual([
    { id: "speakers", label: "USB speakers", isDefault: true, volumes: [60000, 30000] },
    { id: "headphones", label: "Headphones", isDefault: false, volumes: [10000] },
  ]);
});

it("writes raw per-channel volumes without invoking a shell or changing mute", async () => {
  vi.mocked(NodeChildProcess.execFile).mockImplementation((_file, _args, _options, callback) => {
    callback?.(
      null,
      JSON.stringify([
        {
          name: "speakers",
          description: "Speakers",
          volume: { "front-left": { value: 60293 }, "front-right": { value: 30147 } },
        },
      ]),
      "",
    );
    return {} as NodeChildProcess.ChildProcess;
  });
  expect(await linuxAudioOutputsFork.setVolumes("speakers", [60000, 30000])).toEqual([
    60293, 30147,
  ]);
  expect(NodeChildProcess.execFile).toHaveBeenNthCalledWith(
    1,
    "pactl",
    ["set-sink-volume", "speakers", "60000", "30000"],
    { timeout: 2000, maxBuffer: 2 * 1024 * 1024 },
    expect.any(Function),
  );
  expect(NodeChildProcess.execFile).toHaveBeenNthCalledWith(
    2,
    "pactl",
    ["--format=json", "list", "sinks"],
    { timeout: 2000, maxBuffer: 2 * 1024 * 1024 },
    expect.any(Function),
  );
});
