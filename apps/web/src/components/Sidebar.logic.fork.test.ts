import { describe, expect, it } from "vite-plus/test";
import {
  buildCreateThreadGroupContextMenuItem,
  buildSidebarListItems,
  buildSidebarThreadGroupLayout,
  buildThreadGroupMembershipContextMenuItems,
} from "./Sidebar.logic";

describe("sidebar thread groups", () => {
  const threads = [
    { id: "thread-a", projectKey: "project-a" },
    { id: "thread-b", projectKey: "project-a" },
    { id: "thread-c", projectKey: "project-a" },
  ];

  it("renders each visible group once at its first member", () => {
    expect(
      buildSidebarThreadGroupLayout({
        threads,
        groupsByProject: {
          "project-a": [
            {
              id: "group-1",
              title: "Related work",
              threadIds: ["thread-b", "thread-c"],
              collapsed: false,
            },
          ],
        },
        getId: (thread) => thread.id,
        getProjectKey: (thread) => thread.projectKey,
      }),
    ).toEqual([
      { kind: "thread", thread: threads[0] },
      {
        kind: "group",
        projectKey: "project-a",
        group: {
          id: "group-1",
          title: "Related work",
          threadIds: ["thread-b", "thread-c"],
          collapsed: false,
        },
        threads: [threads[1], threads[2]],
      },
    ]);
  });

  it("keeps saved groups in the current automatic thread sequence", () => {
    const automaticThreads = [threads[2]!, threads[0]!, threads[1]!];

    expect(
      buildSidebarThreadGroupLayout({
        threads: automaticThreads,
        groupsByProject: {
          "project-a": [
            {
              id: "group-1",
              title: "Related work",
              threadIds: ["thread-b", "thread-c"],
              collapsed: false,
            },
          ],
        },
        getId: (thread) => thread.id,
        getProjectKey: (thread) => thread.projectKey,
      }),
    ).toEqual([
      {
        kind: "group",
        projectKey: "project-a",
        group: {
          id: "group-1",
          title: "Related work",
          threadIds: ["thread-b", "thread-c"],
          collapsed: false,
        },
        threads: [threads[2], threads[1]],
      },
      { kind: "thread", thread: threads[0] },
    ]);
  });

  it("offers group creation only for an eligible multi-selection", () => {
    expect(buildCreateThreadGroupContextMenuItem({ count: 2, eligible: true })).toMatchObject({
      id: "create-thread-group",
      label: "Create group (2)",
      icon: "folder-tree",
    });
    expect(buildCreateThreadGroupContextMenuItem({ count: 1, eligible: true })).toBeNull();
    expect(buildCreateThreadGroupContextMenuItem({ count: 3, eligible: false })).toBeNull();
  });

  it("offers moves to other groups and out of the current group", () => {
    expect(
      buildThreadGroupMembershipContextMenuItems({
        groups: [
          { id: "group-1", title: "Current" },
          { id: "group-2", title: "Destination" },
        ],
        currentGroupId: "group-1",
      }),
    ).toEqual([
      {
        id: "move-to-group",
        label: "Move to group",
        icon: "folder-tree",
        separatorBefore: true,
        children: [{ id: "move-to-group:group-2", label: "Destination", icon: "folder" }],
      },
      {
        id: "move-out-of-group",
        label: "Remove from group",
        icon: "folder",
        separatorBefore: false,
      },
    ]);
  });
});

