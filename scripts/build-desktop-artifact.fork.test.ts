import { assert, it } from "@effect/vitest";

import { resolveDesktopUpdateChannel } from "./build-desktop-artifact.ts";

it("resolves updater channels for upstream and fork release versions", () => {
  assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
  assert.equal(resolveDesktopUpdateChannel("0.0.17-hyprws-nightly.20260413.42"), "nightly");
  assert.equal(resolveDesktopUpdateChannel("0.0.17-hyprws.2"), "latest");
  assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
});
