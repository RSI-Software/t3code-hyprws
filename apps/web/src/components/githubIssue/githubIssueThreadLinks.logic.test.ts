import { describe, expect, it } from "vite-plus/test";

import {
  resolveGitHubIssueReference,
  threadLinksGitHubIssue,
} from "./githubIssueThreadLinks.logic";

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
