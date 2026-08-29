// Fork-owned: the sidebar's GitHub Issues utility entry for commit
// `9f92309411` (feat(issues): add GitHub Issues surface scoped to project
// windows). The upstream `SidebarChrome.tsx` carries only marked hook lines
// pointing here: the capability probe, the navigation callback, the footer
// page detection, and the rendered entry.
import { CircleDotIcon } from "lucide-react";
import { useCallback } from "react";
import type { useNavigate } from "@tanstack/react-router";

import type { ScopedProjectRef } from "@t3tools/contracts";

type Environments = ReadonlyArray<{
  readonly serverConfig?: {
    readonly environment: { readonly capabilities: { readonly githubIssues?: boolean } };
  } | null;
}>;

/** True when any reachable environment advertises the read-only GitHub Issues capability. */
export const sidebarGitHubIssuesSupportedFork = (environments: Environments): boolean =>
  environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.githubIssues === true,
  );

/** The footer page label for the Issues routes, or `null` when the path is not an Issues route. */
export const resolveSidebarGitHubIssuesPageFork = (
  pathname: string,
  projectRef: ScopedProjectRef | null,
): "github-issues" | null =>
  pathname === "/issues" || (projectRef !== null && pathname.endsWith("/issues"))
    ? "github-issues"
    : null;

/** The utility entry's navigation callback: project-scoped Issues when inside a project window. */
export const useGitHubIssuesSidebarNavigateFork = (deps: {
  closeMobileSidebar: () => void;
  navigate: ReturnType<typeof useNavigate>;
  projectRef: ScopedProjectRef | null;
}): (() => void) =>
  useCallback(() => {
    deps.closeMobileSidebar();
    if (deps.projectRef !== null) {
      void deps.navigate({
        to: "/project/$environmentId/$projectId/issues",
        params: deps.projectRef,
        search: { state: "open" },
      });
      return;
    }
    void deps.navigate({ to: "/issues", search: { state: "open" } });
  }, [deps.closeMobileSidebar, deps.navigate, deps.projectRef]);

/** The navigation callback handler wired through the marked JSX hook pair. */
