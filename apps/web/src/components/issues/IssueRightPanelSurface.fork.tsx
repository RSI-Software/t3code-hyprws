import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { ProjectIssuesPanel } from "../../routes/_chat.issues";
import { useRightPanelStore } from "../../rightPanelStore";
import type { IssueHubSurfaceFork, IssueSurfaceFork } from "../../rightPanelStore.fork";
import { useEnvironments } from "../../state/environments";
import { IssueDetailSurfaceFork } from "./IssueDetailSurface.fork";
import { ThreadIssueLinks } from "./ThreadIssueLinks";

/** The thread right panel's Issues list, Linked issues, and issue detail surfaces. */
export function IssueRightPanelSurfaceFork(props: {
  readonly surface: IssueHubSurfaceFork | IssueSurfaceFork;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) {
  const { surface, threadRef, environmentId, projectId } = props;
  const { environments } = useEnvironments();
  if (surface.kind === "github-issue") {
    return (
      <IssueDetailSurfaceFork
        surface={surface}
        environments={environments}
        activeThreadRef={threadRef}
      />
    );
  }
  if (surface.kind === "github-issue-links") {
    return <ThreadIssueLinks threadRef={threadRef} />;
  }
  if (projectId === null) return null;
  return (
    <ProjectIssuesPanel
      key={`${environmentId}:${projectId}`}
      projectRef={scopeProjectRef(environmentId, projectId)}
      onSelectIssue={(issue) => useRightPanelStore.getState().openIssue(threadRef, issue)}
    />
  );
}
