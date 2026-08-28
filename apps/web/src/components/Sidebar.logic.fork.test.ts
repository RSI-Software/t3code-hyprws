import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import {
  animatePinnedLayoutChanges,
  archiveSelectedThreadEntries,
  buildBulkTitleRegenerationContextMenuItem,
  buildSidebarThreadGroupLayout,
  buildMultiSelectThreadContextMenuItems,
  createThreadJumpHintVisibilityController,
  filterSidebarProjectScopeItems,
  getSidebarThreadIdsToPrewarm,
  getVisibleSidebarThreadIds,
  resolveAdjacentThreadId,
  reduceSidebarProjectScopeMenuState,
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  getProjectSortTimestamp,
  hasUnseenCompletion,
  isContextMenuPointerDown,
  isSidebarThreadGroupDrop,
  isProjectInSidebarScope,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  resolveCompletedTurnTiming,
  orderThreadsByProjectPreference,
  resolveProjectStatusIndicator,
  resolveThreadRowClassName,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
  resolveWorkingStartedAt,
  shouldShowSidebarDoneStatus,
  searchSidebarThreadsByTitle,
  formatWorkingDurationLabel,
  formatSidebarRelativeTimeLabel,
  shouldNavigateAfterProjectRemoval,
  shouldClearThreadSelectionOnMouseDown,
  sortLogicalProjectsForSidebar,
  sortSettledThreadsForSidebar,
  pinOrderKeyBetween,
  planPinnedReorder,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  sortProjectsForSidebar,
  sortScopedProjectsForSidebar,
  shouldCreateNewThreadInCurrentProject,
  THREAD_JUMP_HINT_SHOW_DELAY_MS,
} from "./Sidebar.logic";
import {
  EnvironmentId,
  OrchestrationLatestTurn,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";
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

  it("only treats the center of a row as a grouping drop target", () => {
    const overRect = { top: 100, bottom: 200 };
    expect(isSidebarThreadGroupDrop({ activeRect: { top: 130, bottom: 170 }, overRect })).toBe(
      true,
    );
    expect(isSidebarThreadGroupDrop({ activeRect: { top: 80, bottom: 110 }, overRect })).toBe(
      false,
    );
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
