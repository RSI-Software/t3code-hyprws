import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";

import { useProactiveLinkedPanelFork } from "../../hooks/useProactiveLinkedPanel.fork";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShell } from "../../state/entities";

const ISSUE_LINKS_SURFACE = { id: "github-issue-links", kind: "github-issue-links" } as const;

export function useIssuesPanelActionsFork(
  threadRef: ScopedThreadRef | null,
  project: EnvironmentProject | null,
  capabilities: { readonly githubIssues?: boolean; readonly threadIssues?: boolean } | undefined,
  // The same gates useProactivePanels applies to linked pull requests.
  proactiveGate: { readonly runningTurnId: RunId | null; readonly allowed: boolean },
) {
  const issuesAvailable =
    capabilities?.githubIssues === true && project?.repositoryIdentity?.provider === "github";
  // Only a sent thread has a shell, and only a sent thread can hold links.
  const thread = useThreadShell(capabilities?.threadIssues === true ? threadRef : null);
  // Like Linked pull requests, the tab is offered once the thread holds a link.
  const issueLinksAvailable = (thread?.issues?.length ?? 0) > 0;
  const onAddIssues = useStableCallback(() => {
    if (!threadRef || !issuesAvailable) return;
    useRightPanelStore.getState().open(threadRef, "github-issues");
  });
  const onAddIssueLinks = useStableCallback(() => {
    if (!threadRef || !issueLinksAvailable) return;
    useRightPanelStore.getState().open(threadRef, "github-issue-links");
  });
  useProactiveLinkedPanelFork(
    ISSUE_LINKS_SURFACE,
    threadRef,
    thread === null
      ? null
      : (thread.issues ?? []).map((link) =>
          `${link.host}/${link.repository}#${link.number}`.toLowerCase(),
        ),
    proactiveGate,
  );
  return { onAddIssues, issuesAvailable, onAddIssueLinks, issueLinksAvailable };
}
