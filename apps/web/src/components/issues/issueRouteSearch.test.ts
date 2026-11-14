import { describe, expect, it } from "vite-plus/test";

import { selectedIssueRef, validateIssueSearch } from "./issueRouteSearch";

describe("GitHub issue route search", () => {
  it("validates bounded filters and drops the retired window scope", () => {
    expect(
      validateIssueSearch({
        state: "closed",
        q: "x".repeat(250),
        projectId: "project-1",
        environmentId: "environment-1",
        scope: "all",
      }),
    ).toStrictEqual({
      state: "closed",
      q: "x".repeat(200),
      projectId: "project-1",
      environmentId: "environment-1",
    });
  });

  it.each([
    { selectedEnvironmentId: "e", selectedProjectId: "p", repository: "acme/web" },
    { selectedEnvironmentId: "e", selectedProjectId: "p", number: 1 },
    { selectedEnvironmentId: "e", repository: "acme/web", number: 1 },
    { selectedProjectId: "p", repository: "acme/web", number: 1 },
  ])("drops partial detail selection %#", (partial) => {
    const search = validateIssueSearch({ state: "open", ...partial });
    expect(selectedIssueRef(search)).toBeNull();
    expect(search).not.toHaveProperty("selectedEnvironmentId");
  });

  it("keeps all four detail identity fields together", () => {
    const search = validateIssueSearch({
      state: "open",
      selectedEnvironmentId: "environment-1",
      selectedProjectId: "project-1",
      repository: "acme/web",
      number: 42,
    });
    expect(selectedIssueRef(search)).toStrictEqual({
      environmentId: "environment-1",
      projectId: "project-1",
      repository: "acme/web",
      number: 42,
    });
  });
});
