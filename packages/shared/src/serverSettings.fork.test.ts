import { DEFAULT_SERVER_SETTINGS, type ServerSettingsPatch } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";
describe("serverSettings helpers", () => {
  it("applies the global external workspace symlink toggle", () => {
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        followExternalWorkspaceSymlinks: true,
      }).followExternalWorkspaceSymlinks,
    ).toBe(true);
  });

  it("clears both thread-env-mode wire fields when the patch names null", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultThreadEnvMode: "worktree" as const,
      defaultThreadEnvModeFork: "worktrunk" as const,
    };
    // Cast: the pre-2110 ServerSettingsPatch type still models
    // `defaultThreadEnvMode` as non-nullable; upstream 2110 widens it to
    // `ThreadEnvMode | null`, which is the shape this fix targets.
    const patch = { defaultThreadEnvMode: null } as unknown as ServerSettingsPatch;
    const next = applyServerSettingsPatch(current, patch);
    expect(next.defaultThreadEnvMode).toBeNull();
    expect(next.defaultThreadEnvModeFork).toBeUndefined();
  });

  it("round-trips a worktrunk patch to the worktree wire mode plus its fork sibling", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultThreadEnvMode: "worktree",
      defaultThreadEnvModeFork: "worktrunk",
    });
    expect(next.defaultThreadEnvMode).toBe("worktree");
    expect(next.defaultThreadEnvModeFork).toBe("worktrunk");
  });
});
