import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { ProjectGitHubIssuesPanel } from "../../routes/_chat.issues";
import { useRightPanelStore } from "../../rightPanelStore";
import type { GitHubIssueHubSurfaceFork, GitHubIssueSurfaceFork } from "../../rightPanelStore.fork";
import { useEnvironments } from "../../state/environments";
import { GitHubIssueDetailSurfaceFork } from "./GitHubIssueDetailSurface.fork";

/** The thread right panel's Issues list and issue detail surfaces. */
export function GitHubIssueRightPanelSurfaceFork(props: {
  readonly surface: GitHubIssueHubSurfaceFork | GitHubIssueSurfaceFork;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) {
  const { surface, threadRef, environmentId, projectId } = props;
  const { environments } = useEnvironments();
  if (surface.kind === "github-issue") {
    return (
      <GitHubIssueDetailSurfaceFork
        surface={surface}
        environments={environments}
        activeThreadRef={threadRef}
      />
    );
  }
  if (projectId === null) return null;
  return (
    <ProjectGitHubIssuesPanel
      key={`${environmentId}:${projectId}`}
      projectRef={scopeProjectRef(environmentId, projectId)}
      onSelectIssue={(issue) => useRightPanelStore.getState().openGitHubIssue(threadRef, issue)}
      threadRef={threadRef}
    />
  );
}
