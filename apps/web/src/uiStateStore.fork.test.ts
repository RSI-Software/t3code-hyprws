import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  moveProjectThread,
  parsePersistedState,
  persistState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  renameThreadGroup,
  renameThreadGroupIfCurrent,
  reorderProjectThreads,
  setThreadGroupMembership,
  type UiState,
} from "./uiStateStore";
function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    sidebarProjectScopeKey: null,
    threadOrderByProject: {},
    threadGroupsByProject: {},
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    defaultAdvertisedEndpointKey: null,
    pullRequestMergeMethod: "merge",
    ...overrides,
  };
}
describe("uiStateStore pure functions", () => {
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
  it("moves a thread between groups at the dropped position", () => {
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
            collapsed: false,
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
    const moved = moveProjectThread(
      initial,
      projectKey,
      order,
      "environment:b",
      "environment:c",
      "group",
    );
    expect(moved.threadOrderByProject[projectKey]).toEqual([
      "environment:a",
      "environment:c",
      "environment:b",
      "environment:d",
    ]);
    expect(moved.threadGroupsByProject[projectKey]).toEqual([
      {
        id: "group-2",
        title: "Second",
        threadIds: ["environment:c", "environment:b", "environment:d"],
        collapsed: false,
      },
    ]);
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
});

describe("uiStateStore fork persistence", () => {
  const store = new Map<string, string>();
  const localStorageStub = {
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  } satisfies Storage;

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const readPersisted = (): PersistedUiState =>
    JSON.parse(localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}") as PersistedUiState;

  it("writes manual order and groups only once the fork feature is used", () => {
    persistState(makeUiState());

    // A profile that never reordered or grouped anything persists exactly what
    // upstream persists, so an upstream build reads it back unchanged.
    expect(Object.keys(readPersisted())).not.toContain("threadOrderByProject");
    expect(Object.keys(readPersisted())).not.toContain("threadGroupsByProject");

    persistState(
      makeUiState({
        threadOrderByProject: {
          "environment:project-1": ["environment:thread-2", "environment:thread-1"],
        },
        threadGroupsByProject: {
          "environment:project-1": [
            {
              id: "group-1",
              title: "Related work",
              threadIds: ["environment:thread-2"],
              collapsed: false,
            },
          ],
        },
      }),
    );

    expect(readPersisted().threadOrderByProject).toEqual({
      "environment:project-1": ["environment:thread-2", "environment:thread-1"],
    });
    expect(readPersisted().threadGroupsByProject).toEqual({
      "environment:project-1": [
        {
          id: "group-1",
          title: "Related work",
          threadIds: ["environment:thread-2"],
          collapsed: false,
        },
      ],
    });
  });

  it("drops blank, duplicate, and empty entries when reading manual order and groups", () => {
    const parsed = parsePersistedState({
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
    } as PersistedUiState);

    expect(parsed.threadOrderByProject).toEqual({
      "environment:project-1": ["environment:thread-2", "environment:thread-1"],
    });
    expect(parsed.threadGroupsByProject).toEqual({
      "environment:project-1": [
        {
          id: "group-1",
          title: "Related work",
          threadIds: ["environment:thread-2", "environment:thread-1"],
          collapsed: false,
        },
      ],
    });
  });
});
