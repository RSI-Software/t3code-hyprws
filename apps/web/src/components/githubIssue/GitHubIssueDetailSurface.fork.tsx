// Fork-owned: the right panel's GitHub issue detail surface for commit
// `9f92309411` (feat(issues): add GitHub Issues surface scoped to project
// windows). The upstream `ChatView.tsx` carries only marked hook lines pointing
// here; the capability probe, the degraded/ghost states, and the sub-issue
// hand-off live in this module.
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../../rightPanelStore";
import type { GitHubIssueSurfaceFork } from "../../rightPanelStore.fork";
import { GitHubIssueDetailPanel } from "./GitHubIssueDetailPanel";
import { GitHubIssueEmptyState } from "./GitHubIssueEmptyState";
import { GitHubIssueDetailGhost } from "./GitHubIssueGhosts";

export function GitHubIssueDetailSurfaceFork(props: {
  readonly surface: GitHubIssueSurfaceFork;
  readonly environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly serverConfig?: {
      readonly environment: { readonly capabilities: { readonly githubIssues?: boolean } };
    } | null;
  }>;
  readonly activeThreadRef: ScopedThreadRef | null;
}) {
  const { surface } = props;
  const issueServerConfig =
    props.environments.find((environment) => environment.environmentId === surface.environmentId)
      ?.serverConfig ?? null;
  const githubIssuesCapabilityKnown = issueServerConfig !== null;
  const supportsGitHubIssues = issueServerConfig?.environment.capabilities.githubIssues === true;

  if (!githubIssuesCapabilityKnown) return <GitHubIssueDetailGhost />;
  if (!supportsGitHubIssues) {
    return (
      <GitHubIssueEmptyState
        title="GitHub issues unavailable"
        description="Update this environment's T3 Code server to browse GitHub issues."
      />
    );
  }
  return (
    <GitHubIssueDetailPanel
      key={`${surface.environmentId}:${surface.projectId}:${surface.repository}#${surface.number}`}
      environmentId={surface.environmentId as EnvironmentId}
      onSelectSubIssue={(child) => {
        if (!props.activeThreadRef) return;
        useRightPanelStore.getState().openGitHubIssue(props.activeThreadRef, {
          environmentId: surface.environmentId,
          projectId: surface.projectId,
          repository: surface.repository,
          number: child.number,
        });
      }}
      reference={{
        projectId: surface.projectId as ProjectId,
        repository: surface.repository,
        number: surface.number,
      }}
    />
  );
}
