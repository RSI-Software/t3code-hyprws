import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveGitHubIssueQueryTargets } from "./GitHubIssueList.logic";

const environmentA = "environment-a" as EnvironmentId;
const environmentB = "environment-b" as EnvironmentId;
const projectId = "project-1" as ProjectId;

describe("GitHub issue list queries", () => {
  it("asks only the owning environment in project scope", () => {
    expect(
      resolveGitHubIssueQueryTargets({
        capableEnvironmentIds: [environmentA, environmentB],
        listScope: { kind: "project", projectRef: { environmentId: environmentB, projectId } },
        state: "open",
      }),
    ).toStrictEqual([
      { environmentId: environmentB, input: { state: "open", limit: 50, projectId } },
    ]);
  });

  it("fans all scope out to every capable environment", () => {
    expect(
      resolveGitHubIssueQueryTargets({
        capableEnvironmentIds: [environmentA, environmentB],
        listScope: { kind: "all" },
        state: "closed",
        query: "bug",
      }),
    ).toHaveLength(2);
  });
});
