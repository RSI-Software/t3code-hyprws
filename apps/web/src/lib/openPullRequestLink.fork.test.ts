import { describe, expect, it } from "vite-plus/test";

import {
  findProjectPreferredFork,
  linkedRepositoryFork,
  openGitHubIssueLinkFork,
  parseGitHubIssueUrl,
} from "./openPullRequestLink.fork";

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

describe("findProjectPreferredFork", () => {
  const project = (id: string, identity: Record<string, unknown>) =>
    ({ id, repositoryIdentity: identity }) as never;

  const active = project("p-active", {
    canonicalKey: "github.com/acme/active",
    provider: "github",
    owner: "acme",
    name: "active",
  });
  const other = project("p-other", {
    canonicalKey: "github.com/acme/other",
    provider: "github",
    owner: "acme",
    name: "other",
  });
  const issue = { host: "github.com", repository: "acme/unchecked-out", number: 9 };

  it("resolves the active project first on the link's host when nothing is checked out", () => {
    expect(findProjectPreferredFork([other, active], issue, "p-active")).toMatchObject({
      id: "p-active",
    });
    expect(findProjectPreferredFork([active, other], issue, "p-other")).toMatchObject({
      id: "p-other",
    });
  });

  it("keeps the exact checkout ahead of the preference, then falls back by list order", () => {
    const exact = project("p-exact", {
      canonicalKey: "github.com/acme/unchecked-out",
      provider: "github",
      owner: "acme",
      name: "unchecked-out",
    });
    expect(findProjectPreferredFork([other, active, exact], issue, "p-other")).toMatchObject({
      id: "p-exact",
    });
    expect(findProjectPreferredFork([other, active], issue)).toMatchObject({ id: "p-other" });
  });

  it("matches nothing when no project shares the link's host", () => {
    const gitlab = project("p-gitlab", {
      canonicalKey: "gitlab.com/acme/repo",
      provider: "gitlab",
      owner: "acme",
      name: "repo",
    });
    expect(findProjectPreferredFork([gitlab], issue, "p-gitlab")).toBeUndefined();
  });
});

describe("linkedRepositoryFork", () => {
  it("uses the identity's own spelling when the link refers to it", () => {
    const project = {
      repositoryIdentity: { provider: "github", owner: "Acme", name: "Repo" },
    } as never;
    expect(linkedRepositoryFork(project, "acme/repo")).toBe("Acme/Repo");
    expect(linkedRepositoryFork(project, "acme/other")).toBe("acme/other");
  });
});

describe("openGitHubIssueLinkFork", () => {
  const capabilities = (githubIssues: boolean) => ({
    environment: { capabilities: { githubIssues } },
  });
  const claimEvent = () => {
    const calls: string[] = [];
    return {
      calls,
      event: {
        metaKey: false,
        ctrlKey: false,
        preventDefault: () => calls.push("preventDefault"),
        stopPropagation: () => calls.push("stopPropagation"),
      },
    };
  };

  it("claims an issue link and stops the default navigation", () => {
    const { event, calls } = claimEvent();
    const claimed = openGitHubIssueLinkFork({
      event,
      targetUrl: "https://github.com/acme/checked-out/issues/9",
      resolvedThreadRef: undefined,
      allProjects: [
        {
          id: "p1",
          environmentId: "env-1",
          repositoryIdentity: {
            provider: "github",
            owner: "acme",
            name: "checked-out",
            canonicalKey: "github.com/acme/checked-out",
          },
        } as never,
      ],
      serverConfigs: new Map([["env-1", capabilities(true)]]) as never,
      primaryEnvironmentId: "env-1" as never,
      navigate: (() => undefined) as never,
    });
    expect(claimed).toBe(true);
    expect(calls).toEqual(["preventDefault", "stopPropagation"]);
  });

  it("leaves links alone when no project with the issue capability matches", () => {
    const { event } = claimEvent();
    expect(
      openGitHubIssueLinkFork({
        event,
        targetUrl: "https://github.com/acme/unknown/issues/9",
        resolvedThreadRef: undefined,
        allProjects: [],
        serverConfigs: new Map(),
        primaryEnvironmentId: "env-1" as never,
        navigate: (() => undefined) as never,
      }),
    ).toBe(false);
  });
});
