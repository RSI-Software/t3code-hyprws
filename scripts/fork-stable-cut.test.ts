import { assert, it } from "@effect/vitest";

import { decideStableCut, type StableCutInput } from "./fork-stable-cut.ts";

const base: StableCutInput = {
  tags: ["v1.2.2", "v1.2.3", "v1.2.2-hyprws.1"],
  upstreamStables: [
    { tag: "v1.2.2", sha: "s122" },
    { tag: "v1.2.3", sha: "s123" },
  ],
  nightlies: [
    { tag: "v1.2.3-hyprws-nightly.20261109.7", sha: "f7", baseSha: "s123" },
    { tag: "v1.2.3-hyprws-nightly.20261109.8", sha: "f8", baseSha: "s123" },
    { tag: "v1.2.4-hyprws-nightly.20261110.9", sha: "f9", baseSha: "n124" },
  ],
  recut: null,
};

it("cuts the newest upstream stable once, from the newest fork nightly on its exact commit", () => {
  assert.deepStrictEqual(decideStableCut(base), {
    cut: true,
    tag: "v1.2.3-hyprws.1",
    sha: "f8",
    reason: "v1.2.3-hyprws.1 from v1.2.3-hyprws-nightly.20261109.8",
  });
  assert.isFalse(decideStableCut({ ...base, tags: [...base.tags, "v1.2.3-hyprws.1"] }).cut);
  assert.isFalse(decideStableCut({ ...base, nightlies: base.nightlies.slice(2) }).cut);
});

it("recuts the trunk tip under the newest upstream stable it contains", () => {
  const recut = { sha: "tip", contained: ["v1.2.2", "v1.2.3", "v1.2.4-nightly.20261110.9"] };
  assert.deepStrictEqual(
    decideStableCut({ ...base, tags: [...base.tags, "v1.2.3-hyprws.1"], recut }),
    {
      cut: true,
      tag: "v1.2.3-hyprws.2",
      sha: "tip",
      reason: "recut of the trunk tip as v1.2.3-hyprws.2",
    },
  );
});
