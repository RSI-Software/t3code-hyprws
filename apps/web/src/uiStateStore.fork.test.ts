import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  parsePersistedState,
  persistState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  reorderProjectThreads,
  type UiState,
} from "./uiStateStore";
function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    sidebarProjectScopeKey: null,
    threadOrderByProject: {},
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

  it("writes manual order only once the fork feature is used", () => {
    persistState(makeUiState());

    // A profile that never reordered anything persists exactly what upstream
    // persists, so an upstream build reads it back unchanged.
    expect(Object.keys(readPersisted())).not.toContain("threadOrderByProject");

    persistState(
      makeUiState({
        threadOrderByProject: {
          "environment:project-1": ["environment:thread-2", "environment:thread-1"],
        },
      }),
    );

    expect(readPersisted().threadOrderByProject).toEqual({
      "environment:project-1": ["environment:thread-2", "environment:thread-1"],
    });
  });

  it("drops blank, duplicate, and empty entries when reading manual order", () => {
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
    });

    expect(parsed.threadOrderByProject).toEqual({
      "environment:project-1": ["environment:thread-2", "environment:thread-1"],
    });
  });
});
