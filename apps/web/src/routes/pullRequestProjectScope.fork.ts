// Fork-owned project-window scope for the pull-request list routes. The hub route and the
// project-window route render one shared page; this module is the single fork seam both carry
// (see `FORK_HOOKS`, RSI-Software/t3code-hyprws#952). Upstream files keep marked hook lines
// only; every scope computation lives here.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import { useMemo } from "react";

import {
  type PullRequestProjectScopeSearch,
  normalizePullRequestProjectScopePatch,
  resolvePullRequestProjectScope,
  usePullRequestProjectScope,
} from "../components/pullRequest/PullRequestProjectScope";
import { WindowProjectScopeToggle } from "../components/WindowProjectScopeToggle";

export { WindowProjectScopeToggle };
export { normalizePullRequestProjectScopePatch };
export { resolvePullRequestProjectScope };
export type { ScopedProjectRef };
export type { PullRequestProjectScopeSearch };

interface PullRequestScopeEnvironment {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: unknown | null;
}

/** Everything the page needs from the project-window context, resolved in one call. */
export interface PullRequestWindowScope {
  readonly projectId: ProjectId | undefined;
  readonly projectEnvironmentId: EnvironmentId | undefined;
  readonly showHubScopeFilters: boolean;
}

/**
 * The one fork hook the pull-request routes carry. Returns the window's project scope —
 * `projectId` / `projectEnvironmentId` for the forced project window, hub resolution
 * otherwise — plus the list scope toggle state, from the project-window context.
 */
export function usePullRequestProjectWindowScope(input: {
  readonly forcedProjectRef: ScopedProjectRef | null;
  readonly search: PullRequestProjectScopeSearch;
  readonly environments: ReadonlyArray<PullRequestScopeEnvironment>;
  readonly capableEnvironments: ReadonlyArray<PullRequestScopeEnvironment>;
  readonly allProjects: ReadonlyArray<EnvironmentProject>;
}) {
  const capableEnvironmentIds = useMemo(
    () => input.capableEnvironments.map((environment) => environment.environmentId),
    [input.capableEnvironments],
  );
  return usePullRequestProjectScope({ ...input, capableEnvironmentIds });
}

/** Pure view of the window scope for a resolved list scope; the hook renders this. */
export function resolvePullRequestWindowScope(input: {
  readonly forcedProjectRef: ScopedProjectRef | null;
  readonly listScope: { readonly kind: "all" | "project" };
}): PullRequestWindowScope {
  const forced = input.listScope.kind === "project" ? input.forcedProjectRef : null;
  return {
    projectId: forced?.projectId,
    projectEnvironmentId: forced?.environmentId,
    showHubScopeFilters: input.forcedProjectRef === null,
  };
}
