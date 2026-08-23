import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  defaultEnabledForDriver,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";
import {
  decodeServerSettings,
  decodeServerSettingsPatch,
  decodeClientSettings,
  decodeClientSettingsPatch,
} from "./settings.test.ts";

describe("ServerSettings terminal session mode", () => {
  it("defaults to a plain shell", () => {
    expect(decodeServerSettings({}).terminalSessionMode).toBe("shell");
  });

  it("accepts zmux mode in full settings and patches", () => {
    expect(decodeServerSettings({ terminalSessionMode: "zmux" }).terminalSessionMode).toBe("zmux");
    expect(decodeServerSettingsPatch({ terminalSessionMode: "zmux" }).terminalSessionMode).toBe(
      "zmux",
    );
  });

  it("rejects unsupported terminal session modes", () => {
    expect(() => decodeServerSettings({ terminalSessionMode: "tmux" })).toThrow();
    expect(() => decodeServerSettingsPatch({ terminalSessionMode: "tmux" })).toThrow();
  });
});
