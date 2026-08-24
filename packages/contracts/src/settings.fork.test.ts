import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  defaultEnabledForDriver,
  migrateLegacyZmuxSettings,
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

describe("ClientSettings ignored files", () => {
  it("hides ignored files by default and accepts client patches", () => {
    expect(decodeClientSettings({}).showIgnoredFiles).toBe(false);
    expect(decodeClientSettingsPatch({ showIgnoredFiles: true }).showIgnoredFiles).toBe(true);
  });
});

describe("migrateLegacyZmuxSettings", () => {
  it("folds an opted-in legacy flag into the zmux session mode", () => {
    expect(migrateLegacyZmuxSettings({ zmuxSessions: true })).toEqual({
      terminalSessionMode: "zmux",
    });
  });

  it("keeps an explicit terminal session mode over the legacy flag", () => {
    expect(migrateLegacyZmuxSettings({ zmuxSessions: true, terminalSessionMode: "shell" })).toEqual(
      { terminalSessionMode: "shell" },
    );
  });

  it("drops an opted-out legacy flag without touching the mode", () => {
    expect(migrateLegacyZmuxSettings({ zmuxSessions: false })).toEqual({});
  });

  it("passes through settings without the legacy flag", () => {
    const raw = { terminalSessionMode: "zmux" };
    expect(migrateLegacyZmuxSettings(raw)).toBe(raw);
  });

  it("passes through non-object input", () => {
    expect(migrateLegacyZmuxSettings(null)).toBe(null);
    expect(migrateLegacyZmuxSettings("nope")).toBe("nope");
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the terminal session mode to a plain shell", () => {
    expect(decodeServerSettings({}).terminalSessionMode).toBe("shell");
  });

  it("blocks external workspace symlinks by default and accepts a global opt-in", () => {
    expect(decodeServerSettings({}).followExternalWorkspaceSymlinks).toBe(false);
    expect(
      decodeServerSettingsPatch({ followExternalWorkspaceSymlinks: true })
        .followExternalWorkspaceSymlinks,
    ).toBe(true);
  });
});
