import { describe, expect, it } from "vite-plus/test";

import {
  githubLinkDestinations,
  parseGitHubLinkTarget,
  preferredGitHubLinkDestination,
} from "./GitHubDestinationLink.fork";
import {
  findGitHubReferences,
  findLinearReferences,
  resolveGitHubReferenceHref,
  resolveLinearReferenceHref,
} from "./githubReferences.fork";

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

  it("resolves a short reference to the thread's linked pull request or issue first", () => {
    const pullRequest = "https://github.com/RSI-Software/rsi-pr-agent/pull/781";
    const linked = [
      {
        host: "github.com",
        repository: "rsi-software/rsi-pr-agent",
        number: 781,
        url: pullRequest,
      },
      {
        host: "github.com",
        repository: "acme/a",
        number: 5,
        url: "https://github.com/acme/a/issues/5",
      },
      {
        host: "github.com",
        repository: "acme/b",
        number: 5,
        url: "https://github.com/acme/b/issues/5",
      },
    ];
    const resolve = (text: string) =>
      resolveGitHubReferenceHref(findGitHubReferences(text)[0]!.url, thread, linked);

    expect(resolve("#781")).toBe(pullRequest);
    expect(resolve("rsi-pr-agent#781")).toBe(pullRequest);
    expect(resolve("rsi#781")).toBe("https://github.com/RSI-Software/rsi/issues/781");
    expect(resolve("#5")).toBe("https://github.com/RSI-Software/donjor-skills/issues/5");
    expect(resolveGitHubReferenceHref(findGitHubReferences("#781")[0]!.url, null, linked)).toBe(
      pullRequest,
    );
  });

  it("links a short reference only when the thread has a GitHub repository", () => {
    const [short, full] = findGitHubReferences("rsi#1 and acme/repo#2");
    expect(resolveGitHubReferenceHref(short!.url, null)).toBeNull();
    expect(resolveGitHubReferenceHref(full!.url, null)).toBe(
      "https://github.com/acme/repo/issues/2",
    );
  });
});

describe("Linear references written as text", () => {
  it("links an identifier only to the one Linear issue the thread links", () => {
    const url = "https://linear.app/acme/issue/ENG-42/fix-login";
    const linked = [
      { host: "linear.app", repository: "acme/eng", number: 42, url },
      {
        host: "github.com",
        repository: "acme/app",
        number: 7,
        url: "https://github.com/acme/app/issues/7",
      },
    ];
    const resolve = (text: string) =>
      findLinearReferences(text).map((reference) =>
        resolveLinearReferenceHref(reference.url, linked),
      );

    expect(resolve("fixes ENG-42.")).toEqual([url]);
    expect(resolve("ENG-7 and APP-7 use UTF-8")).toEqual([null, null, null]);
    expect(resolve("eng-42 x-ENG-42 ENG-42a ENG-0")).toEqual([]);
  });
});
