import { describe, expect, it } from "vite-plus/test";

import { searchSettings } from "./settingsSearch";

// Fork-owned assertions for the external workspace symlinks settings entry
// (RSI-Software/t3code-hyprws#951, reshaping 565594bd75). The upstream search
// suite keeps upstream text; fork-only search expectations live here.
describe("searchSettings — external workspace symlinks (fork)", () => {
  it("finds the external workspace symlinks setting", () => {
    expect(searchSettings("external workspace symlinks").map((item) => item.id)).toEqual([
      "external-workspace-symlinks",
    ]);
  });

  it("routes where links open to the browser page", () => {
    expect(searchSettings("open links in")[0]).toMatchObject({
      id: "browser-link-target",
      to: "/settings/browser",
    });
    expect(
      searchSettings("external links").find(({ id }) => id === "browser-link-target"),
    ).toMatchObject({
      id: "browser-link-target",
    });
  });
});
