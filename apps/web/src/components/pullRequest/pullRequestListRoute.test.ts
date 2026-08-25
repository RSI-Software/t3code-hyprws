import { describe, expect, it } from "vite-plus/test";

import { validatePullRequestsSearch } from "./pullRequestListRoute";

describe("validatePullRequestsSearch", () => {
  it("preserves existing hub filters", () => {
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
      }),
    ).toMatchObject({
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
    });
  });

  it("keeps the upstream sort, author, and label filters", () => {
    expect(
      validatePullRequestsSearch({
        sort: "largest",
        author: "  octocat  ",
        labels: ["bug", "BUG", " ", "regression"],
      }),
    ).toMatchObject({
      sort: "largest",
      author: "octocat",
      labels: ["bug", "regression"],
    });
  });

  it("drops an unknown sort and an empty author", () => {
    const search = validatePullRequestsSearch({ sort: "alphabetical", author: "   " });
    expect(search.sort).toBeUndefined();
    expect(search.author).toBeUndefined();
  });

  it("caps labels at ten entries", () => {
    expect(
      validatePullRequestsSearch({
        labels: Array.from({ length: 25 }, (_, index) => `label-${index}`),
      }).labels,
    ).toHaveLength(10);
  });

  it("accepts only the all-projects scope override", () => {
    expect(validatePullRequestsSearch({ scope: "all" }).scope).toBe("all");
    expect(validatePullRequestsSearch({ scope: "project" }).scope).toBeUndefined();
  });

  it("keeps existing defaults and bounds", () => {
    expect(
      validatePullRequestsSearch({
        involvement: "unknown",
        state: "unknown",
        number: 0,
        q: "q".repeat(250),
        host: "h".repeat(250),
        repository: "r".repeat(250),
      }),
    ).toEqual({
      involvement: "all",
      state: "open",
      q: "q".repeat(200),
      host: "h".repeat(200),
      repository: "r".repeat(200),
    });
  });
});
