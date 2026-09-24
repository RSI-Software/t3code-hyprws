import type { SidebarThreadGroup } from "../uiStateStore";
import type { SidebarListItem, SidebarListMarker } from "./Sidebar.logic";

// A thread group is a span of the sidebar's one sortable list: a header
// marker followed by the group's visible members. The header is a sortable
// item like upstream's section markers, so it shifts with the rows during a
// drag. The span has no end marker: in the flattened tree a row's depth, not a
// boundary item, says whether it belongs to the group above it.

const HEADER_PREFIX = "thread-group\0";

export type SidebarThreadGroupMarker = `${typeof HEADER_PREFIX}${string}`;

/** One group as the list renders it; `groupKey` is `projectKey\0groupId`. */
export interface SidebarThreadGroupSpan<T = unknown> {
  readonly groupKey: string;
  readonly projectKey: string;
  readonly group: SidebarThreadGroup;
  /** Every member the active section shows, in list order. */
  readonly threads: readonly T[];
  /** The keys the list emits: every member, or only the anchor when collapsed. */
  readonly visibleKeys: readonly string[];
}

export function sidebarThreadGroupKey(projectKey: string, groupId: string): string {
  return `${projectKey}\0${groupId}`;
}

export function sidebarThreadGroupHeaderMarker(groupKey: string): SidebarThreadGroupMarker {
  return `${HEADER_PREFIX}${groupKey}`;
}

/** The group a header marker names; null for every upstream marker. */
export function parseSidebarThreadGroupMarker(
  marker: SidebarListMarker,
): { readonly groupKey: string } | null {
  return marker.startsWith(HEADER_PREFIX) ? { groupKey: marker.slice(HEADER_PREFIX.length) } : null;
}

/** Put each group's header marker before its first visible member. Members
    are contiguous in the active section, so the span is the run below it. */
export function insertSidebarThreadGroupMarkersFork(
  items: SidebarListItem[],
  spans: readonly Pick<SidebarThreadGroupSpan, "groupKey" | "visibleKeys">[] = [],
): void {
  if (spans.length === 0) return;
  const openers = new Map<string, string>();
  for (const span of spans) {
    const first = span.visibleKeys[0];
    if (first !== undefined) openers.set(first, span.groupKey);
  }
  const wrapped: SidebarListItem[] = [];
  for (const item of items) {
    const active = item.kind === "thread" && item.section === "active";
    const opens = active ? openers.get(item.key) : undefined;
    if (opens !== undefined)
      wrapped.push({ kind: "marker", marker: sidebarThreadGroupHeaderMarker(opens) });
    wrapped.push(item);
  }
  items.splice(0, items.length, ...wrapped);
}
