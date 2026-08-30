import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  legacyProjectCwdPreferenceKey,
  markThreadUnread,
  markThreadVisited,
  moveProjectThread,
  parsePersistedState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  renameThreadGroup,
  renameThreadGroupIfCurrent,
  reorderProjectThreads,
  reorderProjects,
  resolveProjectExpanded,
  setDefaultAdvertisedEndpointKey,
  setProjectExpanded,
  setThreadGroupMembership,
  setThreadChangedFilesExpanded,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    threadOrderByProject: {},
    threadGroupsByProject: {},
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    defaultAdvertisedEndpointKey: null,
    ...overrides,
  };
}

describe("uiStateStore pure functions", () => {
  it("stores server timestamps without moving visit state backwards", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState();
    const visited = markThreadVisited(initialState, threadId, "2026-02-25T12:30:00.700Z");

    expect(visited.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:30:00.700Z");
    expect(markThreadVisited(visited, threadId, "2026-02-25T12:30:00.000Z")).toBe(visited);
    expect(markThreadVisited(visited, threadId, "not-a-date")).toBe(visited);
  });

  it("marks a completed thread unread using the server completion timestamp", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, "2026-02-25T12:30:00.000Z");

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:29:59.999Z");
    expect(markThreadUnread(next, threadId, null)).toBe(next);
  });

  it("resolves project expansion from logical, physical, and legacy preference keys", () => {
    const physicalKey = "environment:/repo/project";
    const legacyKey = legacyProjectCwdPreferenceKey("/repo/project");

    expect(resolveProjectExpanded({ logical: false, [physicalKey]: true }, ["logical"])).toBe(
      false,
    );
    expect(resolveProjectExpanded({ [physicalKey]: false }, ["new-logical", physicalKey])).toBe(
      false,
    );
    expect(resolveProjectExpanded({ [legacyKey]: false }, ["new-logical", legacyKey])).toBe(false);
    expect(resolveProjectExpanded({}, ["new-logical"])).toBe(true);
  });

  it("sets expansion for every stable key belonging to a logical project", () => {
    const initialState = makeUiState();
    const keys = ["logical", "environment-a:/repo", "environment-b:/repo"];

    const next = setProjectExpanded(initialState, keys, false);

    expect(next.projectExpandedById).toEqual({
      logical: false,
      "environment-a:/repo": false,
      "environment-b:/repo": false,
    });
    expect(setProjectExpanded(next, keys, false)).toBe(next);
  });

  it("reorders from the current atom-derived project order", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const project3 = ProjectId.make("project-3");
    const currentOrder = [project1, project2, project3];

    const next = reorderProjects(makeUiState(), currentOrder, [project1], [project3]);

    expect(next.projectOrder).toEqual([project2, project3, project1]);
  });

  it("moves grouped project members together", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const currentOrder = [keyALocal, keyARemote, keyB, keyC];

    const next = reorderProjects(makeUiState(), currentOrder, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
  });

  it("does not reorder missing or identical groups", () => {
    const currentOrder = ["env-local:proj-a", "env-local:proj-b"];
    const state = makeUiState();

    expect(reorderProjects(state, currentOrder, ["env-local:missing"], ["env-local:proj-b"])).toBe(
      state,
    );
    expect(reorderProjects(state, currentOrder, ["env-local:proj-a"], ["env-local:proj-a"])).toBe(
      state,
    );
  });

  it("persists a dropped thread against its current project order", () => {
    const initialState = makeUiState();
    const next = reorderProjectThreads(
      initialState,
      "environment:project",
      ["environment:a", "environment:b", "environment:c"],
      "environment:c",
      "environment:a",
    );

    expect(next.threadOrderByProject).toEqual({
      "environment:project": ["environment:c", "environment:a", "environment:b"],
    });
    expect(
      reorderProjectThreads(
        initialState,
        "environment:project",
        ["environment:a"],
        "environment:missing",
        "environment:a",
      ),
    ).toBe(initialState);
  });

  it("creates, extends, moves, and dissolves visual thread groups", () => {
    const order = ["environment:a", "environment:b", "environment:c", "environment:d"];
    const created = moveProjectThread(
      makeUiState(),
      "environment:project",
      order,
      "environment:c",
      "environment:b",
      "group",
      { id: "group-1", title: "New group" },
    );
    expect(created.threadGroupsByProject["environment:project"]).toEqual([
      {
        id: "group-1",
        title: "New group",
        threadIds: ["environment:c", "environment:b"],
        collapsed: false,
      },
    ]);

    const extended = moveProjectThread(
      created,
      "environment:project",
      created.threadOrderByProject["environment:project"] ?? order,
      "environment:d",
      "environment:b",
      "group",
    );
    expect(extended.threadGroupsByProject["environment:project"]?.[0]?.threadIds).toEqual([
      "environment:c",
      "environment:d",
      "environment:b",
    ]);

    const movedOut = moveProjectThread(
      extended,
      "environment:project",
      extended.threadOrderByProject["environment:project"] ?? order,
      "environment:c",
      "environment:a",
      "reorder",
    );
    expect(movedOut.threadGroupsByProject["environment:project"]?.[0]?.threadIds).toEqual([
      "environment:d",
      "environment:b",
    ]);

    const dissolved = moveProjectThread(
      movedOut,
      "environment:project",
      movedOut.threadOrderByProject["environment:project"] ?? order,
      "environment:d",
      "environment:a",
      "reorder",
    );
    expect(dissolved.threadGroupsByProject["environment:project"]).toEqual([]);
  });

  it("changes group membership atomically without changing thread order", () => {
    const projectKey = "environment:project";
    const order = ["environment:a", "environment:b", "environment:c", "environment:d"];
    const initial = makeUiState({
      threadOrderByProject: { [projectKey]: order },
      threadGroupsByProject: {
        [projectKey]: [
          {
            id: "group-1",
            title: "First",
            threadIds: ["environment:a", "environment:b"],
            collapsed: true,
          },
          {
            id: "group-2",
            title: "Second",
            threadIds: ["environment:c", "environment:d"],
            collapsed: false,
          },
        ],
      },
    });

    const created = setThreadGroupMembership(
      initial,
      projectKey,
      order,
      ["environment:b", "environment:d"],
      { kind: "new", group: { id: "group-3", title: "New group" } },
    );
    expect(created.threadGroupsByProject[projectKey]).toEqual([
      {
        id: "group-3",
        title: "New group",
        threadIds: ["environment:b", "environment:d"],
        collapsed: false,
      },
    ]);
    expect(created.threadOrderByProject).toBe(initial.threadOrderByProject);

    const moved = setThreadGroupMembership(initial, projectKey, order, ["environment:d"], {
      kind: "existing",
      groupId: "group-1",
    });
    expect(moved.threadGroupsByProject[projectKey]).toEqual([
      {
        id: "group-1",
        title: "First",
        threadIds: ["environment:a", "environment:b", "environment:d"],
        collapsed: false,
      },
    ]);

    const movedOut = setThreadGroupMembership(initial, projectKey, order, ["environment:a"], {
      kind: "none",
    });
    expect(movedOut.threadGroupsByProject[projectKey]).toEqual([
      {
        id: "group-2",
        title: "Second",
        threadIds: ["environment:c", "environment:d"],
        collapsed: false,
      },
    ]);
  });

  it("keeps temporarily hidden members when moving a thread into a group", () => {
    const projectKey = "environment:project";
    const order = ["environment:a", "environment:b", "environment:c"];
    const initial = makeUiState({
      threadGroupsByProject: {
        [projectKey]: [
          {
            id: "group-1",
            title: "Target",
            threadIds: ["environment:a", "environment:hidden"],
            collapsed: false,
          },
          {
            id: "group-2",
            title: "Source",
            threadIds: ["environment:b", "environment:c"],
            collapsed: false,
          },
        ],
      },
    });

    const moved = setThreadGroupMembership(initial, projectKey, order, ["environment:c"], {
      kind: "existing",
      groupId: "group-1",
    });

    expect(moved.threadGroupsByProject[projectKey]).toEqual([
      {
        id: "group-1",
        title: "Target",
        threadIds: ["environment:a", "environment:c", "environment:hidden"],
        collapsed: false,
      },
    ]);
  });

  it("does not apply a generated title after the group changes", () => {
    const projectKey = "environment:project";
    const initial = makeUiState({
      threadGroupsByProject: {
        [projectKey]: [
          {
            id: "group-1",
            title: "New group",
            threadIds: ["environment:a", "environment:b"],
            collapsed: false,
          },
        ],
      },
    });
    const expected = {
      title: "New group",
      threadIds: ["environment:a", "environment:b"],
    };

    const generated = renameThreadGroupIfCurrent(
      initial,
      projectKey,
      "group-1",
      expected,
      "Generated name",
    );
    expect(generated.threadGroupsByProject[projectKey]?.[0]?.title).toBe("Generated name");

    const manuallyRenamed = renameThreadGroup(initial, projectKey, "group-1", "Manual name");
    expect(
      renameThreadGroupIfCurrent(
        manuallyRenamed,
        projectKey,
        "group-1",
        expected,
        "Late generated name",
      ),
    ).toBe(manuallyRenamed);

    const membershipChanged = {
      ...initial,
      threadGroupsByProject: {
        [projectKey]: [
          {
            ...initial.threadGroupsByProject[projectKey]![0]!,
            threadIds: ["environment:a", "environment:b", "environment:c"],
          },
        ],
      },
    };
    expect(
      renameThreadGroupIfCurrent(
        membershipChanged,
        projectKey,
        "group-1",
        expected,
        "Late generated name",
      ),
    ).toBe(membershipChanged);
  });

  it("stores explicit changed-file expansion choices", () => {
    const threadId = ThreadId.make("thread-1");
    const collapsed = setThreadChangedFilesExpanded(makeUiState(), threadId, "turn-1", false);

    expect(collapsed.threadChangedFilesExpandedById).toEqual({
      [threadId]: {
        "turn-1": false,
      },
    });
    expect(
      setThreadChangedFilesExpanded(collapsed, threadId, "turn-1", true)
        .threadChangedFilesExpandedById,
    ).toEqual({
      [threadId]: {
        "turn-1": true,
      },
    });
  });

  it("stores the endpoint preference by stable key", () => {
    const next = setDefaultAdvertisedEndpointKey(makeUiState(), "desktop-core:lan:http");

    expect(next.defaultAdvertisedEndpointKey).toBe("desktop-core:lan:http");
    expect(setDefaultAdvertisedEndpointKey(next, "desktop-core:lan:http")).toBe(next);
    expect(setDefaultAdvertisedEndpointKey(next, "")).toMatchObject({
      defaultAdvertisedEndpointKey: null,
    });
  });
});

