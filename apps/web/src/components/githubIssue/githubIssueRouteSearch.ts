import type { EnvironmentGitHubIssueRef } from "@t3tools/client-runtime/state/github-issues";
import type { EnvironmentId, GitHubIssueListState, ProjectId } from "@t3tools/contracts";

import type { WindowProjectScopeParam } from "../../windowProjectScope";

export interface IssuesSearch {
  readonly state: GitHubIssueListState;
  readonly q?: string;
  readonly projectId?: ProjectId;
  readonly environmentId?: EnvironmentId;
  readonly selectedEnvironmentId?: EnvironmentId;
  readonly selectedProjectId?: ProjectId;
  readonly repository?: string;
  readonly number?: number;
  readonly scope?: WindowProjectScopeParam;
}

export function validateGitHubIssueSearch(raw: Record<string, unknown>): IssuesSearch {
  const selection =
    typeof raw.selectedEnvironmentId === "string" &&
    raw.selectedEnvironmentId.length > 0 &&
    typeof raw.selectedProjectId === "string" &&
    raw.selectedProjectId.length > 0 &&
    typeof raw.repository === "string" &&
    raw.repository.length > 0 &&
    typeof raw.number === "number" &&
    Number.isSafeInteger(raw.number) &&
    raw.number > 0
      ? {
          selectedEnvironmentId: raw.selectedEnvironmentId as EnvironmentId,
          selectedProjectId: raw.selectedProjectId as ProjectId,
          repository: raw.repository.slice(0, 200),
          number: raw.number,
        }
      : {};
  return {
    state: raw.state === "all" || raw.state === "closed" ? raw.state : "open",
    ...(typeof raw.q === "string" && raw.q.trim().length > 0 ? { q: raw.q.slice(0, 200) } : {}),
    ...(typeof raw.projectId === "string" && raw.projectId.length > 0
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId.length > 0
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...selection,
    ...(raw.scope === "all" ? { scope: raw.scope } : {}),
  };
}

export function selectedGitHubIssueRef(search: IssuesSearch): EnvironmentGitHubIssueRef | null {
  return search.selectedEnvironmentId &&
    search.selectedProjectId &&
    search.repository &&
    search.number
    ? {
        environmentId: search.selectedEnvironmentId,
        projectId: search.selectedProjectId,
        repository: search.repository,
        number: search.number,
      }
    : null;
}
