import { describe, expect, it } from "vite-plus/test";

import { validatePullRequestsSearch } from "./_chat.pull-requests";

describe("project-window pull request search", () => {
  it("preserves the upstream search contract with the all-project scope override", () => {
    expect(
      validatePullRequestsSearch({
        involvement: "authored",
        state: "merged",
        environmentId: "environment-1",
        projectId: "project-1",
        host: "github.example.com",
        repository: "owner/repository",
        number: 42,
        selectedProjectId: "project-2",
        selectedEnvironmentId: "environment-2",
        q: "fix this",
        draft: "hide",
        review: "approved",
        checks: "passing",
        sort: "largest",
        author: "  octocat  ",
        labels: ["bug", "BUG", " ", "regression"],
        scope: "all",
      }),
    ).toEqual({
      involvement: "authored",
      state: "merged",
      sort: "largest",
      repository: "owner/repository",
      number: 42,
      projectId: "project-1",
      environmentId: "environment-1",
      host: "github.example.com",
      selectedProjectId: "project-2",
      selectedEnvironmentId: "environment-2",
      q: "fix this",
      draft: "hide",
      review: "approved",
      checks: "passing",
      author: "octocat",
      labels: ["bug", "regression"],
      scope: "all",
    });
  });

  it("rejects invalid scope without changing upstream defaults and bounds", () => {
    expect(
      validatePullRequestsSearch({
        involvement: "unknown",
        state: "unknown",
        number: 0,
        q: "q".repeat(250),
        host: "h".repeat(250),
        repository: "r".repeat(250),
        scope: "project",
      }),
    ).toEqual({
      involvement: "all",
      state: "open",
      repository: "r".repeat(200),
      host: "h".repeat(200),
      q: "q".repeat(200),
    });
  });
});
