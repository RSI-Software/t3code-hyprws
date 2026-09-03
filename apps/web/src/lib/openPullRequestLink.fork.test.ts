import { describe, expect, it } from "vite-plus/test";

import {
  findProjectForGitHubIssue,
  findProjectForGitHubLink,
  parseGitHubIssueUrl,
} from "./openPullRequestLink";

describe("parseGitHubIssueUrl", () => {
  it("reads public and Enterprise GitHub issue URLs", () => {
    expect(parseGitHubIssueUrl("https://github.com/T3Tools/T3Code/issues/123")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
    expect(
      parseGitHubIssueUrl("https://code.acme.test/platform/api/issues/7#issuecomment-1"),
    ).toEqual({
      host: "code.acme.test",
      repository: "platform/api",
      number: 7,
    });
  });

  it("leaves pull requests and unrelated links alone", () => {
    for (const link of [
      "https://github.com/t3tools/t3code/pull/123",
      "https://github.com/t3tools/t3code/issues/new",
      "https://example.test/t3tools/t3code/issues/not-a-number",
      "not a url",
    ]) {
      expect(parseGitHubIssueUrl(link), link).toBeNull();
    }
  });
});

describe("findProjectForGitHubIssue", () => {
  const project = (identity: Record<string, unknown>) =>
    ({ id: "p1", repositoryIdentity: identity }) as never;

  it("matches the GitHub project by repository and host", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: "github",
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForGitHubIssue(projects, {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7966,
      }),
    ).toBe(projects[0]);
  });

  it("treats a GitHub project without a canonical key as public GitHub", () => {
    const projects = [
      project({
        provider: "github",
        displayName: "pingdotgg/t3code",
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForGitHubIssue(projects, {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7966,
      }),
    ).toBe(projects[0]);
  });

  it("does not claim another host or a non-GitHub project", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: "github",
        owner: "pingdotgg",
        name: "t3code",
      }),
      project({
        canonicalKey: "gitlab.com/pingdotgg/t3code",
        provider: "gitlab",
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForGitHubIssue(projects, {
        host: "github.acme.test",
        repository: "pingdotgg/t3code",
        number: 1,
      }),
    ).toBeUndefined();
    expect(
      findProjectForGitHubIssue([projects[1]!], {
        host: "gitlab.com",
        repository: "pingdotgg/t3code",
        number: 1,
      }),
    ).toBeUndefined();
  });
});

describe("findProjectForGitHubLink", () => {
  const project = (id: string, identity: Record<string, unknown>) =>
    ({ id, repositoryIdentity: identity }) as never;

  it("uses the active GitHub project for another repository on the same host", () => {
    const projects = [
      project("p1", {
        canonicalKey: "github.com/RSI-Software/t3code-hyprws",
        provider: "github",
        owner: "RSI-Software",
        name: "t3code-hyprws",
      }),
    ];

    expect(
      findProjectForGitHubLink(
        projects,
        { host: "github.com", repository: "pingdotgg/t3code", number: 6540 },
        "p1",
      ),
    ).toBe(projects[0]);
  });

  it("does not borrow credentials from another host or provider", () => {
    const projects = [
      project("github", {
        canonicalKey: "github.com/acme/repo",
        provider: "github",
        owner: "acme",
        name: "repo",
      }),
      project("gitlab", {
        canonicalKey: "gitlab.com/acme/repo",
        provider: "gitlab",
        owner: "acme",
        name: "repo",
      }),
    ];

    expect(
      findProjectForGitHubLink(
        projects,
        { host: "github.acme.test", repository: "other/repo", number: 1 },
        "github",
      ),
    ).toBeUndefined();
    expect(
      findProjectForGitHubLink(
        projects,
        { host: "gitlab.com", repository: "other/repo", number: 1 },
        "gitlab",
      ),
    ).toBeUndefined();
  });
});
