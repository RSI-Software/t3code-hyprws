import { assert, describe, it } from "@effect/vitest";

import { isForkServiceVersion } from "./forkVersion.ts";

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
