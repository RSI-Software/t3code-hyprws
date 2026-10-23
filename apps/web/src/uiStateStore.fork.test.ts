import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  parsePersistedState,
  persistState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  renameThreadGroup,
  renameThreadGroupIfCurrent,
  reorderProjectThreads,
  setThreadGroupMembership,
  setThreadGroupParent,
  type UiState,
} from "./uiStateStore";
function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    sidebarProjectScopeKeys: [],
    threadOrderByProject: {},
    threadGroups: [],
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
  it("changes group membership atomically without changing thread order", () => {
    const order = ["environment:a", "environment:b", "environment:c", "environment:d"];
    const initial = makeUiState({
      threadOrderByProject: { "environment:project": order },
      threadGroups: [
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
    });
    const created = setThreadGroupMembership(initial, order, ["environment:b", "environment:d"], {
      kind: "new",
      group: { id: "group-3", title: "New group" },
    });
    expect(created.threadGroups).toEqual([
      {
        id: "group-3",
        title: "New group",
        threadIds: ["environment:b", "environment:d"],
        collapsed: false,
      },
    ]);
    expect(created.threadOrderByProject).toBe(initial.threadOrderByProject);
    const moved = setThreadGroupMembership(initial, order, ["environment:d"], {
      kind: "existing",
      groupId: "group-1",
    });
    expect(moved.threadGroups).toEqual([
      {
        id: "group-1",
        title: "First",
        threadIds: ["environment:a", "environment:b", "environment:d"],
        collapsed: false,
      },
    ]);
    const movedOut = setThreadGroupMembership(initial, order, ["environment:a"], {
      kind: "none",
    });
    expect(movedOut.threadGroups).toEqual([
      {
        id: "group-2",
        title: "Second",
        threadIds: ["environment:c", "environment:d"],
        collapsed: false,
      },
    ]);
  });
  it("keeps temporarily hidden members when moving a thread into a group", () => {
    const order = ["environment:a", "environment:b", "environment:c"];
    const initial = makeUiState({
      threadGroups: [
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
    });
    const moved = setThreadGroupMembership(initial, order, ["environment:c"], {
      kind: "existing",
      groupId: "group-1",
    });
    expect(moved.threadGroups).toEqual([
      {
        id: "group-1",
        title: "Target",
        threadIds: ["environment:a", "environment:c", "environment:hidden"],
        collapsed: false,
      },
    ]);
  });
  it("sets a member as group parent and clears it when that member leaves", () => {
    const order = ["environment:a", "environment:b", "environment:c"];
    const initial = makeUiState({
      threadGroups: [{ id: "group-1", title: "Work", threadIds: [...order], collapsed: false }],
    });
    expect(setThreadGroupParent(initial, "group-1", "environment:outside")).toBe(initial);
    const parented = setThreadGroupParent(initial, "group-1", "environment:b");
    expect(parented.threadGroups[0]?.parentThreadId).toBe("environment:b");
    const left = setThreadGroupMembership(parented, order, ["environment:b"], { kind: "none" });
    expect(left.threadGroups[0]).toEqual({
      id: "group-1",
      title: "Work",
      threadIds: ["environment:a", "environment:c"],
      collapsed: false,
    });
    const stayed = setThreadGroupMembership(parented, order, ["environment:c"], { kind: "none" });
    expect(stayed.threadGroups[0]?.parentThreadId).toBe("environment:b");
    expect(setThreadGroupParent(parented, "group-1", null).threadGroups[0]).not.toHaveProperty(
      "parentThreadId",
    );
    // A drag takes the lead with asParent; the old parent stays a member.
    const join = { kind: "existing", groupId: "group-1" } as const;
    const led = setThreadGroupMembership(parented, order, ["environment:c"], {
      ...join,
      asParent: true,
    });
    expect(led.threadGroups[0]).toMatchObject({
      threadIds: order,
      parentThreadId: "environment:c",
    });
    // Rejoining as a child is how the parent steps down.
    const steppedDown = setThreadGroupMembership(led, order, ["environment:c"], join);
    expect(steppedDown.threadGroups[0]).toEqual(initial.threadGroups[0]);
  });
  it("does not apply a generated title after the group changes", () => {
    const initial = makeUiState({
      threadGroups: [
        {
          id: "group-1",
          title: "New group",
          threadIds: ["environment:a", "environment:b"],
          collapsed: false,
        },
      ],
    });
    const expected = {
      title: "New group",
      threadIds: ["environment:a", "environment:b"],
    };
    const generated = renameThreadGroupIfCurrent(initial, "group-1", expected, "Generated name");
    expect(generated.threadGroups[0]?.title).toBe("Generated name");
    const manuallyRenamed = renameThreadGroup(initial, "group-1", "Manual name");
    expect(
      renameThreadGroupIfCurrent(manuallyRenamed, "group-1", expected, "Late generated name"),
    ).toBe(manuallyRenamed);
    const membershipChanged = {
      ...initial,
      threadGroups: [
        {
          ...initial.threadGroups[0]!,
          threadIds: ["environment:a", "environment:b", "environment:c"],
        },
      ],
    };
    expect(
      renameThreadGroupIfCurrent(membershipChanged, "group-1", expected, "Late generated name"),
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
    expect(Object.keys(readPersisted())).not.toContain("threadGroups");

    persistState(
      makeUiState({
        threadOrderByProject: {
          "environment:project-1": ["environment:thread-2", "environment:thread-1"],
        },
        threadGroups: [
          {
            id: "group-1",
            title: "Related work",
            threadIds: ["environment:thread-2"],
            collapsed: false,
          },
        ],
      }),
    );

    expect(readPersisted().threadOrderByProject).toEqual({
      "environment:project-1": ["environment:thread-2", "environment:thread-1"],
    });
    expect(readPersisted().threadGroups).toEqual([
      {
        id: "group-1",
        title: "Related work",
        threadIds: ["environment:thread-2"],
        collapsed: false,
      },
    ]);
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
      threadGroups: [
        {
          id: "group-1",
          title: " Related work ",
          threadIds: ["environment:thread-2", "environment:thread-1"],
          collapsed: false,
          parentThreadId: "environment:gone",
        },
      ],
    } as PersistedUiState);

    expect(parsed.threadOrderByProject).toEqual({
      "environment:project-1": ["environment:thread-2", "environment:thread-1"],
    });
    expect(parsed.threadGroups).toEqual([
      {
        id: "group-1",
        title: "Related work",
        threadIds: ["environment:thread-2", "environment:thread-1"],
        collapsed: false,
      },
    ]);
  });

  it("merges per-project groups saved before groups could span projects", () => {
    const group = (id: string, threadIds: string[]) => ({
      id,
      title: id,
      threadIds,
      collapsed: false,
    });
    const parsed = parsePersistedState({
      threadGroupsByProject: {
        "environment:project-1": [group("group-1", ["environment:a", "environment:b"])],
        "environment:project-2": [group("group-2", ["environment:c", "environment:d"])],
      },
    });
    expect(parsed.threadGroups).toEqual([
      group("group-1", ["environment:a", "environment:b"]),
      group("group-2", ["environment:c", "environment:d"]),
    ]);
  });
});
