import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import { resolveServerBackgroundActivitySettings } from "./backgroundActivitySettings.ts";
import { createModelSelection } from "./model.ts";
import {
  applyServerSettingsPatch,
  extractPersistedServerObservabilitySettings,
  isModelSelectionProviderEnabled,
  normalizePersistedServerSettingString,
  parsePersistedServerObservabilitySettings,
  resolveSourceControlWriterModelSelection,
} from "./serverSettings.ts";
describe("serverSettings helpers", () => {
  it("applies the global external workspace symlink toggle", () => {
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        followExternalWorkspaceSymlinks: true,
      }).followExternalWorkspaceSymlinks,
    ).toBe(true);
  });
});
