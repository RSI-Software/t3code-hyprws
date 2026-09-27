import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import {
  createBuildConfig,
  resolveDesktopUpdateChannel,
  resolveGitHubPublishConfig,
} from "./build-desktop-artifact.ts";
import { forkSupersedes } from "./lib/fork-supersedes.ts";

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

// electron-updater names the channel file after the release tag's first
// prerelease identifier, so fork nightlies publish to `hyprws-nightly`.
forkSupersedes({
  upstream:
    "scripts/build-desktop-artifact.test.ts > resolves GitHub desktop publish config from Effect config",
  reason:
    "fork nightly tags carry the hyprws-nightly prerelease identifier, so the nightly feed publishes to that channel instead of upstream's nightly",
  commit: "13e0dffa54c",
});
it.effect("publishes fork nightlies to the hyprws-nightly update channel", () =>
  Effect.gen(function* () {
    const publishConfig = (channel: "latest" | "nightly") =>
      resolveGitHubPublishConfig(channel).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "RSI-Software/t3code-hyprws" } }),
          ),
        ),
      );

    assert.deepStrictEqual(yield* publishConfig("latest"), {
      provider: "github",
      owner: "RSI-Software",
      repo: "t3code-hyprws",
      releaseType: "release",
    });
    assert.deepStrictEqual(yield* publishConfig("nightly"), {
      provider: "github",
      owner: "RSI-Software",
      repo: "t3code-hyprws",
      releaseType: "prerelease",
      channel: "hyprws-nightly",
    });
  }),
);
