import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveGitHubIssueQueryTargets } from "./GitHubIssueList.logic";

const environmentA = "environment-a" as EnvironmentId;
const environmentB = "environment-b" as EnvironmentId;
const projectId = "project-1" as ProjectId;
const otherProjectId = "project-2" as ProjectId;

describe("GitHub issue list queries", () => {
  it("asks only the owning environment for a picked project", () => {
    expect(
      resolveGitHubIssueQueryTargets({
        capableEnvironmentIds: [environmentA, environmentB],
        windowProjects: null,
        scopedProject: { environmentId: environmentB, projectId },
        state: "open",
      }),
    ).toStrictEqual([
      { environmentId: environmentB, input: { state: "open", limit: 50, projectId } },
    ]);
  });

  it("fans all projects out to every capable environment when the window shows all", () => {
    expect(
      resolveGitHubIssueQueryTargets({
        capableEnvironmentIds: [environmentA, environmentB],
        windowProjects: null,
        state: "closed",
        query: "bug",
      }),
    ).toStrictEqual([
      { environmentId: environmentA, input: { state: "closed", limit: 50, query: "bug" } },
      { environmentId: environmentB, input: { state: "closed", limit: 50, query: "bug" } },
    ]);
  });

  it("reads all projects as the projects in this window's filter", () => {
    expect(
      resolveGitHubIssueQueryTargets({
        capableEnvironmentIds: [environmentA],
        windowProjects: [
          { environmentId: environmentA, id: projectId },
          { environmentId: environmentB, id: otherProjectId },
        ],
        state: "open",
      }),
    ).toStrictEqual([
      { environmentId: environmentA, input: { state: "open", limit: 50, projectId } },
    ]);
  });
});
