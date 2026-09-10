import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

describe("updateChannels fork versions", () => {
  it("reads a fork nightly as nightly for the channel and the branding", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.0.43-hyprws-nightly.20260928.775")).toBe(
      "nightly",
    );
    expect(isNightlyDesktopVersion("0.0.43-hyprws-nightly.20260928.775")).toBe(true);
  });

  it("keeps a fork stable on latest with stable branding", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.0.43-hyprws.5")).toBe("latest");
    expect(isNightlyDesktopVersion("0.0.43-hyprws.5")).toBe(false);
  });
});
