import { CircleDot, Link2Icon } from "lucide-react";

/** The launcher props the fork issue surfaces read; spread into upstream `RightPanelTabsProps`. */
export interface GitHubIssueSurfaceLauncherPropsFork {
  onAddIssues?: () => void;
  onAddIssueLinks?: () => void;
  issuesAvailable?: boolean;
  issueLinksAvailable?: boolean;
}

const UNSUPPORTED = "Available for GitHub projects on supported servers.";

/** The Issues and Linked issues launcher entries, spread into upstream's surface action list. */
export const githubIssueSurfaceActionsFork = (props: GitHubIssueSurfaceLauncherPropsFork) =>
  [
    {
      label: "Issues",
      description: "Browse this project's GitHub issues.",
      icon: CircleDot,
      shortcut: "I",
      available: props.issuesAvailable === true,
      disabledReason: "GitHub Issues are only available for GitHub projects on supported servers.",
      unavailableHint: UNSUPPORTED,
      onClick: props.onAddIssues ?? (() => undefined),
    },
    {
      label: "Linked issues",
      description: "Every GitHub issue this thread has linked.",
      icon: Link2Icon,
      shortcut: "K",
      available: props.issueLinksAvailable === true,
      disabledReason: "Linked issues are only available for sent threads on supported servers.",
      unavailableHint: UNSUPPORTED,
      onClick: props.onAddIssueLinks ?? (() => undefined),
    },
  ] as const;
