import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ClientSettingsSchema, ClientSettingsPatch } from "./settings.ts";

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
