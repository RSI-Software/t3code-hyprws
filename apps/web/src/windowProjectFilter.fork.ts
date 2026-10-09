// The sidebar's view of this window's project filter
// (RSI-Software/t3code-hyprws#1351). The filter itself lives with the
// per-window record in `windowSidebarScope.fork.ts`.
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  projectFilterProjectKeys,
  projectFilterScopeKey,
  reconcileProjectFilter,
} from "@t3tools/client-runtime/state/project-filter";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { useAllEnvironmentProjectSnapshotsReady, useProjects } from "./state/entities";
import { pendingWindowScopeSeed, windowProjectFilterState } from "./windowSidebarScope.fork";

/**
 * Follows this window's filter onto the sidebar's current project groups and
 * projects it for upstream: `scopeKey` is the one entry's key, else `null`,
 * `projectKeys` the scoped project keys the list shows (`null` = all). The
 * chooser reads `filter` and writes through `setFilter`.
 */
export function useWindowProjectFilter(
  projectGroups: ReadonlyArray<{
    readonly projectKey: string;
    readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
  }>,
) {
  const state = windowProjectFilterState();
  const stored = useSyncExternalStore(state.subscribe, state.get);
  const settled = useAllEnvironmentProjectSnapshotsReady();
  const groups = projectGroups.map((group) => ({
    key: group.projectKey,
    members: group.memberProjectRefs,
  }));
  const filter = reconcileProjectFilter(stored, groups, settled);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the reconciled filter back to the external window filter store.
  useEffect(() => {
    if (filter !== stored) state.set(filter);
  }, [filter, state, stored]);
  return {
    filter,
    setFilter: state.set,
    scopeKey: projectFilterScopeKey(filter),
    projectKeys: projectFilterProjectKeys(
      filter,
      groups.flatMap((group) => group.members),
    ),
  };
}

/** Runs `onChange` after every write to this window's filter. */
export function useWindowProjectFilterChange(onChange: () => void) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the external window filter store.
  useEffect(() => windowProjectFilterState().subscribe(onChange), [onChange]);
}

interface WindowFilterableProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

/** The projects `projectKeys` shows; `null` keys show every project. */
export function filterProjectsToWindow<Project extends WindowFilterableProject>(
  projects: ReadonlyArray<Project>,
  projectKeys: ReadonlySet<string> | null,
): ReadonlyArray<Project> {
  if (projectKeys === null) return projects;
  return projects.filter((project) =>
    projectKeys.has(scopedProjectKey(scopeProjectRef(project.environmentId, project.id))),
  );
}

/** The scoped project keys this window's filter shows; `null` shows every project. */
export function useWindowProjectKeys(): ReadonlySet<string> | null {
  const state = windowProjectFilterState();
  const stored = useSyncExternalStore(state.subscribe, state.get);
  const projects = useProjects();
  return projectFilterProjectKeys(
    stored,
    projects.map((project) => scopeProjectRef(project.environmentId, project.id)),
  );
}

/** A project a link names explicitly; `environmentId` is absent on older links. */
export interface LinkedProject {
  readonly projectId: ProjectId | undefined;
  readonly environmentId: EnvironmentId | undefined;
}

/**
 * The projects a list page offers: those the window's filter shows, plus the
 * project a link names when it sits outside the filter. An explicit link is an
 * explicit request, so the page reads it rather than silently dropping it.
 */
export function windowListProjects<Project extends WindowFilterableProject>(
  projects: ReadonlyArray<Project>,
  projectKeys: ReadonlySet<string> | null,
  linked: LinkedProject,
): ReadonlyArray<Project> {
  const shown = filterProjectsToWindow(projects, projectKeys);
  if (shown === projects || linked.projectId === undefined) return shown;
  const outside = projects.filter(
    (project) =>
      project.id === linked.projectId &&
      (linked.environmentId === undefined || project.environmentId === linked.environmentId) &&
      !shown.includes(project),
  );
  return outside.length === 0 ? shown : [...shown, ...outside];
}

/** `windowListProjects` for this window's filter. */
export function useWindowListProjects<Project extends WindowFilterableProject>(
  projects: ReadonlyArray<Project>,
  linked: LinkedProject,
): ReadonlyArray<Project> {
  const projectKeys = useWindowProjectKeys();
  const { projectId, environmentId } = linked;
  return windowListProjects(projects, projectKeys, { projectId, environmentId });
}

/**
 * The projects a window's landing draft may start in: the seed project while
 * the sidebar has not applied it yet, else the filter's projects. A filter
 * whose projects are not loaded falls back to every project, so the landing
 * never reads as "no projects".
 */
export function windowLandingProjects<Project extends WindowFilterableProject>(
  projects: ReadonlyArray<Project>,
  projectKeys: ReadonlySet<string> | null,
  pendingSeed: ScopedProjectRef | null,
  fallbackToAll = true,
): ReadonlyArray<Project> {
  const seeded =
    pendingSeed === null
      ? []
      : projects.filter(
          (project) =>
            project.environmentId === pendingSeed.environmentId &&
            project.id === pendingSeed.projectId,
        );
  if (seeded.length > 0) return seeded;
  const shown = filterProjectsToWindow(projects, projectKeys);
  return shown.length > 0 || !fallbackToAll ? shown : projects;
}

/** `windowLandingProjects` for this window. */
export function useWindowLandingProjects<Project extends WindowFilterableProject>(
  projects: ReadonlyArray<Project>,
): ReadonlyArray<Project> {
  const projectKeys = useWindowProjectKeys();
  const state = windowProjectFilterState();
  const filter = useSyncExternalStore(state.subscribe, state.get);
  const fallbackToAll = filter.mode !== "exclude";
  // Read on each change of the inputs: the seed only ever goes from pending to
  // applied, and applying it changes `projectKeys`.
  const pendingSeed = pendingWindowScopeSeed();
  return windowLandingProjects(projects, projectKeys, pendingSeed, fallbackToAll);
}
