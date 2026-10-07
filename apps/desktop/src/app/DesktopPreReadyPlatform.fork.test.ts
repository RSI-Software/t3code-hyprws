import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { getSwitchValueMock, setUsePlainTextEncryptionMock } = vi.hoisted(() => ({
  getSwitchValueMock: vi.fn(),
  setUsePlainTextEncryptionMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    setDesktopName: vi.fn(),
    getVersion: () => "0.0.37",
    isPackaged: false,
    getAppPath: () => "/tmp/app",
    commandLine: {
      appendSwitch: vi.fn(),
      getSwitchValue: getSwitchValueMock,
      hasSwitch: (switchName: string) => switchName === "password-store",
    },
  },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
  },
  safeStorage: {
    setUsePlainTextEncryption: setUsePlainTextEncryptionMock,
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: () => "{}",
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";

const buildLinuxOptions = DesktopPreReadyPlatform.DesktopPreReadyElectronOptions.pipe(
  Effect.provide(
    DesktopPreReadyPlatform.layer.pipe(Layer.provide(Layer.succeed(HostProcess.Platform, "linux"))),
  ),
);

describe("DesktopPreReadyPlatform plain-text safe storage", () => {
  beforeEach(() => {
    getSwitchValueMock.mockReset();
    setUsePlainTextEncryptionMock.mockReset();
  });

  it.effect("opts into plain-text encryption for an explicit basic password store", () => {
    getSwitchValueMock.mockReturnValue(" basic ");

    return Effect.gen(function* () {
      yield* buildLinuxOptions;
      assert.deepEqual(setUsePlainTextEncryptionMock.mock.calls, [[true]]);
    });
  });

  it.effect("keeps plain-text encryption off for a keyring password store", () => {
    getSwitchValueMock.mockReturnValue("gnome-libsecret");

    return Effect.gen(function* () {
      yield* buildLinuxOptions;
      assert.equal(setUsePlainTextEncryptionMock.mock.calls.length, 0);
    });
  });
});
