// Fork-owned right-panel GitHub issue detail surface. Upstream `ChatView.tsx` carries only
// marked hook lines pointing here; the capability probe, the degraded/ghost states, and the
// sub-issue hand-off live in this module.
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "../../rightPanelStore";
import type { IssueSurfaceFork } from "../../rightPanelStore.fork";
import { IssueDetailPanel, gitHubSubIssueRepository } from "./IssueDetailPanel";
import { IssueEmptyState } from "./IssueEmptyState";
import { IssueDetailGhost } from "./IssueGhosts";

export function IssueDetailSurfaceFork(props: {
  readonly surface: IssueSurfaceFork;
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
  const issuesCapabilityKnown = issueServerConfig !== null;
  const supportsIssues = issueServerConfig?.environment.capabilities.githubIssues === true;

  if (!issuesCapabilityKnown) return <IssueDetailGhost />;
  if (!supportsIssues) {
    return (
      <IssueEmptyState
        title="GitHub issues unavailable"
        description="Update this environment's T3 Code server to browse GitHub issues."
      />
    );
  }
  return (
    <IssueDetailPanel
      key={`${surface.environmentId}:${surface.projectId}:${surface.repository}#${surface.number}`}
      environmentId={surface.environmentId as EnvironmentId}
      composerTarget={props.activeThreadRef}
      onBack={() => {
        if (props.activeThreadRef) {
          useRightPanelStore.getState().open(props.activeThreadRef, "github-issues");
        }
      }}
      onSelectSubIssue={(child) => {
        if (!props.activeThreadRef) return;
        useRightPanelStore.getState().openIssue(props.activeThreadRef, {
          environmentId: surface.environmentId,
          projectId: surface.projectId,
          repository: gitHubSubIssueRepository(child.url) ?? surface.repository,
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
