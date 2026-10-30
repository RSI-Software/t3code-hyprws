import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShell } from "../../state/entities";
import { observeProactivePanelUserChoice } from "../ChatView.logic";

// Settings and drafts unmount ChatView; remember links until the page reloads.
const observedThreadIssues = new Map<
  string,
  {
    readonly keys: ReadonlySet<string>;
    readonly choice: ReturnType<typeof observeProactivePanelUserChoice>;
  }
>();

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
  const sent = thread !== null;
  const onAddIssues = useStableCallback(() => {
    if (!threadRef || !issuesAvailable) return;
    useRightPanelStore.getState().open(threadRef, "github-issues");
  });
  const onAddIssueLinks = useStableCallback(() => {
    if (!threadRef || !issueLinksAvailable) return;
    useRightPanelStore.getState().open(threadRef, "github-issue-links");
  });
  const proactiveSetting = useClientSettings((settings) => settings.proactivePanelsEnabled);
  const proactive = proactiveSetting && proactiveGate.allowed;
  const { runningTurnId } = proactiveGate;
  const settingsHydrated = useClientSettingsHydrated();
  const linkKeys = (thread?.issues ?? [])
    .map((link) => `${link.host}/${link.repository}#${link.number}`.toLowerCase())
    .join(" ");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the Linked issues tab in the right panel store when the thread gains a link
  useEffect(() => {
    if (threadRef === null || !sent) return;
    const threadKey = scopedThreadKey(threadRef);
    const panels = useRightPanelStore.getState();
    const keys = new Set(linkKeys === "" ? [] : linkKeys.split(" "));
    const previous = observedThreadIssues.get(threadKey);
    // A panel the user opened or closed since the turn began wins over a new link.
    const choice = observeProactivePanelUserChoice(previous?.choice ?? null, {
      threadKey,
      runningTurnId,
      userActionRevision: panels.getUserActionRevision(threadRef),
    });
    observedThreadIssues.set(threadKey, { keys, choice });
    // The first sight of a thread records its links; only a link added while watching opens.
    if (previous === undefined || !proactive || !settingsHydrated) return;
    if (![...keys].some((key) => !previous.keys.has(key))) return;
    panels.openProactive(
      threadRef,
      { id: "github-issue-links", kind: "github-issue-links" },
      choice.userActionRevision,
      true,
    );
  }, [linkKeys, proactive, runningTurnId, sent, settingsHydrated, threadRef]);
  return { onAddIssues, issuesAvailable, onAddIssueLinks, issueLinksAvailable };
}
