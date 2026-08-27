import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { clearProjectSettingsOverrides, resolveProjectSettings } from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import { fromWireThreadEnvModeFields } from "./threadEnvMode.fork.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");

describe("resolveProjectSettings", () => {
  it("carries the fork thread-mode sibling onto the effective settings", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { defaultThreadEnvMode: "worktree", defaultThreadEnvModeFork: "worktrunk" },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultThreadEnvMode).toBe("worktree");
    expect(resolved.settings.defaultThreadEnvModeFork).toBe("worktrunk");
    expect(resolved.sources.defaultThreadEnvMode).toBe("project");
    // Another project without the override sees no sibling.
    expect(
      resolveProjectSettings(settings, otherProjectId).settings.defaultThreadEnvModeFork,
    ).toBeUndefined();
  });

  it("never leaves the environment sibling standing next to a project-set slot", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultThreadEnvMode: "worktree",
      defaultThreadEnvModeFork: "worktrunk",
      projectSettingsOverrides: {
        // A plain `worktree` override: no sibling of its own.
        [projectId]: { defaultThreadEnvMode: "worktree" },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultThreadEnvMode).toBe("worktree");
    expect(resolved.settings.defaultThreadEnvModeFork).toBeUndefined();
    expect(fromWireThreadEnvModeFields(resolved.settings)).toBe("worktree");
  });
});

describe("projectSettingsOverrides patches", () => {
  it("drops the fork sibling when the thread-mode override is cleared", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: {
          defaultThreadEnvMode: "worktree",
          defaultThreadEnvModeFork: "worktrunk",
          defaultAutoPull: true,
        },
      },
    });
    expect(clearProjectSettingsOverrides(settings, projectId, ["defaultThreadEnvMode"])).toEqual({
      defaultAutoPull: true,
    });
    expect(
      clearProjectSettingsOverrides(settings, projectId, [
        "defaultThreadEnvMode",
        "defaultAutoPull",
      ]),
    ).toBeNull();
  });
});
