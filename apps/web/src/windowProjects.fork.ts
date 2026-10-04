// Fork-owned: each desktop window reports the projects its filter shows, so
// tools outside the app can find the window a project's work lives in
// (`apps/desktop/src/window/WindowProjectManifest.fork.ts`).
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectFilter } from "@t3tools/client-runtime/state/project-filter";
import type { DesktopBridge, DesktopWindowProjectScope } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { useProjectChooserHostValue } from "./projectChooser.fork";
import { useProjects } from "./state/entities";

/**
 * The scope a window's filter shows: every project when the filter is empty,
 * else each member project the client knows, with its checkout. A member whose
 * environment is offline has no known checkout and is left out.
 */
export function windowProjectScope(
  filter: ProjectFilter,
  projects: ReadonlyArray<EnvironmentProject>,
): DesktopWindowProjectScope {
  if (filter.entries.length === 0) return { kind: "all" };
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

/** Publishes this window's scope whenever it changes; a no-op off desktop. */
export function usePublishWindowProjectsFork(
  bridge: DesktopBridge | undefined = window.desktopBridge,
): void {
  const filter = useProjectChooserHostValue()?.filter ?? null;
  const projects = useProjects();
  // Keyed by content, so a project update that changes no checkout never republishes.
  const payload = useMemo(
    () => (filter === null ? null : JSON.stringify(windowProjectScope(filter, projects))),
    [filter, projects],
  );
  const windowId = bridge?.windowId;
  const publish = bridge?.publishWindowProjects;
  useEffect(() => {
    if (payload === null || windowId === undefined || publish === undefined) return;
    void publish({ windowId, scope: JSON.parse(payload) as DesktopWindowProjectScope }).catch(
      () => undefined,
    );
  }, [payload, publish, windowId]);
}
