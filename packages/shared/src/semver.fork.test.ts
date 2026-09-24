import { describe, expect, it } from "vite-plus/test";

import { compareSemverVersions, normalizeSemverVersion, parseSemver } from "./semver.ts";

describe("semver helpers (fork)", () => {
  it("keeps every identifier of a hyphenated prerelease", () => {
    expect(parseSemver("0.0.43-hyprws-nightly.20260923.693")?.prerelease).toEqual([
      "hyprws-nightly",
      "20260923",
      "693",
    ]);
    expect(normalizeSemverVersion("0.0.43-hyprws-nightly.20260923.693")).toBe(
      "0.0.43-hyprws-nightly.20260923.693",
    );
  });

  it("orders hyphenated prereleases by their later identifiers", () => {
    // The comparator returns a signed distance, so the sign is the ordering.
    const order = (left: string, right: string) => Math.sign(compareSemverVersions(left, right));
    expect(order("0.0.43-hyprws-nightly.20260923.688", "0.0.43-hyprws-nightly.20260923.693")).toBe(
      -1,
    );
    expect(order("0.0.43-hyprws.2", "0.0.43-hyprws.3")).toBe(-1);
  });

  it("parses and orders a plain nightly prerelease as before", () => {
    expect(parseSemver("0.0.43-nightly.20260923.1")?.prerelease).toEqual([
      "nightly",
      "20260923",
      "1",
    ]);
    expect(
      Math.sign(compareSemverVersions("0.0.43-nightly.20260923.1", "0.0.43-nightly.20260923.2")),
    ).toBe(-1);
    expect(compareSemverVersions("0.0.43-nightly.20260923.1", "0.0.43")).toBe(-1);
  });
});
