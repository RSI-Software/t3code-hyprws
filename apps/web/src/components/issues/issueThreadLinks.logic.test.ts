import { describe, expect, it } from "vite-plus/test";

import { resolveIssueReference, threadLinksIssue } from "./issueThreadLinks.logic";

describe("resolveIssueReference", () => {
  const project = { host: "github.com", repository: "acme/app" };

  it("resolves a bare number against the thread's repository", () => {
    expect(resolveIssueReference(" #42 ", project)).toEqual({
      target: {
        host: "github.com",
        repository: "acme/app",
        number: 42,
        url: "https://github.com/acme/app/issues/42",
      },
    });
  });

  it("explains input it cannot link", () => {
    expect(resolveIssueReference("", project)).toBeNull();
    expect(resolveIssueReference("issue forty", project)).toHaveProperty("error");
    expect(resolveIssueReference("42", null)).toHaveProperty("error");
    expect(resolveIssueReference("ENG-42", project)).toEqual({
      error: "Paste the Linear issue's full URL.",
    });
    expect(
      resolveIssueReference("https://linear.app/acme/issue/ENG-42/fix-login", null),
    ).toHaveProperty("target.repository", "acme/ENG");
    expect(resolveIssueReference("https://github.com/other/repo/issues/3", null)).toHaveProperty(
      "target.repository",
      "other/repo",
    );
  });
});

describe("threadLinksIssue", () => {
  it("matches a link regardless of host and repository case", () => {
    const links = [{ host: "github.com", repository: "acme/app", number: 7 }];
    expect(threadLinksIssue(links, { host: "GitHub.com", repository: "Acme/App", number: 7 })).toBe(
      true,
    );
    expect(threadLinksIssue(links, { host: "github.com", repository: "acme/app", number: 8 })).toBe(
      false,
    );
    expect(threadLinksIssue(undefined, links[0]!)).toBe(false);
  });
});
