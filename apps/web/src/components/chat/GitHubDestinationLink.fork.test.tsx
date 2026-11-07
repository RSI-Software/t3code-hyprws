import { describe, expect, it } from "vite-plus/test";

import {
  githubLinkDestinations,
  parseGitHubLinkTarget,
  preferredGitHubLinkDestination,
} from "./GitHubDestinationLink.fork";
import { findGitHubReferences, resolveGitHubReferenceHref } from "./githubReferences.fork";

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

describe("GitHub references written as text", () => {
  const thread = { owner: "RSI-Software", name: "donjor-skills" };

  it.each([
    ["see #12 here", "https://github.com/RSI-Software/donjor-skills/issues/12"],
    ["(rsi#1182)", "https://github.com/RSI-Software/rsi/issues/1182"],
    ["in pingdotgg/t3code#7.", "https://github.com/pingdotgg/t3code/issues/7"],
  ])("resolves %s against the thread repository", (text, url) => {
    const [reference] = findGitHubReferences(text);
    expect(reference && resolveGitHubReferenceHref(reference.url, thread)).toBe(url);
  });

  it.each(["C# 12", "a/b/#3", "https://x.dev/#4", "word#0", "#12abc"])(
    "leaves %s alone",
    (text) => {
      expect(findGitHubReferences(text)).toEqual([]);
    },
  );

  it("links a short reference only when the thread has a GitHub repository", () => {
    const [short, full] = findGitHubReferences("rsi#1 and acme/repo#2");
    expect(resolveGitHubReferenceHref(short!.url, null)).toBeNull();
    expect(resolveGitHubReferenceHref(full!.url, null)).toBe(
      "https://github.com/acme/repo/issues/2",
    );
  });
});
