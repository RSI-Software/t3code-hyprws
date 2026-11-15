// Fork-owned right-panel GitHub issue detail surface. Upstream `ChatView.tsx` carries only
// marked hook lines pointing here; the capability probe, the degraded/ghost states, and the
// sub-issue hand-off live in this module.
import { LINEAR_ISSUE_HOST, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useRightPanelStore } from "../../rightPanelStore";
import type { IssueSurfaceFork } from "../../rightPanelStore.fork";
import { searchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { IssueDetailPanel, gitHubSubIssueRepository } from "./IssueDetailPanel";
import { IssueEmptyState } from "./IssueEmptyState";
import { IssueDetailGhost } from "./IssueGhosts";
import { knowsLinearFork, readsLinearFork } from "./readsLinear.fork";

/**
 * A Linear link on a server without a key: say so, and go straight to the key's row, scoped to
 * that server so saving there does not copy the key to every environment.
 */
function LinearKeyMissingFork(props: { readonly environmentId: string }) {
  const navigate = useNavigate();
  return (
    <IssueEmptyState
      title="Add a Linear API key"
      description="This server needs a Linear API key to show Linear issues here."
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/settings/source-control",
              search: { machine: props.environmentId },
              hash: searchableSetting("linear-api-key").id,
            })
          }
        >
          Open Settings
        </Button>
      }
    />
  );
}

export function IssueDetailSurfaceFork(props: {
  readonly surface: IssueSurfaceFork;
  readonly environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly serverConfig?: {
      readonly environment: {
        readonly capabilities: {
          readonly githubIssues?: boolean;
          readonly linearIssues?: boolean;
        };
      };
      readonly settings?: { readonly linearApiKey?: unknown };
    } | null;
  }>;
  readonly activeThreadRef: ScopedThreadRef | null;
}) {
  const { surface } = props;
  const issueServerConfig =
    props.environments.find((environment) => environment.environmentId === surface.environmentId)
      ?.serverConfig ?? null;
  const issuesCapabilityKnown = issueServerConfig !== null;
  const capabilities = issueServerConfig?.environment.capabilities;
  const linear = surface.host === LINEAR_ISSUE_HOST;

  if (!issuesCapabilityKnown) return <IssueDetailGhost />;
  if (linear && !knowsLinearFork(issueServerConfig)) {
    return (
      <IssueEmptyState
        title="Linear issues unavailable"
        description="Update this environment's T3 Code server to read Linear issues."
      />
    );
  }
  if (linear && !readsLinearFork(issueServerConfig))
    return <LinearKeyMissingFork environmentId={surface.environmentId} />;
  if (!linear && capabilities?.githubIssues !== true) {
    return (
      <IssueEmptyState
        title="GitHub issues unavailable"
        description="Update this environment's T3 Code server to browse GitHub issues."
      />
    );
  }
  return (
    <IssueDetailPanel
      key={surface.id}
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
        ...(linear ? { host: LINEAR_ISSUE_HOST } : {}),
      }}
    />
  );
}
