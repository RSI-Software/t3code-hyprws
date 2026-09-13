import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildCreateThreadGroupContextMenuItem,
  buildSidebarListItems,
  buildSidebarThreadGroupLayout,
  buildSidebarThreadSortableItems,
  buildThreadGroupMembershipContextMenuItems,
  getSidebarThreadGroupDissolvingKey,
  getSidebarThreadLayoutOrder,
  isSidebarThreadGroupDrop,
  isSidebarThreadGroupingTarget,
  isSidebarThreadUngroupBeforeTarget,
  isSidebarGroupHeaderGroupingTarget,
  isProjectInSidebarScope,
  resolveCompletedTurnTiming,
  resolveSidebarDropTarget,
  resolveSidebarGroupHeaderDropAnchor,
  parseSidebarThreadGroupHeaderId,
  shouldShowSidebarDoneStatus,
  formatSidebarRelativeTimeLabel,
  sidebarThreadGroupHeaderId,
} from "./Sidebar.logic";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { localEnvironmentId, makeLatestTurn } from "./Sidebar.logic.test.ts";

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

  it("keeps group headers in the sortable geometry and threads in visual order", () => {
    const layout = buildSidebarThreadGroupLayout({
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
    });

    expect(buildSidebarThreadSortableItems({ layout, getId: (thread) => thread.id })).toEqual([
      { kind: "thread", id: "thread-a" },
      {
        kind: "group-header",
        id: "sidebar-thread-group\0project-a\0group-1",
        projectKey: "project-a",
        groupId: "group-1",
        anchorThreadId: "thread-b",
      },
      { kind: "thread", id: "thread-b" },
      { kind: "thread", id: "thread-c" },
    ]);
    expect(getSidebarThreadLayoutOrder({ layout, getId: (thread) => thread.id })).toEqual([
      "thread-a",
      "thread-b",
      "thread-c",
    ]);
  });

  it("keeps a collapsed group header measurable without rendering its rows", () => {
    const layout = buildSidebarThreadGroupLayout({
      threads,
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

    expect(buildSidebarThreadSortableItems({ layout, getId: (thread) => thread.id })).toEqual([
      { kind: "thread", id: "thread-a" },
      {
        kind: "group-header",
        id: "sidebar-thread-group\0project-a\0group-1",
        projectKey: "project-a",
        groupId: "group-1",
        anchorThreadId: "thread-b",
      },
    ]);
    expect(getSidebarThreadLayoutOrder({ layout, getId: (thread) => thread.id })).toEqual([
      "thread-a",
      "thread-b",
      "thread-c",
    ]);
  });

  it("reserves only the row edges for reordering", () => {
    const overRect = { top: 100, bottom: 200 };
    expect(isSidebarThreadGroupDrop({ activeRect: { top: 96, bottom: 136 }, overRect })).toBe(true);
    expect(isSidebarThreadGroupDrop({ activeRect: { top: 80, bottom: 110 }, overRect })).toBe(
      false,
    );
  });

  it("accepts the full group header as a grouping target", () => {
    expect(
      isSidebarThreadGroupingTarget({
        activeGroupId: null,
        overGroupId: "group-1",
        overGroupHeader: true,
        activeRect: null,
        overRect: null,
      }),
    ).toBe(true);
    expect(
      isSidebarThreadGroupingTarget({
        activeGroupId: "group-1",
        overGroupId: "group-1",
        overGroupHeader: true,
        activeRect: null,
        overRect: null,
      }),
    ).toBe(false);
  });

  it("uses the first member's own group header as an ungroup-before target", () => {
    const activeGroup = {
      id: "group-1",
      title: "Related work",
      threadIds: ["thread-a", "thread-b"],
      collapsed: false,
    };
    const groupHeader = {
      kind: "group-header" as const,
      id: "group-header-1",
      projectKey: "project-a",
      groupId: "group-1",
      anchorThreadId: "thread-a",
    };

    expect(
      isSidebarThreadUngroupBeforeTarget({
        activeThreadId: "thread-a",
        activeGroup,
        overItem: groupHeader,
      }),
    ).toBe(true);
    expect(
      isSidebarThreadUngroupBeforeTarget({
        activeThreadId: "thread-b",
        activeGroup,
        overItem: groupHeader,
      }),
    ).toBe(false);
    expect(
      isSidebarThreadUngroupBeforeTarget({
        activeThreadId: "thread-a",
        activeGroup,
        overItem: { ...groupHeader, groupId: "group-2" },
      }),
    ).toBe(false);
  });

  it("previews dissolution only while leaving a two-thread group", () => {
    const activeGroup = {
      id: "group-1",
      title: "Related work",
      threadIds: ["thread-a", "thread-b"],
      collapsed: false,
    };

    expect(
      getSidebarThreadGroupDissolvingKey({
        projectKey: "project-a",
        activeGroup,
        overGroupId: null,
      }),
    ).toBe("project-a\0group-1");
    expect(
      getSidebarThreadGroupDissolvingKey({
        projectKey: "project-a",
        activeGroup,
        overGroupId: "group-1",
      }),
    ).toBeNull();
    expect(
      getSidebarThreadGroupDissolvingKey({
        projectKey: "project-a",
        activeGroup: { ...activeGroup, threadIds: [...activeGroup.threadIds, "thread-c"] },
        overGroupId: null,
      }),
    ).toBeNull();
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

describe("sidebar group header drop targets", () => {
  const headerId = sidebarThreadGroupHeaderId("project-a", "group-1");
  const header = { projectKey: "project-a", groupId: "group-1" };
  const headerGroups = [{ id: "group-1", threadIds: ["env-a:thread-b", "env-a:thread-c"] }];

  it("round-trips a header id and refuses every other id space", () => {
    expect(parseSidebarThreadGroupHeaderId(headerId)).toEqual({
      projectKey: "project-a",
      groupId: "group-1",
    });
    expect(parseSidebarThreadGroupHeaderId("sidebar-thread-group\0project-a")).toBeNull();
    expect(parseSidebarThreadGroupHeaderId("sidebar-thread-group\0project-a\0")).toBeNull();
    expect(parseSidebarThreadGroupHeaderId("sidebar-thread-group\0\0group-1")).toBeNull();
    expect(parseSidebarThreadGroupHeaderId("sidebar-marker-pinned-header")).toBeNull();
    expect(parseSidebarThreadGroupHeaderId("env-a:thread-b")).toBeNull();
  });

  it("never resolves a header id as a reorder target", () => {
    // sidebarListItems emits no header entries, so the section resolver must
    // return null for one — the drag-end reorder path then bails instead of
    // writing a move against something adjacent.
    const items = buildSidebarListItems({
      hasNoThreads: false,
      pinnedKeys: [],
      activeKeys: ["env-a:thread-a", "env-a:thread-b", "env-a:thread-c"],
      hasSnoozedThreads: false,
      snoozedVisibleKeys: [],
      settledKeys: [],
    });
    expect(resolveSidebarDropTarget(items, "env-a:thread-a", headerId)).toBeNull();
    expect(resolveSidebarDropTarget(items, "env-a:thread-a", "env-a:thread-b")).not.toBeNull();
  });

  it("groups from a header only for active rows outside the header's group", () => {
    expect(
      isSidebarGroupHeaderGroupingTarget({
        activeKey: "env-a:thread-a",
        activeSection: "active",
        activeProjectKey: "project-a",
        header,
        groups: headerGroups,
      }),
    ).toBe(true);
    expect(
      isSidebarGroupHeaderGroupingTarget({
        activeKey: "env-a:thread-b",
        activeSection: "active",
        activeProjectKey: "project-a",
        header,
        groups: headerGroups,
      }),
    ).toBe(false);
    expect(
      isSidebarGroupHeaderGroupingTarget({
        activeKey: "env-a:thread-a",
        activeSection: "pinned",
        activeProjectKey: "project-a",
        header,
        groups: headerGroups,
      }),
    ).toBe(false);
    expect(
      isSidebarGroupHeaderGroupingTarget({
        activeKey: "env-a:thread-a",
        activeSection: "active",
        activeProjectKey: "project-b",
        header,
        groups: headerGroups,
      }),
    ).toBe(false);
    expect(
      isSidebarGroupHeaderGroupingTarget({
        activeKey: "env-a:thread-a",
        activeSection: "active",
        activeProjectKey: "project-a",
        header,
        groups: [],
      }),
    ).toBe(false);
  });

  it("lands a header drop on the group's first visible member", () => {
    expect(
      resolveSidebarGroupHeaderDropAnchor({
        header,
        groups: headerGroups,
        visibleMemberKeys: ["env-a:thread-a", "env-a:thread-b", "env-a:thread-c"],
      }),
    ).toBe("env-a:thread-b");
    // A collapsed group keeps only its anchor visible; the anchor still
    // anchors the drop.
    expect(
      resolveSidebarGroupHeaderDropAnchor({
        header,
        groups: headerGroups,
        visibleMemberKeys: ["env-a:thread-b"],
      }),
    ).toBe("env-a:thread-b");
    expect(
      resolveSidebarGroupHeaderDropAnchor({
        header,
        groups: [],
        visibleMemberKeys: ["env-a:thread-b"],
      }),
    ).toBeNull();
    expect(
      resolveSidebarGroupHeaderDropAnchor({
        header,
        groups: headerGroups,
        visibleMemberKeys: ["env-a:thread-a"],
      }),
    ).toBeNull();
  });
});

describe("isProjectInSidebarScope", () => {
  const forcedProjectRef = {
    environmentId: EnvironmentId.make("environment-remote"),
    projectId: ProjectId.make("shared-project"),
  };

  it("matches both the environment and project id for a forced physical scope", () => {
    expect(isProjectInSidebarScope(forcedProjectRef, forcedProjectRef)).toBe(true);
    expect(
      isProjectInSidebarScope(
        {
          environmentId: localEnvironmentId,
          projectId: forcedProjectRef.projectId,
        },
        forcedProjectRef,
      ),
    ).toBe(false);
  });

  it("keeps every project visible when scope is mutable", () => {
    expect(
      isProjectInSidebarScope(
        {
          environmentId: localEnvironmentId,
          projectId: ProjectId.make("project-1"),
        },
        null,
      ),
    ).toBe(true);
  });
});

describe("resolveCompletedTurnTiming", () => {
  it("freezes duration between the latest turn's start and completion", () => {
    expect(resolveCompletedTurnTiming({ latestTurn: makeLatestTurn() })).toEqual({
      completedAt: "2026-03-09T10:05:00.000Z",
      durationMs: 5 * 60_000,
    });
  });

  it("falls back to the request time when startedAt is missing or malformed", () => {
    expect(
      resolveCompletedTurnTiming({
        latestTurn: makeLatestTurn({ startedAt: "not-a-date" }),
      }),
    ).toEqual({
      completedAt: "2026-03-09T10:05:00.000Z",
      durationMs: 5 * 60_000,
    });
  });

  it("returns null for missing, malformed, or reversed completion intervals", () => {
    expect(resolveCompletedTurnTiming({ latestTurn: null })).toBeNull();
    expect(
      resolveCompletedTurnTiming({
        latestTurn: makeLatestTurn({ state: "error" }),
      }),
    ).toBeNull();
    expect(
      resolveCompletedTurnTiming({
        latestTurn: makeLatestTurn({ completedAt: "not-a-date" }),
      }),
    ).toBeNull();
    expect(
      resolveCompletedTurnTiming({
        latestTurn: makeLatestTurn({ completedAt: "2026-03-09T09:59:00.000Z" }),
      }),
    ).toBeNull();
  });
});

describe("shouldShowSidebarDoneStatus", () => {
  const completedTiming = {
    completedAt: "2026-03-09T10:05:00.000Z",
    durationMs: 5 * 60_000,
  };

  it("keeps Done visible after a completed thread is read", () => {
    expect(
      shouldShowSidebarDoneStatus({
        status: "ready",
        isUnread: false,
        interactionMode: "default",
        hasActionableProposedPlan: false,
        completedTiming,
      }),
    ).toBe(true);
  });

  it("preserves the existing unread badge without usable timing", () => {
    expect(
      shouldShowSidebarDoneStatus({
        status: "ready",
        isUnread: true,
        interactionMode: "default",
        hasActionableProposedPlan: false,
        completedTiming: null,
      }),
    ).toBe(true);
  });

  it("does not override live work or a read actionable plan", () => {
    expect(
      shouldShowSidebarDoneStatus({
        status: "working",
        isUnread: true,
        interactionMode: "default",
        hasActionableProposedPlan: false,
        completedTiming,
      }),
    ).toBe(false);
    expect(
      shouldShowSidebarDoneStatus({
        status: "ready",
        isUnread: false,
        interactionMode: "plan",
        hasActionableProposedPlan: true,
        completedTiming,
      }),
    ).toBe(false);
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

describe("formatSidebarRelativeTimeLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T10:10:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats how long ago an instant occurred", () => {
    expect(formatSidebarRelativeTimeLabel("2026-03-09T10:10:00.000Z")).toBe("now");
    expect(formatSidebarRelativeTimeLabel("2026-03-09T10:05:00.000Z")).toBe("5m");
    expect(formatSidebarRelativeTimeLabel("2026-03-09T08:05:00.000Z")).toBe("2h");
  });

  it("returns an empty label for malformed timestamps", () => {
    expect(formatSidebarRelativeTimeLabel("not-a-date")).toBe("");
  });
});
