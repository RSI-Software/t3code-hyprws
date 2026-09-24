import { describe, expect, it } from "vite-plus/test";

import { buildSidebarListItems, sidebarMarkerId } from "./Sidebar.logic";
import {
  sidebarThreadGroupHeaderMarker,
  sidebarThreadGroupKey,
} from "./SidebarThreadGroup.markers";
import {
  isSidebarThreadGroupSlotValidFork,
  projectSidebarThreadGroupDepthFork,
  resolveSidebarThreadGroupDropFork,
  sidebarThreadGroupDissolvingFork,
  sidebarThreadGroupTreeFork,
} from "./SidebarThreadGroup.projection";

const OPEN_KEY = sidebarThreadGroupKey("project-a", "open");
const SHUT_KEY = sidebarThreadGroupKey("project-a", "shut");
const OPEN_HEADER = sidebarMarkerId(sidebarThreadGroupHeaderMarker(OPEN_KEY));
const SHUT_HEADER = sidebarMarkerId(sidebarThreadGroupHeaderMarker(SHUT_KEY));
const open = { id: "open", title: "Open", threadIds: ["m1", "m2"], collapsed: false };
const shut = { id: "shut", title: "Shut", threadIds: ["c1", "c2"], collapsed: true };

// Pinned p1; active: the open group (m1, m2), plain o1 and o2, the collapsed
// group whose hidden anchor is c1, and x1 from another project.
const tree = sidebarThreadGroupTreeFork({
  items: buildSidebarListItems({
    hasNoThreads: false,
    pinnedKeys: ["p1"],
    activeKeys: ["m1", "m2", "o1", "o2", "c1", "x1"],
    hasSnoozedThreads: false,
    snoozedVisibleKeys: [],
    settledKeys: [],
    activeGroups: [
      {
        groupKey: OPEN_KEY,
        projectKey: "project-a",
        group: open,
        threads: [],
        visibleKeys: ["m1", "m2"],
      },
      {
        groupKey: SHUT_KEY,
        projectKey: "project-a",
        group: shut,
        threads: [],
        visibleKeys: ["c1"],
      },
    ],
  }),
  spans: [
    { groupKey: OPEN_KEY, projectKey: "project-a", group: open, visibleKeys: ["m1", "m2"] },
    { groupKey: SHUT_KEY, projectKey: "project-a", group: shut, visibleKeys: ["c1"] },
  ],
  projectKeyOf: (key) => (key === "x1" ? "project-b" : "project-a"),
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
  it("starts a group when a plain thread nests under the thread above", () => {
    expect(drop("o2", "o2", 0).drop).toBeNull();
    const nested = drop("o2", "o2", 1);
    expect(nested.projection).toMatchObject({ depth: 1, parent: { kind: "thread", key: "o1" } });
    expect(nested.drop).toEqual({
      projectKey: "project-a",
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
      projectKey: "project-a",
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

  it("refuses a slot inside another project's group", () => {
    expect(drop("x1", "m2", 1).projection.refused).toBe(true);
    expect(isSidebarThreadGroupSlotValidFork(tree, "x1", "m2")).toBe(false);
    expect(isSidebarThreadGroupSlotValidFork(tree, "o1", "m2")).toBe(true);
  });

  it("skips a collapsed group's hidden anchor when bounding the depth", () => {
    expect(drop("o1", SHUT_HEADER, 0).drop).toBeNull();
    expect(drop("o1", SHUT_HEADER, 1).drop?.target).toEqual({ kind: "existing", groupId: "shut" });
  });
});
