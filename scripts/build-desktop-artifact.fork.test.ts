import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createBuildConfig, resolveDesktopUpdateChannel } from "./build-desktop-artifact.ts";

it("resolves updater channels for upstream and fork release versions", () => {
  assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
  assert.equal(resolveDesktopUpdateChannel("0.0.17-hyprws-nightly.20260413.42"), "nightly");
  assert.equal(resolveDesktopUpdateChannel("0.0.17-hyprws.2"), "latest");
  assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
});

it.layer(NodeServices.layer)((it) => {
  it.effect("names the fork in the Linux launcher and keeps the app identity", () =>
    Effect.gen(function* () {
      const linuxEntry = (version: string) =>
        createBuildConfig("linux", "AppImage", version, false, false, undefined, undefined).pipe(
          Effect.map((config) => ({
            appId: config.appId,
            productName: config.productName,
            entry: (config.linux as { desktop: { entry: Record<string, string> } }).desktop.entry,
          })),
        );

      const stable = yield* linuxEntry("0.0.43-hyprws.5");
      assert.deepStrictEqual(stable, {
        appId: "com.t3tools.t3code",
        productName: "T3 Code (Alpha)",
        entry: { StartupWMClass: "t3code", Name: "T3 Code (hyprws)" },
      });

      const nightly = yield* linuxEntry("0.0.43-hyprws-nightly.20260927.743");
      assert.equal(nightly.entry.Name, "T3 Code (hyprws Nightly)");
      assert.equal(nightly.productName, "T3 Code (Nightly)");
    }),
  );
});
