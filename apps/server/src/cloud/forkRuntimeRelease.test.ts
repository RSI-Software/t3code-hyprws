import { assert, describe, it } from "@effect/vitest";

import {
  forkServerTarballName,
  forkServerTarballUrl,
  isForkServiceVersion,
  pinnedRuntimeInstallSpec,
} from "./forkRuntimeRelease.ts";

describe("isForkServiceVersion", () => {
  it("accepts the stable and nightly prereleases the release workflow writes", () => {
    assert.isTrue(isForkServiceVersion("0.0.38-hyprws.1"));
    assert.isTrue(isForkServiceVersion("0.0.41-hyprws-nightly.20260910.406"));
  });

  it("rejects an upstream version", () => {
    assert.isFalse(isForkServiceVersion("0.0.40"));
    assert.isFalse(isForkServiceVersion("0.0.40-beta.1"));
  });

  it("rejects a prerelease that only looks like the fork's", () => {
    assert.isFalse(isForkServiceVersion("0.0.38-hyprwsx.1"));
    assert.isFalse(isForkServiceVersion("0.0.38-nightly-hyprws.1"));
  });

  it("rejects anything npm would read as a range or a dist-tag", () => {
    assert.isFalse(isForkServiceVersion("latest"));
    assert.isFalse(isForkServiceVersion("^0.0.38-hyprws.1"));
    assert.isFalse(isForkServiceVersion("0.0.38-hyprws.1 || 0.0.39-hyprws.1"));
  });
});

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
