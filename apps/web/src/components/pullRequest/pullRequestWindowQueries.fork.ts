// Fork-owned: which projects each server is asked about when the list shows a
// window's filter (RSI-Software/t3code-hyprws#1347). Upstream's split counts a
// server's projects to decide whether its read needs a project filter at all;
// with a window filter the listed projects are a subset, so the count has to
// come from every project the server holds, or the filter is always dropped.
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  assignProjectsToEnvironments,
  type AssignableProject,
} from "./pullRequestProjectAssignment.logic";

export interface PullRequestEnvironmentQuery {
  readonly environmentId: EnvironmentId;
  readonly projectIds?: ReadonlyArray<ProjectId>;
}

/**
 * One read per server that lists something: `listed` is what the page shows
 * (the window's projects), `held` every project the readable servers hold. A
 * server listing all it holds is read without a project filter.
 */
export function pullRequestEnvironmentQueriesFork(input: {
  readonly listed: ReadonlyArray<AssignableProject>;
  readonly held: ReadonlyArray<AssignableProject>;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}): ReadonlyArray<PullRequestEnvironmentQuery> {
  const { listed, held, environmentIds } = input;
  const assignment = assignProjectsToEnvironments(listed, environmentIds, environmentIds[0]);
  const totals = new Map<EnvironmentId, number>();
  for (const project of held) {
    totals.set(project.environmentId, (totals.get(project.environmentId) ?? 0) + 1);
  }
  return environmentIds.flatMap((environmentId) => {
    const projectIds = assignment.get(environmentId);
    if (projectIds === undefined) return [];
    if (projectIds.length === (totals.get(environmentId) ?? 0)) return [{ environmentId }];
    return [{ environmentId, projectIds }];
  });
}
