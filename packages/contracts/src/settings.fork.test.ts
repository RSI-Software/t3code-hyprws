import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
  defaultEnabledForDriver,
  migrateLegacyForkThreadEnvModeSettings,
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

describe("ClientSettings GitHub link destinations", () => {
  it("keeps existing link behavior as the defaults", () => {
    const settings = decodeClientSettings({});

    expect(settings.githubLinkOpenMode).toBe("external");
    expect(settings.githubChangeRequestOpenMode).toBe("native");
  });

  it("accepts only destinations applicable to each GitHub link kind", () => {
    expect(
      decodeClientSettings({
        githubLinkOpenMode: "integrated",
        githubChangeRequestOpenMode: "external",
      }),
    ).toMatchObject({
      githubLinkOpenMode: "integrated",
      githubChangeRequestOpenMode: "external",
    });
    expect(() => decodeClientSettings({ githubLinkOpenMode: "native" })).toThrow();
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

describe("ServerSettings.githubIssueHandoffPromptTemplate", () => {
  it("defaults legacy configs to the built-in issue handoff prompt", () => {
    expect(decodeServerSettings({}).githubIssueHandoffPromptTemplate).toBe(
      DEFAULT_SERVER_SETTINGS.githubIssueHandoffPromptTemplate,
    );
  });

  it("trims a custom prompt and rejects an empty prompt", () => {
    expect(
      decodeServerSettingsPatch({
        githubIssueHandoffPromptTemplate: "  Fix {{url}} carefully.  ",
      }).githubIssueHandoffPromptTemplate,
    ).toBe("Fix {{url}} carefully.");
    expect(() => decodeServerSettingsPatch({ githubIssueHandoffPromptTemplate: "   " })).toThrow();
  });
});

describe("migrateLegacyForkThreadEnvModeSettings", () => {
  it("lifts a stored worktrunk default into the wire pair", () => {
    expect(migrateLegacyForkThreadEnvModeSettings({ defaultThreadEnvMode: "worktrunk" })).toEqual({
      defaultThreadEnvMode: "worktree",
      defaultThreadEnvModeFork: "worktrunk",
    });
  });

  it("leaves every other settings shape untouched", () => {
    const settings = { defaultThreadEnvMode: "worktree" };
    expect(migrateLegacyForkThreadEnvModeSettings(settings)).toBe(settings);
    expect(migrateLegacyForkThreadEnvModeSettings({})).toEqual({});
    expect(migrateLegacyForkThreadEnvModeSettings(null)).toBeNull();
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
