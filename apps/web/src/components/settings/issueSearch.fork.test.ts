import { describe, expect, it } from "vite-plus/test";

import { getSettingsSearchTargetScope, searchSettings } from "./settingsSearch";

describe("issue settings search", () => {
  it("finds the Linear key under its environment-wide scope", () => {
    expect(searchSettings("linear").map((item) => item.id)).toEqual(["linear-api-key"]);
    expect(getSettingsSearchTargetScope("linear-api-key")?.scope).toBe("environment-defaults");
  });
});
