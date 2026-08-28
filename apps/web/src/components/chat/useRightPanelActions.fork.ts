import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";

export function useIssuesPanelActionsFork(
  threadRef: ScopedThreadRef | null,
  project: EnvironmentProject | null,
  capabilities: { readonly githubIssues?: boolean } | undefined,
) {
  const issuesAvailable =
    capabilities?.githubIssues === true && project?.repositoryIdentity?.provider === "github";
  const onAddIssues = useStableCallback(() => {
    if (!threadRef || !issuesAvailable) return;
    useRightPanelStore.getState().open(threadRef, "github-issues");
  });
  return { onAddIssues, issuesAvailable };
}
