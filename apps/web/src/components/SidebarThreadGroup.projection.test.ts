import { describe, expect, it } from "vite-plus/test";

import { buildSidebarListItems, sidebarMarkerId } from "./Sidebar.logic";
import { sidebarThreadGroupHeaderMarker } from "./SidebarThreadGroup.markers";
import {
  isSidebarThreadGroupSlotValidFork,
  projectSidebarThreadGroupDepthFork,
  resolveSidebarThreadGroupDropFork,
  sidebarThreadGroupDissolvingFork,
  sidebarThreadGroupTreeFork,
} from "./SidebarThreadGroup.projection";

const OPEN_KEY = "open";
const SHUT_KEY = "shut";
const LED_KEY = "led";
const OPEN_HEADER = sidebarMarkerId(sidebarThreadGroupHeaderMarker(OPEN_KEY));
const SHUT_HEADER = sidebarMarkerId(sidebarThreadGroupHeaderMarker(SHUT_KEY));
const LED_HEADER = sidebarMarkerId(sidebarThreadGroupHeaderMarker(LED_KEY));
const open = {
  id: "open",
  title: "Open",
  threadIds: ["m1", "m2"],
  parentThreadId: "m1",
  collapsed: false,
};
const shut = {
  id: "shut",
  title: "Shut",
  threadIds: ["c1", "c2"],
  parentThreadId: "c1",
  collapsed: true,
};
const led = {
  id: "led",
  title: "Led",
  threadIds: ["l1", "l2"],
  parentThreadId: "l1",
  collapsed: true,
};
// Open and shut render as when their parents sort out of view, under a plain header.
const spans = [
  { groupKey: OPEN_KEY, group: open, threads: [], visibleKeys: ["m1", "m2"], parentKey: null },
  { groupKey: SHUT_KEY, group: shut, threads: [], visibleKeys: ["c1"], parentKey: null },
  { groupKey: LED_KEY, group: led, threads: [], visibleKeys: ["l1"], parentKey: "l1" },
];

// Pinned p1; active: the open group (m1, m2), plain o1 and o2, the collapsed
// group whose hidden anchor is c1, x1, and the collapsed group led by l1.
const tree = sidebarThreadGroupTreeFork({
  items: buildSidebarListItems({
    hasNoThreads: false,
    pinnedKeys: ["p1"],
    activeKeys: ["m1", "m2", "o1", "o2", "c1", "x1", "l1"],
    hasSnoozedThreads: false,
    snoozedVisibleKeys: [],
    settledKeys: [],
    activeGroups: spans,
  }),
  spans,
});

const newGroup = () => ({ id: "new", title: "New group" });

function drop(activeId: string, overId: string, steps: number) {
  const projection = projectSidebarThreadGroupDepthFork(tree, activeId, overId, steps)!;
  return {
    projection,
    drop: resolveSidebarThreadGroupDropFork(tree, projection, newGroup),
    dissolving: sidebarThreadGroupDissolvingFork(tree, projection),
  };
}

