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
});
