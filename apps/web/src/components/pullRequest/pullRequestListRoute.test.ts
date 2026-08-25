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
