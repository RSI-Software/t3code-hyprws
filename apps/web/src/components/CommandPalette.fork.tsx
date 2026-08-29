// Fork-owned: the command-palette "Go to Issues" entry for commit `9f92309411`
// (feat(issues): add GitHub Issues surface scoped to project windows). The
// upstream `CommandPalette.tsx` carries only marked hook lines pointing here;
// the capability probe, the navigation command, and the action item are built
// in this module.
import { CircleDotIcon } from "lucide-react";

import { listRouteTarget, resolveProjectRefFromPathname } from "../projectRoutes";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";
import type { ScopedProjectRef } from "@t3tools/contracts";

/** Where the Issues route should open: the hub, or the current project window. */
export function buildIssuesNavigationCommand(projectRef: ScopedProjectRef | null) {
  return {
    value: "action:issues",
    title: "Go to Issues",
    searchTerms: ["issues", "github", "bugs", "go to"],
    target:
      projectRef === null ? ({ kind: "hub" } as const) : ({ kind: "project", projectRef } as const),
  };
}

/**
 * The palette's Issues navigation entry, or `null` when no reachable
 * environment advertises the read-only GitHub Issues capability.
 */
export function buildGitHubIssuesActionItemFork(input: {
  pathname: string;
  environments: ReadonlyArray<{
    readonly serverConfig?: {
      readonly environment: { readonly capabilities: { readonly githubIssues?: boolean } };
    } | null;
  }>;
  navigate: (options: never) => Promise<void>;
}): CommandPaletteActionItem | null {
  const githubIssuesSupported = input.environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.githubIssues === true,
  );
  if (!githubIssuesSupported) return null;
  const issuesCommand = buildIssuesNavigationCommand(resolveProjectRefFromPathname(input.pathname));
  return {
    kind: "action",
    value: issuesCommand.value,
    searchTerms: issuesCommand.searchTerms,
    title: issuesCommand.title,
    icon: <CircleDotIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await input.navigate({
        ...listRouteTarget(
          "issues",
          issuesCommand.target.kind === "project" ? issuesCommand.target.projectRef : null,
        ),
        search: { state: "open" },
      } as never);
    },
  };
}
