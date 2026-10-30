import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { observeProactivePanelUserChoice } from "../components/ChatView.logic";
import { type RightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useClientSettings, useClientSettingsHydrated } from "./useSettings";

// Settings and drafts unmount ChatView; remember links until the page reloads.
const observedThreadLinks = new Map<
  string,
  {
    readonly keys: ReadonlySet<string>;
    readonly choice: ReturnType<typeof observeProactivePanelUserChoice>;
  }
>();

/**
 * Opens a linked-items tab (issues, artifacts) when the thread gains a link, under the same gates
 * useProactivePanels applies to linked pull requests. `surface` must be a stable constant, and
 * `linkKeys` is null until the thread is sent.
 */
export function useProactiveLinkedPanelFork(
  surface: Extract<RightPanelSurface, { kind: "github-issue-links" | "thread-artifacts" }>,
  threadRef: ScopedThreadRef | null,
  linkKeys: ReadonlyArray<string> | null,
  proactiveGate: { readonly runningTurnId: RunId | null; readonly allowed: boolean },
) {
  const proactiveSetting = useClientSettings((settings) => settings.proactivePanelsEnabled);
  const proactive = proactiveSetting && proactiveGate.allowed;
  const { runningTurnId } = proactiveGate;
  const settingsHydrated = useClientSettingsHydrated();
  const sent = linkKeys !== null;
  // A NUL never appears in a path or issue key, so it separates them losslessly.
  const joinedKeys = linkKeys?.join("\0") ?? "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the linked-items tab in the right panel store when the thread gains a link
  useEffect(() => {
    if (threadRef === null || !sent) return;
    const threadKey = scopedThreadKey(threadRef);
    const panels = useRightPanelStore.getState();
    const keys = new Set(joinedKeys === "" ? [] : joinedKeys.split("\0"));
    const observedKey = `${surface.kind}\0${threadKey}`;
    const previous = observedThreadLinks.get(observedKey);
    // A panel the user opened or closed since the turn began wins over a new link.
    const choice = observeProactivePanelUserChoice(previous?.choice ?? null, {
      threadKey,
      runningTurnId,
      userActionRevision: panels.getUserActionRevision(threadRef),
    });
    observedThreadLinks.set(observedKey, { keys, choice });
    // The first sight of a thread records its links; only a link added while watching opens.
    if (previous === undefined || !proactive || !settingsHydrated) return;
    if (![...keys].some((key) => !previous.keys.has(key))) return;
    panels.openProactive(threadRef, surface, choice.userActionRevision, true);
  }, [joinedKeys, surface, proactive, runningTurnId, sent, settingsHydrated, threadRef]);
}
