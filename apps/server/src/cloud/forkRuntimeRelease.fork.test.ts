import { assert, describe, it } from "@effect/vitest";

import { forkAppImageUrl } from "./forkRuntimeRelease.ts";

describe("forkAppImageUrl", () => {
  it("points a version at the release AppImage asset", () => {
    assert.equal(
      forkAppImageUrl("0.0.43-hyprws.2"),
      "https://github.com/RSI-Software/t3code-hyprws/releases/download/v0.0.43-hyprws.2/T3-Code-x86_64.AppImage",
    );
  });
});
