import { describe, expect, it } from "vite-plus/test";
import type { SortingStrategy } from "@dnd-kit/sortable";

import { createSidebarSortingStrategy } from "./Sidebar.drag";
import { buildSidebarListItems, sidebarListItemId, sidebarMarkerId } from "./Sidebar.logic";
import {
  sidebarThreadGroupHeaderMarker,
  sidebarThreadGroupKey,
} from "./SidebarThreadGroup.markers";
import { sidebarProjectedLayoutFork } from "./SidebarThreadGroup.span";

const GROUP_KEY = sidebarThreadGroupKey("project-a", "group-1");
const HEADER_MARKER = sidebarThreadGroupHeaderMarker(GROUP_KEY);
const HEADER = sidebarMarkerId(HEADER_MARKER);
const group = { id: "group-1", title: "Related", threadIds: ["m1", "m2"], collapsed: false };

/** The top of the active section is a group; `o1` is an ungrouped row below it. */
function listWithTopGroup() {
  return buildSidebarListItems({
    hasNoThreads: false,
    pinnedKeys: ["p1"],
    activeKeys: ["m1", "m2", "o1"],
    hasSnoozedThreads: false,
    snoozedVisibleKeys: [],
    settledKeys: [],
    activeGroups: [
      {
        groupKey: GROUP_KEY,
        projectKey: "project-a",
        group,
        threads: [],
        visibleKeys: ["m1", "m2"],
      },
    ],
  });
}

describe("thread group spans", () => {
  it("puts the group's header marker before its visible rows", () => {
    expect(listWithTopGroup().map(sidebarListItemId)).toEqual([
      sidebarMarkerId("pinned-header"),
      "p1",
      sidebarMarkerId("pinned-divider"),
      sidebarMarkerId("active-placeholder"),
      HEADER,
      "m1",
      "m2",
      "o1",
      sidebarMarkerId("settled-header"),
      sidebarMarkerId("settled-placeholder"),
    ]);
  });
});

describe("thread group span projection", () => {
  function project(items: ReturnType<typeof listWithTopGroup>, active: string, over: string) {
    let top = 0;
    const rects = items.map((item) => {
      const height = item.kind === "thread" ? 40 : item.marker === HEADER_MARKER ? 32 : 0;
      const rect = { top, height, bottom: top + height, left: 0, right: 260, width: 260 };
      top += height + 1;
      return rect;
    });
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: [],
      settledExpanded: false,
    });
    const args = {
      activeIndex: items.findIndex((item) => sidebarListItemId(item) === active),
      overIndex: items.findIndex((item) => sidebarListItemId(item) === over),
      rects,
      index: 0,
    } as Parameters<SortingStrategy>[0];
    return { strategy, args, ids: items.map(sidebarListItemId) };
  }

  it("shifts the header down with its rows when a row lands above it", () => {
    const { strategy, args, ids } = project(listWithTopGroup(), "o1", HEADER);
    const header = strategy({ ...args, index: ids.indexOf(HEADER) });
    expect(header?.scaleY).toBe(1);
    expect(header?.y).toBeGreaterThan(0);
    expect(strategy({ ...args, index: ids.indexOf("m1") })?.y).toBe(header?.y);
  });

  it("records the slot it opens for the lifted row", () => {
    const items = listWithTopGroup();
    const { strategy, args, ids } = project(items, "o1", HEADER);
    strategy({ ...args, index: ids.indexOf("o1") });
    const layout = sidebarProjectedLayoutFork(items);
    const top = (id: string) => args.rects[ids.indexOf(id)]!.top + layout!.offsets.get(id)!;
    // o1 opens right below the Active divider, and the group follows it.
    expect(top("o1")).toBe(top(sidebarMarkerId("pinned-divider")) + 1);
    expect(layout?.heights.get("o1")).toBe(40);
    expect(top(HEADER)).toBe(top("o1") + 40 + 1);
  });
});
