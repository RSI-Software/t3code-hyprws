import type { EnvironmentId, IssueListInput, ProjectId } from "@t3tools/contracts";

import type { IssueQueryTarget } from "../../state/issues";

interface IssueQueryProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

/**
 * The issue reads for one list. A picked project reads only that project;
 * otherwise `windowProjects` names what "all projects" covers (`null` = every
 * project, one read per environment).
 */
export function resolveIssueQueryTargets(input: {
  readonly capableEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly windowProjects: ReadonlyArray<IssueQueryProject> | null;
  readonly state: IssueListInput["state"];
  readonly scopedProject?: {
    readonly projectId: ProjectId;
    readonly environmentId: EnvironmentId | undefined;
  };
  readonly query?: string;
  readonly limit?: number;
}): ReadonlyArray<IssueQueryTarget> {
  const read = (environmentId: EnvironmentId, projectId?: ProjectId): IssueQueryTarget => ({
    environmentId,
    input: {
      state: input.state,
      limit: input.limit ?? 50,
      ...(projectId ? { projectId } : {}),
      ...(input.query ? { query: input.query } : {}),
    },
  });
  const scoped = input.scopedProject;
  if (scoped !== undefined) {
    return input.capableEnvironmentIds
      .filter(
        (environmentId) =>
          scoped.environmentId === undefined || environmentId === scoped.environmentId,
      )
      .map((environmentId) => read(environmentId, scoped.projectId));
  }
  if (input.windowProjects === null) {
    return input.capableEnvironmentIds.map((environmentId) => read(environmentId));
  }
  const capable = new Set(input.capableEnvironmentIds);
  return input.windowProjects
    .filter((project) => capable.has(project.environmentId))
    .map((project) => read(project.environmentId, project.id));
}
