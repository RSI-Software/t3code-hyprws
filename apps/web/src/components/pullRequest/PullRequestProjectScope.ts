import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

import {
  allEnvironmentShellsBootstrappedAtom,
  environmentShellBootstrappedAtom,
} from "../../state/shell";
import {
  type WindowProjectListScope,
  type WindowProjectScopeParam,
  useWindowProjectListScope,
} from "../../windowProjectScope";
import { findScopedProject, resolveProjectScope } from "./pullRequestList.logic";

export interface PullRequestProjectScopeSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly scope?: WindowProjectScopeParam;
}

interface PullRequestScopeEnvironment {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: unknown | null;
}

interface PullRequestScopeProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
}

interface PullRequestProjectScopeResolution<Project extends PullRequestScopeProject> {
  readonly scopedEnvironmentId: EnvironmentId | null;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly capabilityKnown: boolean;
  readonly projects: ReadonlyArray<Project>;
  readonly scopedProjectId: ProjectId | undefined;
  readonly scopedProject: Project | undefined;
}

export function resolvePullRequestProjectScope<Project extends PullRequestScopeProject>(input: {
  readonly forcedProjectRef: ScopedProjectRef | null;
  readonly listScope: WindowProjectListScope;
  readonly search: PullRequestProjectScopeSearch;
  readonly environments: ReadonlyArray<PullRequestScopeEnvironment>;
  readonly capableEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly allProjects: ReadonlyArray<Project>;
  readonly projectsKnown: boolean;
}): PullRequestProjectScopeResolution<Project> {
  const forcedProjectScope = input.listScope.kind === "project" ? input.forcedProjectRef : null;
  const requestedEnvironmentId = forcedProjectScope?.environmentId ?? input.search.environmentId;
  const scopedEnvironmentId =
    input.capableEnvironmentIds.find((environmentId) => environmentId === requestedEnvironmentId) ??
    null;
  const environmentIds = input.capableEnvironmentIds.filter((environmentId) =>
    forcedProjectScope === null
      ? scopedEnvironmentId === null || environmentId === scopedEnvironmentId
      : environmentId === forcedProjectScope.environmentId,
  );
  const capabilityKnown =
    forcedProjectScope === null
      ? input.environments.some((environment) => environment.serverConfig !== null)
      : input.environments.some(
          (environment) =>
            environment.environmentId === forcedProjectScope.environmentId &&
            environment.serverConfig !== null,
        );
  const environmentIdSet = new Set(environmentIds);
  const projects = input.allProjects.filter((project) =>
    environmentIdSet.has(project.environmentId),
  );
  const scopedProjectId =
    forcedProjectScope?.projectId ??
    (input.forcedProjectRef === null
      ? resolveProjectScope(input.search.projectId, projects, input.projectsKnown)
      : undefined);
  const scopedProject = findScopedProject(
    projects,
    forcedProjectScope?.environmentId ?? scopedEnvironmentId,
    scopedProjectId,
  );

  return {
    scopedEnvironmentId,
    environmentIds,
    capabilityKnown,
    projects,
    scopedProjectId,
    scopedProject,
  };
}

export function usePullRequestProjectScope({
  forcedProjectRef,
  search,
  environments,
  capableEnvironmentIds,
  allProjects,
}: {
  readonly forcedProjectRef: ScopedProjectRef | null;
  readonly search: PullRequestProjectScopeSearch;
  readonly environments: ReadonlyArray<PullRequestScopeEnvironment>;
  readonly capableEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly allProjects: ReadonlyArray<EnvironmentProject>;
}) {
  const { listScope, onScopeChange } = useWindowProjectListScope(forcedProjectRef, search.scope);
  const forcedProjectScope = listScope.kind === "project" ? listScope.projectRef : null;
  const projectsKnown = useAtomValue(
    forcedProjectScope === null
      ? allEnvironmentShellsBootstrappedAtom
      : environmentShellBootstrappedAtom(forcedProjectScope.environmentId),
  );
  const resolution = resolvePullRequestProjectScope({
    forcedProjectRef,
    search,
    environments,
    capableEnvironmentIds,
    allProjects,
    listScope,
    projectsKnown,
  });

  return {
    ...resolution,
    projectsKnown,
    listScope,
    onScopeChange,
    showHubScopeFilters: forcedProjectRef === null,
  };
}

export function normalizePullRequestProjectScopePatch<
  Patch extends Partial<Record<keyof PullRequestProjectScopeSearch, unknown>>,
>(patch: Patch, forcedProjectRef: ScopedProjectRef | null) {
  return forcedProjectRef === null
    ? patch
    : { ...patch, environmentId: undefined, projectId: undefined };
}
