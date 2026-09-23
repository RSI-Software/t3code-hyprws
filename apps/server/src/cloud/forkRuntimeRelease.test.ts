import { assert, describe, it } from "@effect/vitest";

import {
  forkServerTarballName,
  forkServerTarballUrl,
  pinnedRuntimeInstallSpec,
} from "./forkRuntimeRelease.ts";

// isForkServiceVersion is now shared/src/forkVersion.ts; its cases live in
// forkVersion.test.ts alongside it.

describe("pinnedRuntimeInstallSpec", () => {
  it("points a fork version at its release asset", () => {
    assert.equal(
      pinnedRuntimeInstallSpec("0.0.38-hyprws.1"),
      "https://github.com/RSI-Software/t3code-hyprws/releases/download/v0.0.38-hyprws.1/t3-0.0.38-hyprws.1.tgz",
    );
  });

  it("leaves an upstream version on the registry", () => {
    assert.equal(pinnedRuntimeInstallSpec("0.0.40"), "t3@0.0.40");
  });

  it("names the asset the way the pack step writes it", () => {
    assert.equal(forkServerTarballName("0.0.38-hyprws.1"), "t3-0.0.38-hyprws.1.tgz");
    assert.isTrue(
      forkServerTarballUrl("0.0.38-hyprws.1").endsWith(
        `/v0.0.38-hyprws.1/${forkServerTarballName("0.0.38-hyprws.1")}`,
      ),
    );
  });
});
