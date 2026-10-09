// Fork-owned: each desktop window reports the projects its filter shows, so
// tools outside the app can find the window a project's work lives in
// (`apps/desktop/src/window/WindowProjectManifest.fork.ts`).
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  projectFilterProjectKeys,
  type ProjectFilter,
} from "@t3tools/client-runtime/state/project-filter";
import type {
  DesktopBridge,
  DesktopWindowProjectScope,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useAllEnvironmentProjectSnapshotsReady, useProjects } from "./state/entities";
import { pendingWindowScopeSeed, windowProjectFilterState } from "./windowSidebarScope.fork";

/**
 * The scope a window's filter shows: every project when the filter is empty,
 * else each member project the client knows, with its checkout. A member the
 * client does not know, such as a removed project, is left out.
 */
export function windowProjectScope(
  filter: ProjectFilter,
  projects: ReadonlyArray<EnvironmentProject>,
): DesktopWindowProjectScope {
  if (filter.entries.length === 0) return { kind: "all" };
  if (filter.mode === "exclude") {
    const keys = projectFilterProjectKeys(
      filter,
      projects.map((project) => scopeProjectRef(project.environmentId, project.id)),
    )!;
    return {
      kind: "projects",
      projects: projects
        .filter((project) =>
          keys.has(scopedProjectKey(scopeProjectRef(project.environmentId, project.id))),
        )
        .map((project) => ({
          environmentId: project.environmentId,
          projectId: project.id,
          workspaceRoot: project.workspaceRoot,
        })),
    };
  }
  const seen = new Set<string>();
  const shown = filter.entries.flatMap((entry) =>
    entry.members.flatMap((member) => {
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === member.environmentId && candidate.id === member.projectId,
      );
      const key = `${member.environmentId}\u0000${member.projectId}`;
      if (project === undefined || seen.has(key)) return [];
      seen.add(key);
      return [
        {
          environmentId: member.environmentId,
          projectId: member.projectId,
          workspaceRoot: project.workspaceRoot,
        },
      ];
    }),
  );
  return { kind: "projects", projects: shown };
}

/**
 * The scope to publish, or `null` while a member's checkout is still unknown:
 * a partial scope would turn its window away. Only an unknown member waits for
 * every environment to settle, so one unreachable environment never holds back
 * a window that does not show it. A seed project still pending is what the
 * window shows (`windowLandingProjects`).
 */
export function publishedWindowScope(input: {
  readonly filter: ProjectFilter;
  readonly pendingSeed: ScopedProjectRef | null;
  readonly settled: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}): DesktopWindowProjectScope | null {
  const filter =
    input.pendingSeed === null
      ? input.filter
      : { entries: [{ key: "seed", members: [input.pendingSeed] }] };
  const known = filter.entries.every((entry) =>
    entry.members.every((member) =>
      input.projects.some(
        (project) =>
          project.environmentId === member.environmentId && project.id === member.projectId,
      ),
    ),
  );
  if (filter.mode !== "exclude" && !known && !input.settled) return null;
  return windowProjectScope(filter, input.projects);
}

/**
 * Publishes this window's scope whenever it changes; a no-op off desktop. Reads
 * the window's own filter, which holds with or without the sidebar mounted.
 */
export function usePublishWindowProjectsFork(
  bridge: DesktopBridge | undefined = window.desktopBridge,
): void {
  const state = windowProjectFilterState();
  const filter = useSyncExternalStore(state.subscribe, state.get);
  const settled = useAllEnvironmentProjectSnapshotsReady();
  const projects = useProjects();
  // Read on each change of the inputs: the seed only ever goes from pending to
  // applied, and applying it changes `filter`.
  const pendingSeed = pendingWindowScopeSeed();
  // Keyed by content, so a project update that changes no checkout never republishes.
  const payload = useMemo(() => {
    const scope = publishedWindowScope({ filter, pendingSeed, settled, projects });
    return scope === null ? null : JSON.stringify(scope);
  }, [filter, pendingSeed, settled, projects]);
  const windowId = bridge?.windowId;
  const publish = bridge?.publishWindowProjects;
  useEffect(() => {
    if (payload === null || windowId === undefined || publish === undefined) return;
    void publish({ windowId, scope: JSON.parse(payload) as DesktopWindowProjectScope }).catch(
      () => undefined,
    );
  }, [payload, publish, windowId]);
}