describe("thread group depth projection", () => {
  it("keeps a snoozed parent's group when dragged back to Active", () => {
    const span = {
      groupKey: OPEN_KEY,
      group: open,
      threads: [],
      visibleKeys: ["m1", "m2"],
      parentKey: "m1",
    };
    const items = buildSidebarListItems({
      hasNoThreads: false,
      pinnedKeys: [],
      activeKeys: ["o1"],
      hasSnoozedThreads: true,
      snoozedVisibleKeys: ["m1", "m2"],
      settledKeys: [],
      activeGroups: [span],
    });
    expect(items).toContainEqual({
      kind: "marker",
      marker: sidebarThreadGroupHeaderMarker(OPEN_KEY),
    });
    const snoozedTree = sidebarThreadGroupTreeFork({ items, spans: [span] });
    const projection = projectSidebarThreadGroupDepthFork(snoozedTree, "m1", "o1", 0)!;
    expect(resolveSidebarThreadGroupDropFork(snoozedTree, projection, newGroup)).toBeNull();
  });

  function pinnedGroupDrop(activeId: string, overId: string, steps = 0, pinned = true) {
    const group = { ...open, collapsed: false };
    const span = {
      groupKey: group.id,
      group,
      threads: group.threadIds,
      visibleKeys: group.threadIds,
      parentKey: "m1",
    };
    const pinnedTree = sidebarThreadGroupTreeFork({
      items: buildSidebarListItems({
        hasNoThreads: false,
        pinnedKeys: pinned ? ["m1", "m2", "p1"] : ["p1"],
        activeKeys: pinned ? ["o1"] : ["m1", "m2", "o1"],
        hasSnoozedThreads: false,
        snoozedVisibleKeys: [],
        settledKeys: [],
        activeGroups: [span],
      }),
      spans: [span],
    });
    const projection = projectSidebarThreadGroupDepthFork(pinnedTree, activeId, overId, steps)!;
    return {
      projection,
      drop: resolveSidebarThreadGroupDropFork(pinnedTree, projection, newGroup),
      dissolving: sidebarThreadGroupDissolvingFork(pinnedTree, projection),
    };
  }

  it("keeps parent membership when pinning, unpinning or reordering its group", () => {
    expect(pinnedGroupDrop("m1", sidebarMarkerId("pinned-header"), 0, false)).toMatchObject({
      drop: null,
      dissolving: null,
    });
    expect(pinnedGroupDrop("m1", sidebarMarkerId("active-placeholder"))).toMatchObject({
      drop: null,
      dissolving: null,
    });
    expect(pinnedGroupDrop("m1", "p1")).toMatchObject({ drop: null, dissolving: null });
  });

  it("lets an inherited child leave its pinned group", () => {
    expect(pinnedGroupDrop("m2", sidebarMarkerId("active-placeholder"))).toMatchObject({
      drop: { threadIds: ["m2"], target: { kind: "none" } },
      dissolving: OPEN_KEY,
    });
    expect(pinnedGroupDrop("m2", "m2")).toMatchObject({ drop: null, dissolving: null });
  });

  it("starts a group when a plain thread nests under the thread above", () => {
    expect(drop("o2", "o2", 0).drop).toBeNull();
    const nested = drop("o2", "o2", 1);
    expect(nested.projection).toMatchObject({ depth: 1, parent: { kind: "thread", key: "o1" } });
    expect(nested.drop).toEqual({
      threadIds: ["o1", "o2"],
      target: { kind: "new", group: newGroup() },
    });
  });

  it("joins a group below its last member, and between members at any offset", () => {
    const joined = { kind: "existing", groupId: "open" };
    expect(drop("o1", "o1", 0).drop).toBeNull();
    expect(drop("o1", "o1", 1).drop?.target).toEqual(joined);
    expect(drop("o1", "m2", 0).drop?.target).toEqual(joined);
    expect(drop("o1", "m2", -1).drop?.target).toEqual(joined);
  });

  it("lets a member reorder inside its group, and leave at depth 0", () => {
    expect(drop("m1", "m2", 0)).toMatchObject({ drop: null, dissolving: null });
    const left = drop("m2", "m2", -1);
    expect(left.projection.depth).toBe(0);
    expect(left.drop).toEqual({
      threadIds: ["m2"],
      target: { kind: "none" },
    });
    // The pair would keep one member, so the group dissolves with the drag.
    expect(left.dissolving).toBe(OPEN_KEY);
  });

  it("never nests across the Active divider or lets a pinned thread in", () => {
    // Above the group's header, the first active slot has no parent.
    expect(drop("o1", OPEN_HEADER, 1).projection).toMatchObject({ depth: 0, parent: null });
    expect(drop("p1", "o2", 1).projection).toMatchObject({ depth: 0, refused: false });
    expect(drop("p1", "m1", 0).projection.refused).toBe(true);
    expect(isSidebarThreadGroupSlotValidFork(tree, "p1", "m1")).toBe(false);
    expect(isSidebarThreadGroupSlotValidFork(tree, "p1", "o2")).toBeUndefined();
  });

  it("lets any active thread join a group between its members", () => {
    expect(drop("x1", "m2", 0).drop?.target).toEqual({ kind: "existing", groupId: "open" });
    expect(isSidebarThreadGroupSlotValidFork(tree, "x1", "m2")).toBe(true);
  });

  it("skips a collapsed group's hidden anchor when bounding the depth", () => {
    expect(drop("o1", SHUT_HEADER, 0).drop).toBeNull();
    expect(drop("o1", SHUT_HEADER, 1).drop?.target).toEqual({ kind: "existing", groupId: "shut" });
  });

  it("makes a thread the parent flush under a group's header", () => {
    const top = drop("o1", "m1", 0);
    expect(top.projection).toMatchObject({ depth: 0, asParent: true });
    expect(top.drop?.target).toEqual({ kind: "existing", groupId: "open", asParent: true });
    expect(drop("o1", "m1", 1).drop?.target).toEqual({ kind: "existing", groupId: "open" });
    // A member taking the lead keeps the pair whole.
    expect(drop("m2", "m1", -1)).toMatchObject({
      drop: { threadIds: ["m2"], target: { kind: "existing", groupId: "open", asParent: true } },
      dissolving: null,
    });
  });

  it("keeps a collapsed group's parent in view, and steps it down as a child", () => {
    expect(drop("x1", LED_HEADER, 0).projection.asParent).toBe(true);
    expect(drop("x1", "l1", 1).drop?.target).toEqual({ kind: "existing", groupId: "led" });
    expect(drop("l1", "l1", 0).drop).toBeNull();
    expect(drop("l1", "l1", 1).drop?.target).toEqual({ kind: "existing", groupId: "led" });
    expect(drop("l1", "l1", 1).dissolving).toBeNull();
    expect(drop("l1", "x1", 0)).toMatchObject({
      drop: { target: { kind: "none" } },
      dissolving: LED_KEY,
    });
  });
});