describe("parsePersistedState", () => {
  it("hydrates raw UI-owned state without server entities", () => {
    const parsed = parsePersistedState({
      projectExpandedById: {
        logical: false,
        invalid: "no" as unknown as boolean,
      },
      projectOrder: ["physical-b", "", "physical-a", "physical-b"],
      threadOrderByProject: {
        "environment:project-1": [
          "environment:thread-2",
          "",
          "environment:thread-1",
          "environment:thread-2",
        ],
        invalid: [] as string[],
      },
      threadGroupsByProject: {
        "environment:project-1": [
          {
            id: "group-1",
            title: " Related work ",
            threadIds: ["environment:thread-2", "environment:thread-1"],
            collapsed: false,
          },
        ],
      },
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
        invalid: "not-a-date",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpansionVersion: 1,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });

    expect(parsed).toEqual({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadOrderByProject: {
        "environment:project-1": ["environment:thread-2", "environment:thread-1"],
      },
      threadGroupsByProject: {
        "environment:project-1": [
          {
            id: "group-1",
            title: "Related work",
            threadIds: ["environment:thread-2", "environment:thread-1"],
            collapsed: false,
          },
        ],
      },
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });
  });

  it("ignores changed-file expansion values saved with legacy folder semantics", () => {
    const parsed = parsePersistedState({
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
        },
      },
    });

    expect(parsed.threadChangedFilesExpandedById).toEqual({});
  });

  it("migrates legacy CWD project preferences into local alias keys", () => {
    const parsed = parsePersistedState({
      collapsedProjectCwds: ["/repo/b"],
      expandedProjectCwds: ["/repo/a"],
      projectOrderCwds: ["/repo/b", "/repo/a"],
    });
    const projectAKey = legacyProjectCwdPreferenceKey("/repo/a");
    const projectBKey = legacyProjectCwdPreferenceKey("/repo/b");

    expect(parsed.projectOrder).toEqual([projectBKey, projectAKey]);
    expect(resolveProjectExpanded(parsed.projectExpandedById, [projectAKey])).toBe(true);
    expect(resolveProjectExpanded(parsed.projectExpandedById, [projectBKey])).toBe(false);
    expect(resolveProjectExpanded(parsed.projectExpandedById, ["unknown"])).toBe(true);
  });

  it("preserves legacy expanded-only semantics for one-way migration", () => {
    const parsed = parsePersistedState({
      expandedProjectCwds: ["/repo/a"],
    });

    expect(
      resolveProjectExpanded(parsed.projectExpandedById, [
        legacyProjectCwdPreferenceKey("/repo/a"),
      ]),
    ).toBe(true);
    expect(
      resolveProjectExpanded(parsed.projectExpandedById, [
        legacyProjectCwdPreferenceKey("/repo/b"),
      ]),
    ).toBe(false);
  });
});

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => {
      store.clear();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("uiStateStore persistence", () => {
  let localStorageStub: Storage;

  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists raw UI preferences including thread visit markers", () => {
    const state = makeUiState({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadOrderByProject: {
        "environment:project-1": ["environment:thread-2", "environment:thread-1"],
      },
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
    });

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted).toEqual({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadOrderByProject: {
        "environment:project-1": ["environment:thread-2", "environment:thread-1"],
      },
      threadGroupsByProject: {},
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpansionVersion: 1,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });
    expect(parsePersistedState(persisted)).toEqual({
      ...state,
    });
  });

  it("drops the temporary expanded-only migration fallback when rewriting state", () => {
    const migrated = parsePersistedState({
      expandedProjectCwds: ["/repo/a"],
    });

    persistState(migrated);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(resolveProjectExpanded(persisted.projectExpandedById ?? {}, ["unknown"])).toBe(true);
  });
});
