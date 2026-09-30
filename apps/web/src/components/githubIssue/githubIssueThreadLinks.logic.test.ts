import { describe, expect, it } from "vite-plus/test";

import {
  githubIssueLinkTarget,
  resolveGitHubIssueReference,
  threadLinksGitHubIssue,
} from "./githubIssueThreadLinks.logic";

describe("githubIssueLinkTarget", () => {
  it("keys an issue URL by lowercased host, port included", () => {
    expect(githubIssueLinkTarget("https://GHE.acme.dev:8443/Acme/App/issues/12#comment")).toEqual({
      host: "ghe.acme.dev:8443",
      repository: "Acme/App",
      number: 12,
      url: "https://ghe.acme.dev:8443/Acme/App/issues/12",
    });
  });

  it("rejects pages that are not issues", () => {
    expect(githubIssueLinkTarget("https://github.com/acme/app/pull/12")).toBeNull();
    expect(githubIssueLinkTarget("https://github.com/acme/app/issues/0")).toBeNull();
    expect(githubIssueLinkTarget("not a url")).toBeNull();
  });
});

describe("resolveGitHubIssueReference", () => {
  const project = { host: "github.com", repository: "acme/app" };

  it("resolves a bare number against the thread's repository", () => {
    expect(resolveGitHubIssueReference(" #42 ", project)).toEqual({
      target: {
        host: "github.com",
        repository: "acme/app",
        number: 42,
        url: "https://github.com/acme/app/issues/42",
      },
    });
  });

  it("explains input it cannot link", () => {
    expect(resolveGitHubIssueReference("", project)).toBeNull();
    expect(resolveGitHubIssueReference("issue forty", project)).toHaveProperty("error");
    expect(resolveGitHubIssueReference("42", null)).toHaveProperty("error");
    expect(
      resolveGitHubIssueReference("https://github.com/other/repo/issues/3", null),
    ).toHaveProperty("target.repository", "other/repo");
  });
});

describe("threadLinksGitHubIssue", () => {
  it("matches a link regardless of host and repository case", () => {
    const links = [{ host: "github.com", repository: "acme/app", number: 7 }];
    expect(
      threadLinksGitHubIssue(links, { host: "GitHub.com", repository: "Acme/App", number: 7 }),
    ).toBe(true);
    expect(
      threadLinksGitHubIssue(links, { host: "github.com", repository: "acme/app", number: 8 }),
    ).toBe(false);
    expect(threadLinksGitHubIssue(undefined, links[0]!)).toBe(false);
  });
});
