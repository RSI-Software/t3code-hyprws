// Fork-owned: the sidebar's GitHub Issues utility entry for commit
// `9f92309411` (feat(issues): add GitHub Issues surface scoped to project
// windows). The upstream `SidebarChrome.tsx` carries only marked hook lines
// pointing here: the capability probe, the navigation callback, the footer
// page detection, and the rendered entry.
import { useCallback } from "react";
import type { useNavigate } from "@tanstack/react-router";

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

/** True on the Issues page, which replaces the utility row with Back like the upstream utility pages. */
export const isSidebarGitHubIssuesLocationFork = (location: { readonly pathname: string }) =>
  location.pathname === "/issues";

/** The utility entry's navigation callback. */
export const useGitHubIssuesSidebarNavigateFork = (deps: {
  closeMobileSidebar: () => void;
  navigate: ReturnType<typeof useNavigate>;
}): (() => void) =>
  useCallback(() => {
    deps.closeMobileSidebar();
    void deps.navigate({
      to: "/issues",
      search: { state: "open" },
    });
  }, [deps.closeMobileSidebar, deps.navigate]);
