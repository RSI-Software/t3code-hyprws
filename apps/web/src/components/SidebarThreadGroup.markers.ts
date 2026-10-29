import type { SidebarThreadGroup } from "../state/threadGroups";
import type { SidebarListItem, SidebarListMarker } from "./Sidebar.logic";

// A thread group is a span of the sidebar's one sortable list: a header marker, sortable like
// upstream's section markers so it shifts with the rows during a drag, then its visible
// members. No end marker: in the flattened tree a row's depth says whether it belongs to the
// group above it.

const HEADER_PREFIX = "thread-group\0";

export type SidebarThreadGroupMarker = `${typeof HEADER_PREFIX}${string}`;

/** One group as the list renders it; `groupKey` is the group's id. */
export interface SidebarThreadGroupSpan<T = unknown> {
  readonly groupKey: string;
  readonly group: SidebarThreadGroup;
  /** Every member the active section shows, in list order. */
  readonly threads: readonly T[];
  /** The keys the list emits: every member, or only the anchor when collapsed. */
  readonly visibleKeys: readonly string[];
  /** The visible parent's key, always the anchor; null without one. */
  readonly parentKey: string | null;
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
    const active =
      item.kind === "thread" &&
      (item.section === "pinned" ||
        item.section === "active" ||
        item.section === "working" ||
        item.section === "snoozed");
    const opens = active ? openers.get(item.key) : undefined;
    if (opens !== undefined)
      wrapped.push({ kind: "marker", marker: sidebarThreadGroupHeaderMarker(opens) });
    wrapped.push(item);
  }
  items.splice(0, items.length, ...wrapped);
}