describe("buildSidebarListItems", () => {
  const groupThreads = [
    { id: "thread-a", projectKey: "project-a" },
    { id: "thread-b", projectKey: "project-a" },
    { id: "thread-c", projectKey: "project-a" },
  ];
  // The sidebar's thread map resolves rows only from the layout's visible
  // threads, so the list must derive its active rows from the same source.
  const visibleKeys = (
    layout: ReturnType<typeof buildSidebarThreadGroupLayout<{ id: string }>>,
  ): string[] =>
    layout.flatMap((item) =>
      item.kind === "thread"
        ? [item.thread.id]
        : item.group.collapsed
          ? item.threads.slice(0, 1).map((thread) => thread.id)
          : item.threads.map((thread) => thread.id),
    );

  it("emits only a collapsed group's anchor as an active row", () => {
    const layout = buildSidebarThreadGroupLayout({
      threads: groupThreads,
      groupsByProject: {
        "project-a": [
          {
            id: "group-1",
            title: "Related work",
            threadIds: ["thread-b", "thread-c"],
            collapsed: true,
          },
        ],
      },
      getId: (thread) => thread.id,
      getProjectKey: (thread) => thread.projectKey,
    });
    const keys = visibleKeys(layout);
    expect(keys).toEqual(["thread-a", "thread-b"]);

    const items = buildSidebarListItems({
      hasNoThreads: false,
      pinnedKeys: [],
      activeKeys: keys,
      hasSnoozedThreads: false,
      snoozedVisibleKeys: [],
      settledKeys: [],
    });
    expect(
      items.flatMap((item) =>
        item.kind === "thread" && item.section === "active" ? [item.key] : [],
      ),
    ).toEqual(["thread-a", "thread-b"]);
    // A row for the hidden member would reach the renderer unresolved and
    // crash on its thread fields (issue #901).
    const resolvable = new Set(keys);
    for (const item of items) {
      if (item.kind === "thread") expect(resolvable.has(item.key)).toBe(true);
    }
  });

  it("keeps an expanded group's rows contiguous in layout order", () => {
    const layout = buildSidebarThreadGroupLayout({
      threads: groupThreads,
      groupsByProject: {
        "project-a": [
          {
            id: "group-1",
            title: "Related work",
            threadIds: ["thread-b", "thread-c"],
            collapsed: false,
          },
        ],
      },
      getId: (thread) => thread.id,
      getProjectKey: (thread) => thread.projectKey,
    });

    expect(
      buildSidebarListItems({
        hasNoThreads: false,
        pinnedKeys: [],
        activeKeys: visibleKeys(layout),
        hasSnoozedThreads: false,
        snoozedVisibleKeys: [],
        settledKeys: ["thread-a"],
      }),
    ).toEqual([
      { kind: "marker", marker: "pinned-header" },
      { kind: "marker", marker: "pinned-divider" },
      { kind: "marker", marker: "active-placeholder" },
      { kind: "thread", key: "thread-a", section: "active" },
      { kind: "thread", key: "thread-b", section: "active" },
      { kind: "thread", key: "thread-c", section: "active" },
      { kind: "marker", marker: "settled-header" },
      { kind: "marker", marker: "settled-placeholder" },
      { kind: "thread", key: "thread-a", section: "settled" },
    ]);
  });

  it("puts the working shelf between the active inbox and the snoozed shelf", () => {
    const items = buildSidebarListItems({
      hasNoThreads: false,
      pinnedKeys: [],
      activeKeys: ["thread-a"],
      workingKeys: ["thread-w"],
      hasSnoozedThreads: true,
      snoozedVisibleKeys: [],
      settledKeys: [],
    });
    expect(items.slice(3, 6)).toEqual([
      { kind: "thread", key: "thread-a", section: "active" },
      { kind: "marker", marker: "working-header" },
      { kind: "thread", key: "thread-w", section: "working" },
    ]);
    expect(items[6]).toEqual({ kind: "marker", marker: "snoozed-header" });
    // A collapsed shelf keeps its header with no rows; no working thread drops it.
    expect(
      buildSidebarListItems({
        hasNoThreads: false,
        pinnedKeys: [],
        activeKeys: [],
        workingKeys: [],
        hasSnoozedThreads: false,
        snoozedVisibleKeys: [],
        settledKeys: [],
      }).filter((item) => item.kind === "marker" && item.marker === "working-header"),
    ).toHaveLength(1);
  });

  it("renders nothing without threads and the snoozed shelf only when populated", () => {
    const empty = {
      pinnedKeys: [],
      activeKeys: [],
      snoozedVisibleKeys: [],
      settledKeys: [],
    };
    expect(
      buildSidebarListItems({ hasNoThreads: true, hasSnoozedThreads: true, ...empty }),
    ).toEqual([]);
    expect(
      buildSidebarListItems({ hasNoThreads: false, hasSnoozedThreads: true, ...empty }),
    ).toEqual([
      { kind: "marker", marker: "pinned-header" },
      { kind: "marker", marker: "pinned-divider" },
      { kind: "marker", marker: "active-placeholder" },
      { kind: "marker", marker: "snoozed-header" },
      { kind: "marker", marker: "settled-header" },
      { kind: "marker", marker: "settled-placeholder" },
    ]);
    expect(
      buildSidebarListItems({ hasNoThreads: false, hasSnoozedThreads: false, ...empty }),
    ).toEqual([
      { kind: "marker", marker: "pinned-header" },
      { kind: "marker", marker: "pinned-divider" },
      { kind: "marker", marker: "active-placeholder" },
      { kind: "marker", marker: "settled-header" },
      { kind: "marker", marker: "settled-placeholder" },
    ]);
  });
});
