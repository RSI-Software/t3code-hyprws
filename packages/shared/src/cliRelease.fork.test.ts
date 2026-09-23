import { describe, expect, it } from "vite-plus/test";

import { forkSupersedes } from "../../../scripts/lib/fork-supersedes.ts";
import {
  cliReleaseChannelOf,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "./cliRelease.ts";

describe("cliRelease (fork)", () => {
  forkSupersedes({
    upstream:
      "packages/shared/src/cliRelease.test.ts > resolves download URLs under the tagged release, honoring a mirror",
    reason: "the fork downloads CLI archives from its own releases, not upstream's",
    commit: "92adabf85d",
  });
  it("resolves download URLs under the fork's tagged release, honoring a mirror", () => {
    expect(cliReleaseDownloadBaseUrl("0.0.43-hyprws.3")).toBe(
      "https://github.com/RSI-Software/t3code-hyprws/releases/download/v0.0.43-hyprws.3",
    );
    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/t3/")).toBe(
      "https://mirror.example/t3/v1.2.3",
    );
  });

  forkSupersedes({
    upstream:
      "packages/shared/src/cliRelease.test.ts > pages through the release index at the largest page GitHub allows",
    reason: "the fork reads its own release index, not upstream's",
    commit: "92adabf85d",
  });
  it("pages through the fork's release index at the largest page GitHub allows", () => {
    expect(cliReleaseIndexPageUrl(1)).toBe(
      "https://api.github.com/repos/RSI-Software/t3code-hyprws/releases?per_page=100&page=1",
    );
    expect(cliReleaseIndexPageUrl(3)).toContain("page=3");
  });

  it("reads a fork nightly as nightly and a fork stable as stable", () => {
    expect(cliReleaseChannelOf("0.0.43-hyprws-nightly.20260923.693")).toBe("nightly");
    expect(cliReleaseChannelOf("0.0.43-hyprws.3")).toBe("stable");
    // Only the exact nightly tag shape is a nightly.
    expect(cliReleaseChannelOf("0.0.43-hyprws-nightly.1")).toBe("stable");
  });

  it("picks the newest fork release on the requested channel", () => {
    const releases = [
      { tag_name: "v0.0.44-hyprws-nightly.20260924.700" },
      { tag_name: "v0.0.43-hyprws.3" },
      { tag_name: "v0.0.43-hyprws-nightly.20260923.693" },
      { tag_name: "v0.0.43-hyprws.2" },
    ];
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("0.0.44-hyprws-nightly.20260924.700");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("0.0.43-hyprws.3");
  });
});
