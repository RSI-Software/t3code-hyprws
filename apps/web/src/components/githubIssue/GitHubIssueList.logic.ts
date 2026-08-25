import type { EnvironmentId, GitHubIssueListInput, ProjectId } from "@t3tools/contracts";

import type { WindowProjectListScope } from "../../windowProjectScope";
import type { GitHubIssueQueryTarget } from "../../state/githubIssues";

export function resolveGitHubIssueQueryTargets(input: {
  readonly capableEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly listScope: WindowProjectListScope;
  readonly state: GitHubIssueListInput["state"];
  readonly projectId?: ProjectId;
  readonly query?: string;
  readonly limit?: number;
}): ReadonlyArray<GitHubIssueQueryTarget> {
  const projectScope = input.listScope.kind === "project" ? input.listScope.projectRef : null;
  const environmentIds =
    projectScope === null
      ? input.capableEnvironmentIds
      : input.capableEnvironmentIds.filter(
          (environmentId) => environmentId === projectScope.environmentId,
        );
  const projectId = projectScope?.projectId ?? input.projectId;
  return environmentIds.map((environmentId) => ({
    environmentId,
    input: {
      state: input.state,
      limit: input.limit ?? 50,
      ...(projectId ? { projectId } : {}),
      ...(input.query ? { query: input.query } : {}),
    },
  }));
}
