import { describe, expect, it } from "vite-plus/test";

import { manualServerUpdateCommand } from "./versionSkew";

describe("manualServerUpdateCommand (fork)", () => {
  it("points a fork version at its GitHub release page", () => {
    expect(manualServerUpdateCommand("0.0.43-hyprws.2")).toBe(
      "https://github.com/RSI-Software/t3code-hyprws/releases/tag/v0.0.43-hyprws.2",
    );
  });

  it("leaves an upstream version on npx", () => {
    expect(manualServerUpdateCommand("0.0.43")).toBe("npx t3@0.0.43");
  });
});
