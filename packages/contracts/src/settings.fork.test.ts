import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";
import { ClientSettingsSchema, ClientSettingsPatch } from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("ClientSettings environment display names", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("defaults to no client-local overrides", () => {
    expect(decodeClientSettings({}).environmentDisplayNames).toEqual({});
  });

  it("trims saved overrides", () => {
    expect(
      decodeClientSettings({
        environmentDisplayNames: { [environmentId]: "  Workstation  " },
      }).environmentDisplayNames,
    ).toEqual({ [environmentId]: "Workstation" });
  });

  it("rejects empty overrides", () => {
    expect(() =>
      decodeClientSettingsPatch({
        environmentDisplayNames: { [environmentId]: "   " },
      }),
    ).toThrow();
  });
});
