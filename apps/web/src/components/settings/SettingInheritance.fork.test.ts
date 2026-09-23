import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import { settingInheritanceLayers } from "./SettingInheritance";
import { displaySettingInheritanceInputs } from "./SettingInheritance.fork";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");

describe("displaySettingInheritanceInputs", () => {
  it("decodes the stored thread-env mode so worktrunk is distinct from worktree", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: { defaultThreadEnvMode: "worktree", defaultThreadEnvModeFork: "worktrunk" },
      },
    };
    const resolved = resolveProjectSettings(settings, projectId);
    const displayInputs = displaySettingInheritanceInputs(
      { environmentId, label: "Laptop", projectId, ...resolved },
      settings,
    );
    const layers = settingInheritanceLayers(
      displayInputs.target,
      displayInputs.environmentSettings,
      "defaultThreadEnvMode",
    );
    expect(layers.map((layer) => [layer.label, layer.value])).toEqual([
      ["Project", "New worktrunk"],
      ["Laptop", "Inherits"],
      ["Default", "Current checkout"],
    ]);
    expect(layers[0]?.value).not.toBe("New worktree");
  });
});
