import { assert, it } from "@effect/vitest";

import {
  forkTargetVersion,
  parseNightlyForkTag,
  parseStableForkTag,
  parseUpstreamReleaseTag,
  positionUpstreamReleaseTags,
  selectNewestReleaseTag,
} from "./fork-policy.ts";

it("accepts only the shared upstream stable and nightly grammar", () => {
  assert.equal(parseUpstreamReleaseTag("v1.2.3")?.channel, "stable");
  assert.equal(parseUpstreamReleaseTag("v1.2.3-nightly.20260831.4")?.channel, "nightly");
  for (const invalid of [
    "v1.2.3-rc.1",
    "v1.2.3-nightly.foo",
    "v1.2.3-nightly.20260230.1",
    "v1.2.3-nightly.99999999.1",
    "v1.2.3-nightly.20260831.0",
  ]) {
    assert.isNull(parseUpstreamReleaseTag(invalid));
    assert.isNull(forkTargetVersion(invalid));
  }
  assert.equal(forkTargetVersion("v1.2.3-nightly.20260831.4"), "v1.2.3-hyprws");
});

it("rejects revision zero in fork release tags", () => {
  assert.equal(parseStableForkTag("v1.2.3-hyprws.1")?.revision, 1);
  assert.isNull(parseStableForkTag("v1.2.3-hyprws.0"));
  assert.equal(parseNightlyForkTag("v1.2.3-hyprws-nightly.20260831.1")?.runNumber, 1);
  assert.isNull(parseNightlyForkTag("v1.2.3-hyprws-nightly.20260831.0"));
});

it("positions only release tags on the upstream first-parent lane", () => {
  const git = {
    run: () =>
      [
        "v1.2.3\taaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t",
        "v1.2.4-nightly.20260831.2\tbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t",
        "v1.2.4-nightly.20260831.3\tcccccccccccccccccccccccccccccccccccccccc\t",
      ].join("\n"),
  };
  const tags = positionUpstreamReleaseTags(git, [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ]);
  assert.deepStrictEqual(
    tags.map(({ tag, position }) => ({ tag, position })),
    [
      { tag: "v1.2.3", position: 0 },
      { tag: "v1.2.4-nightly.20260831.2", position: 1 },
    ],
  );
  assert.equal(selectNewestReleaseTag(tags)?.tag, "v1.2.4-nightly.20260831.2");
});
