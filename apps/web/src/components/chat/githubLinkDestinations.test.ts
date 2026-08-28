import { describe, expect, it } from "vite-plus/test";

import {
  githubLinkDestinations,
  githubLinkLabel,
  parseGitHubLinkTarget,
  preferredGitHubLinkDestination,
} from "./githubLinkDestinations";

describe("GitHub link destinations", () => {
  it.each([
    ["https://github.com/RSI-Software/t3code-hyprws", "repository", null],
    ["https://github.com/RSI-Software/t3code-hyprws/issues/167#issuecomment-1", "issue", 167],
    ["https://github.com/RSI-Software/t3code-hyprws/pull/42/files", "pull-request", 42],
  ] as const)("parses %s", (href, kind, number) => {
    expect(parseGitHubLinkTarget(href)).toMatchObject({
      href,
      kind,
      repository: "RSI-Software/t3code-hyprws",
      number,
    });
  });

  it("does not claim other hosts or GitHub pages without a repository", () => {
    expect(parseGitHubLinkTarget("https://example.com/acme/repo/issues/1")).toBeNull();
    expect(parseGitHubLinkTarget("https://github.com/acme")).toBeNull();
  });

  it("labels issues and pull requests with their full repository identity", () => {
    const target = parseGitHubLinkTarget("https://github.com/acme/repo/pull/12");
    expect(target && githubLinkLabel(target)).toBe("acme/repo#12");
  });

  it("offers native only for issues and pull requests", () => {
    const repository = parseGitHubLinkTarget("https://github.com/acme/repo")!;
    const issue = parseGitHubLinkTarget("https://github.com/acme/repo/issues/1")!;

    expect(githubLinkDestinations(repository, true)).toEqual(["integrated", "external"]);
    expect(githubLinkDestinations(issue, true)).toEqual(["native", "integrated", "external"]);
  });

  it("falls back to the external browser when T3 Browser is unavailable", () => {
    const repository = parseGitHubLinkTarget("https://github.com/acme/repo")!;

    expect(
      preferredGitHubLinkDestination({
        target: repository,
        canOpenInPreview: false,
        linkMode: "integrated",
        changeRequestMode: "native",
      }),
    ).toBe("external");
  });
});
