import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { SidebarListItem } from "./Sidebar.logic";

// Upstream builds the sidebar's rows inline; the fork's buildSidebarListItems
// replaces that, so it re-emits upstream's Working shelf between the active
// inbox and the snoozed shelf: the header whenever a thread is working, rows
// only for the shelf's visible threads.

/** The Working shelf's visible row keys, or undefined when nothing is working. */
export function sidebarWorkingShelfKeysFork(
  workingThreads: readonly unknown[],
  visibleWorkingThreads: readonly {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  }[],
): readonly string[] | undefined {
  if (workingThreads.length === 0) return undefined;
  return visibleWorkingThreads.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
}

export function pushSidebarWorkingShelfFork(
  items: SidebarListItem[],
  workingKeys: readonly string[] | undefined,
): void {
  if (workingKeys === undefined) return;
  items.push({ kind: "marker", marker: "working-header" });
  for (const key of workingKeys) items.push({ kind: "thread", key, section: "working" });
}
