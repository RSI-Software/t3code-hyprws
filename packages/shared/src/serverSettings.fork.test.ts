import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
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
});
