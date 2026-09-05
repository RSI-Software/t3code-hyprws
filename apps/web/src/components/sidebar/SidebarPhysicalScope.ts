import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

interface ProjectIdentity {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

interface ProjectGroup {
  readonly projectKey: string;
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
}

export function isProjectInSidebarScope(
  projectRef: ScopedProjectRef,
  forcedProjectRef: ScopedProjectRef | null,
): boolean {
  return (
    forcedProjectRef === null ||
    (projectRef.environmentId === forcedProjectRef.environmentId &&
      projectRef.projectId === forcedProjectRef.projectId)
  );
}

export function filterSidebarProjects<T extends ProjectIdentity>(
  projects: readonly T[],
  forcedProjectRef: ScopedProjectRef | null,
): readonly T[] {
  return forcedProjectRef === null
    ? projects
    : projects.filter((project) =>
        isProjectInSidebarScope(
          { environmentId: project.environmentId, projectId: project.id },
          forcedProjectRef,
        ),
      );
}

export function filterSidebarThreads<T extends ScopedProjectRef>(
  threads: readonly T[],
  forcedProjectRef: ScopedProjectRef | null,
): readonly T[] {
  return forcedProjectRef === null
    ? threads
    : threads.filter((thread) => isProjectInSidebarScope(thread, forcedProjectRef));
}

/** Adapt caller-owned logical selection; storage and upstream grouping stay with the caller. */
export function resolveSidebarPhysicalScope<T extends ProjectGroup>(input: {
  readonly forcedProjectRef: ScopedProjectRef | null;
  readonly projectGroups: ReadonlyArray<T>;
  readonly logicalScopeKey: string | null;
}) {
  const { forcedProjectRef, projectGroups, logicalScopeKey } = input;
  const projectGroup =
    forcedProjectRef === null
      ? (projectGroups.find((group) => group.projectKey === logicalScopeKey) ?? null)
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some((ref) => isProjectInSidebarScope(ref, forcedProjectRef)),
        ) ?? null);
  const effectiveScopeKey =
    forcedProjectRef === null ? logicalScopeKey : (projectGroup?.projectKey ?? null);
  // Missing metadata must not turn a physical window into the upstream "all" scope.
  const projectKeys =
    forcedProjectRef !== null
      ? new Set([`${forcedProjectRef.environmentId}:${forcedProjectRef.projectId}`])
      : projectGroup === null
        ? null
        : new Set(
            projectGroup.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
          );
  return { projectGroup, effectiveScopeKey, projectKeys };
}

export function setSidebarLogicalScope(
  forcedProjectRef: ScopedProjectRef | null,
  nextScopeKey: string | null,
  setScopeKey: (value: string | null) => void,
): void {
  if (forcedProjectRef === null) setScopeKey(nextScopeKey);
}
