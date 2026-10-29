import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { SidebarListItem } from "./Sidebar.logic";
import {
  insertSidebarThreadGroupMarkersFork,
  type SidebarThreadGroupSpan,
} from "./SidebarThreadGroup.markers";

export function applySidebarThreadGroupsFork(
  items: SidebarListItem[],
  input: {
    readonly pinnedKeys?: readonly string[];
    readonly activeKeys: readonly string[] | null;
    readonly snoozedKeys?: readonly string[];
    readonly workingKeys: readonly string[] | undefined;
    readonly activeGroups: readonly SidebarThreadGroupSpan[];
  },
): void {
  for (const [section, keys, marker] of [
    ["pinned", input.pinnedKeys ?? null, "pinned-header"],
    ["active", input.activeKeys, "active-placeholder"],
    ["working", input.workingKeys ?? [], "working-header"],
    ["snoozed", input.snoozedKeys ?? null, "snoozed-header"],
  ] as const) {
    if (keys === null) continue;
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      if (item.kind === "thread" && item.section === section) items.splice(index, 1);
    }
    const index = items.findIndex((item) => item.kind === "marker" && item.marker === marker);
    if (index !== -1)
      items.splice(
        index + 1,
        0,
        ...keys.map((key): SidebarListItem => ({ kind: "thread", key, section })),
      );
  }
  insertSidebarThreadGroupMarkersFork(items, input.activeGroups);
}

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
