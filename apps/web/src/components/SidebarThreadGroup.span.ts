import type { SidebarThreadGroup } from "../state/threadGroups";
import {
  buildSidebarThreadGroupLayout,
  sidebarListItemId,
  type SidebarListItem,
} from "./Sidebar.logic";
import {
  parseSidebarThreadGroupMarker,
  type SidebarThreadGroupSpan,
} from "./SidebarThreadGroup.markers";

// A group renders as a span of the sidebar's one sortable list: its header
// marker followed by its visible members. These hooks keep the sortable
// preview aware of that span; which group a lifted row joins is the depth
// projection's call (SidebarThreadGroup.projection.ts).

/** One section's group layout, the threads it renders, and each group's span. */
export function sidebarThreadGroupLayoutFork<T>(
  threads: readonly T[],
  groups: readonly SidebarThreadGroup[],
  getKey: (thread: T) => string,
  requireParent = false,
) {
  const keys = new Set(threads.map(getKey));
  const layout = buildSidebarThreadGroupLayout({
    threads,
    groups: requireParent ? groups.filter((group) => keys.has(group.parentThreadId)) : groups,
    getId: getKey,
  });
  const visibleThreads: T[] = [];
  const spans: SidebarThreadGroupSpan<T>[] = [];
  for (const item of layout) {
    if (item.kind === "thread") {
      visibleThreads.push(item.thread);
      continue;
    }
    // A collapsed group keeps its first member as the header's anchor, so the
    // group holds one stable slot in the drop order either way.
    const visible = item.group.collapsed ? item.threads.slice(0, 1) : item.threads;
    const visibleKeys = visible.map(getKey);
    visibleThreads.push(...visible);
    spans.push({
      groupKey: item.group.id,
      group: item.group,
      threads: item.threads,
      visibleKeys,
      parentKey: item.hasParent ? visibleKeys[0]! : null,
    });
  }
  return { layout, visibleThreads, spans };
}

/** The list after dnd-kit's arrayMove puts the lifted row in `over`'s slot. */
function moveSidebarListItem(
  items: readonly SidebarListItem[],
  activeIndex: number,
  overIndex: number,
): SidebarListItem[] {
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(overIndex, 0, items[activeIndex]!);
  return moved;
}

/** Upstream lays the active section out from the drop order, which knows no group
    markers; with spans, lay it out from the moved list so each header and end marker
    keeps its place. Unmeasured rows (a collapsed group's hidden anchor) take no space. */
export function projectSidebarThreadGroupSpansFork(
  projected: SidebarListItem[],
  input: {
    readonly items: readonly SidebarListItem[];
    readonly activeIndex: number;
    readonly overIndex: number;
    readonly rects: readonly ({ readonly height: number } | undefined)[];
  },
): void {
  const { items, rects } = input;
  const active = items[input.activeIndex];
  if (active?.kind !== "thread") return;
  if (!items.some(isGroupMarker)) return;
  const indices = new Map(items.map((item, index) => [sidebarListItemId(item), index]));
  const moved = moveSidebarListItem(items, input.activeIndex, input.overIndex);
  // Working rows never take a drop, so the Working run keeps its order; it is
  // projected only to keep its group headers.
  for (const opener of [
    "pinned-header",
    "pinned-divider",
    "working-header",
    "snoozed-header",
  ] as const) {
    const source = sectionBounds(moved, opener);
    const target = sectionBounds(projected, opener);
    if (!source || !target) continue;
    const run = moved.slice(...source).flatMap((item): SidebarListItem[] => {
      if (item === active)
        return [
          {
            ...active,
            section:
              opener === "pinned-header"
                ? "pinned"
                : opener === "snoozed-header"
                  ? "snoozed"
                  : opener === "working-header"
                    ? "working"
                    : "active",
          },
        ];
      if (item.kind === "marker" && !isGroupMarker(item)) return [];
      const index = indices.get(sidebarListItemId(item));
      return index !== undefined && rects[index] !== undefined ? [item] : [];
    });
    const [start, end] = target;
    const placeholder = projected
      .slice(start, end)
      .find((item) => item.kind === "marker" && item.marker === "active-placeholder");
    projected.splice(start, end - start, ...(placeholder ? [placeholder] : []), ...run);
  }
}

function isGroupMarker(item: SidebarListItem): boolean {
  return item.kind === "marker" && parseSidebarThreadGroupMarker(item.marker) !== null;
}

/** A section's slots: after its opening marker, before the next shelf header. */
function sectionBounds(
  items: readonly SidebarListItem[],
  opener: "pinned-header" | "pinned-divider" | "working-header" | "snoozed-header",
): readonly [number, number] | null {
  const start = items.findIndex((item) => item.kind === "marker" && item.marker === opener) + 1;
  if (start === 0) return null;
  const end = items.findIndex(
    (item, index) =>
      index >= start &&
      item.kind === "marker" &&
      (item.marker === "pinned-divider" ||
        item.marker === "working-header" ||
        item.marker === "snoozed-header" ||
        item.marker === "settled-header"),
  );
  return [start, end < 0 ? items.length : end];
}

export interface SidebarProjectedLayoutFork {
  /** Each shown item's vertical offset from its measured slot, by sortable id;
      the lifted row's entry is the slot the preview opens for it. */
  readonly offsets: ReadonlyMap<string, number>;
  readonly heights: ReadonlyMap<string, number>;
}

const projectedLayouts = new WeakMap<readonly SidebarListItem[], SidebarProjectedLayoutFork>();

/** Keep the preview's layout for the drop layer, which draws the landing slot
    and the target outline where the preview put them. */
export function recordSidebarProjectedLayoutFork(
  items: readonly SidebarListItem[],
  projected: readonly SidebarListItem[],
  heights: readonly number[],
  transforms: readonly { readonly y: number; readonly scaleY: number }[],
): void {
  const offsets = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const transform = transforms[index];
    if (transform !== undefined && transform.scaleY !== 0)
      offsets.set(sidebarListItemId(item), transform.y);
  }
  projectedLayouts.set(items, {
    offsets,
    heights: new Map(projected.map((item, index) => [sidebarListItemId(item), heights[index]!])),
  });
}

/** The layout the sortable preview last computed for `items`, if any. */
export function sidebarProjectedLayoutFork(
  items: readonly SidebarListItem[],
): SidebarProjectedLayoutFork | null {
  return projectedLayouts.get(items) ?? null;
}
