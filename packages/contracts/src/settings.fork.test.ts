import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import type { CommandId, ProjectId } from "./baseSchemas.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  requiredScopesForProjectMutation,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("GitHub link open modes", () => {
  const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);

  it("defaults both open modes so existing settings files decode", () => {
    const settings = decodeClientSettings({});
    expect(settings.githubLinkOpenMode).toBe("external");
    expect(settings.githubChangeRequestOpenMode).toBe("native");
  });

  it("round-trips saved open modes through decode and encode", () => {
    const saved = { githubLinkOpenMode: "integrated", githubChangeRequestOpenMode: "external" };
    const decoded = decodeClientSettings(saved);
    expect(decoded.githubLinkOpenMode).toBe("integrated");
    expect(decoded.githubChangeRequestOpenMode).toBe("external");
    expect(encodeClientSettings(decoded)).toMatchObject(saved);
  });

  it("rejects unknown open modes in patches", () => {
    expect(() => decodeClientSettingsPatch({ githubLinkOpenMode: "native" })).toThrow();
    expect(() => decodeClientSettingsPatch({ githubChangeRequestOpenMode: "minimized" })).toThrow();
    expect(
      decodeClientSettingsPatch({
        githubLinkOpenMode: "integrated",
        githubChangeRequestOpenMode: "integrated",
      }),
    ).toEqual({ githubLinkOpenMode: "integrated", githubChangeRequestOpenMode: "integrated" });
  });
});

describe("team project scopes", () => {
  it("asks for sharing rights when a mutation marks or unmarks a team project", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    for (const teamFork of [true, false]) {
      expect(
        requiredScopesForProjectMutation({
          type: "project.update",
          commandId,
          projectId,
          teamFork,
        }),
      ).toEqual(["orchestration:operate", "access:write", "orchestration:read"]);
    }
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        teamFork: true,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write", "access:write", "orchestration:read"]);
  });
});
