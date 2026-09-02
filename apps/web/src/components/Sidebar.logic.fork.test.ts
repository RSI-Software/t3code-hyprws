import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildCreateThreadGroupContextMenuItem,
  buildSidebarThreadGroupLayout,
  buildSidebarThreadSortableItems,
  buildThreadGroupMembershipContextMenuItems,
  getSidebarThreadGroupDissolvingKey,
  getSidebarThreadLayoutOrder,
  hasSavedSidebarThreadOrder,
  isSidebarThreadGroupDrop,
  isSidebarThreadGroupingTarget,
  isSidebarThreadUngroupBeforeTarget,
  isProjectInSidebarScope,
  resolveCompletedTurnTiming,
  orderThreadsByProjectPreference,
  resolveSidebarThreadOrderMarker,
  resolveSidebarThreadSortOrderAfterDrop,
  shouldShowSidebarDoneStatus,
  formatSidebarRelativeTimeLabel,
} from "./Sidebar.logic";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { localEnvironmentId, makeLatestTurn } from "./Sidebar.logic.test.ts";

describe("sidebar thread drag ordering", () => {
  it.each(["created_at", "updated_at", "manual"] as const)(
    "uses manual order after a successful drop from %s",
    (currentOrder) => {
      expect(resolveSidebarThreadSortOrderAfterDrop(currentOrder)).toBe("manual");
    },
  );

  it("only exposes custom order when the current project scope has a saved sequence", () => {
    const orderByProject = {
      "environment:project-a": ["thread-a", "thread-b"],
      "environment:project-b": ["thread-c"],
    };

    expect(hasSavedSidebarThreadOrder({ orderByProject, scopedProjectKeys: null })).toBe(true);
    expect(
      hasSavedSidebarThreadOrder({
        orderByProject,
        scopedProjectKeys: new Set(["environment:project-a"]),
      }),
    ).toBe(true);
    expect(
      hasSavedSidebarThreadOrder({
        orderByProject,
        scopedProjectKeys: new Set(["environment:project-b"]),
      }),
    ).toBe(false);
  });

  it.each([
    {
      sortOrder: "updated_at" as const,
      hasSavedCustomOrder: false,
      expected: {
        currentLabel: "Newest first",
        hoverLabel: "Drag threads to reorder",
        action: "none",
      },
    },
    {
      sortOrder: "updated_at" as const,
      hasSavedCustomOrder: true,
      expected: {
        currentLabel: "Newest first",
        hoverLabel: "Use custom order",
        action: "use-custom",
      },
    },
    {
      sortOrder: "manual" as const,
      hasSavedCustomOrder: true,
      expected: {
        currentLabel: "Custom order",
        hoverLabel: "Sort newest first",
        action: "use-newest",
      },
    },
  ])("describes the current order and its $expected.hoverLabel affordance", (input) => {
    expect(resolveSidebarThreadOrderMarker(input)).toEqual(input.expected);
  });
});

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

describe("orderThreadsByProjectPreference", () => {
  it("reorders within each project without moving project slots", () => {
    const threads = [
      { id: "a-1", project: "a" },
      { id: "b-1", project: "b" },
      { id: "a-2", project: "a" },
      { id: "b-2", project: "b" },
    ];

    expect(
      orderThreadsByProjectPreference({
        threads,
        preferredIdsByProject: {
          a: ["a-2", "a-1"],
          b: ["b-2", "b-1"],
        },
        getId: (thread) => thread.id,
        getProjectKey: (thread) => thread.project,
      }).map((thread) => thread.id),
    ).toEqual(["a-2", "b-2", "a-1", "b-1"]);
  });

  it("appends new threads in their automatic order", () => {
    const threads = [
      { id: "new", project: "a" },
      { id: "saved-1", project: "a" },
      { id: "saved-2", project: "a" },
    ];

    expect(
      orderThreadsByProjectPreference({
        threads,
        preferredIdsByProject: { a: ["saved-2", "saved-1"] },
        getId: (thread) => thread.id,
        getProjectKey: (thread) => thread.project,
      }).map((thread) => thread.id),
    ).toEqual(["saved-2", "saved-1", "new"]);
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
