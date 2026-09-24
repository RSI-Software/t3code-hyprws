import {
  sidebarListItemId,
  type SidebarListItem,
  type SidebarThreadGroupLayoutItem,
} from "./Sidebar.logic";
import {
  parseSidebarThreadGroupMarker,
  sidebarThreadGroupKey,
  type SidebarThreadGroupSpan,
} from "./SidebarThreadGroup.markers";

// A group renders as a span of the sidebar's one sortable list: its header
// marker followed by its visible members. These hooks keep the sortable
// preview aware of that span; which group a lifted row joins is the depth
// projection's call (SidebarThreadGroup.projection.ts).

/** Every group the active section renders, with the keys its span wraps. */
export function sidebarThreadGroupSpansFork<T>(
  layout: readonly SidebarThreadGroupLayoutItem<T>[],
  getKey: (thread: T) => string,
): SidebarThreadGroupSpan<T>[] {
  return layout.flatMap((item): SidebarThreadGroupSpan<T>[] => {
    if (item.kind !== "group") return [];
    const visible = item.group.collapsed ? item.threads.slice(0, 1) : item.threads;
    return [
      {
        groupKey: sidebarThreadGroupKey(item.projectKey, item.group.id),
        projectKey: item.projectKey,
        group: item.group,
        threads: item.threads,
        visibleKeys: visible.map(getKey),
      },
    ];
  });
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

/** Upstream's projection lays the active section out from the drop order,
    which knows no group markers. With spans in the list, lay that section out
    from the moved list instead, so each header and end marker keeps its place
    among the rows. Unmeasured rows, a collapsed group's hidden anchor, take no
    space. */
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
  const run = sectionRun(moved).flatMap((item): SidebarListItem[] => {
    if (item === active) return [{ ...active, section: "active" }];
    if (item.kind === "marker" && !isGroupMarker(item)) return [];
    const index = indices.get(sidebarListItemId(item));
    return index !== undefined && rects[index] !== undefined ? [item] : [];
  });
  const [start, end] = sectionBounds(projected);
  const placeholder = projected
    .slice(start, end)
    .find((item) => item.kind === "marker" && item.marker === "active-placeholder");
  projected.splice(start, end - start, ...(placeholder ? [placeholder] : []), ...run);
}

function isGroupMarker(item: SidebarListItem): boolean {
  return item.kind === "marker" && parseSidebarThreadGroupMarker(item.marker) !== null;
}

/** The active section's slots: after the pinned divider, before the first shelf. */
function sectionBounds(items: readonly SidebarListItem[]): readonly [number, number] {
  const start =
    items.findIndex((item) => item.kind === "marker" && item.marker === "pinned-divider") + 1;
  const end = items.findIndex(
    (item, index) =>
      index >= start &&
      item.kind === "marker" &&
      (item.marker === "snoozed-header" || item.marker === "settled-header"),
  );
  return [start, end < 0 ? items.length : end];
}

function sectionRun(items: readonly SidebarListItem[]): readonly SidebarListItem[] {
  const [start, end] = sectionBounds(items);
  return items.slice(start, end);
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
