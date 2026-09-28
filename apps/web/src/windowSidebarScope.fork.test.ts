import {
  EnvironmentId,
  ProjectId,
  type ScopedProjectRef,
  type WindowScopeSeed,
} from "@t3tools/contracts";
import type { ProjectFilter } from "@t3tools/client-runtime/state/project-filter";
import { Storage } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { create } from "zustand";

import {
  parsePersistedState,
  PERSISTED_STATE_KEY,
  setSidebarProjectScopeKey,
  type UiState,
} from "./uiStateStore";
import {
  bindWindowSidebarScope,
  createWindowSidebarScope,
  type LockManagerLike,
  WINDOW_SIDEBAR_SCOPE_GRACE_MS,
  WINDOW_SIDEBAR_SCOPE_PREFIX,
  WINDOW_SIDEBAR_SCOPE_RESTORE_HORIZON_MS,
  WEB_TAB_WINDOW_ID,
} from "./windowSidebarScope.fork";

const WINDOW_A = "00000000-0000-4000-8000-00000000000a";
const WINDOW_B = "00000000-0000-4000-8000-00000000000b";
const WINDOW_C = "00000000-0000-4000-8000-00000000000c";

const ref = (environmentId: string, projectId: string): ScopedProjectRef => ({
  environmentId: EnvironmentId.make(environmentId),
  projectId: ProjectId.make(projectId),
});

const groups = [
  { projectKey: "github.com/acme/api", memberProjectRefs: [ref("local", "api")] },
  { projectKey: "github.com/acme/web", memberProjectRefs: [ref("local", "web"), ref("vm", "web")] },
];

interface FakeLocks extends LockManagerLike {
  /** Ends a window's page, releasing the lock it held for its lifetime. */
  readonly close: (windowId: string) => void;
}

function createLocks(): FakeLocks {
  const held = new Set<string>();
  return {
    request: (name, callback) => {
      held.add(name);
      return Promise.resolve(callback());
    },
    query: async () => ({ held: [...held].map((name) => ({ name })) }),
    close: (windowId) => {
      for (const name of held) if (name.endsWith(windowId)) held.delete(name);
    },
  };
}

// A controlled clock: time moves only when a test says so, and a scheduled
// re-check runs only when the test fires it.
function createClock(start = 1_000_000) {
  let now = start;
  const timers: Array<{ readonly at: number; readonly run: () => unknown }> = [];
  return {
    now: () => now,
    setTimer: (run: () => unknown, ms: number) => timers.push({ at: now + ms, run }),
    advance: (ms: number) => {
      now += ms;
    },
    /** Runs every timer now due and waits for what it started. */
    fire: async () => {
      const due = timers.filter((timer) => timer.at <= now);
      timers.splice(0, timers.length, ...timers.filter((timer) => timer.at > now));
      await Promise.all(due.map((timer) => timer.run()));
    },
  };
}

// One window's UI-state store the way upstream builds it: hydrated from the one
// shared blob, and writing its scope back there on every change.
function openWindow(
  local: Storage,
  windowId: string,
  options: {
    locks?: LockManagerLike;
    clock?: ReturnType<typeof createClock>;
    seed?: WindowScopeSeed;
  } = {},
) {
  const raw = local.getItem(PERSISTED_STATE_KEY);
  const store = create<UiState & { setSidebarProjectScopeKey: (key: string | null) => void }>(
    (set) => ({
      ...parsePersistedState(raw === null ? {} : JSON.parse(raw)),
      setSidebarProjectScopeKey: (key) => set((state) => setSidebarProjectScopeKey(state, key)),
    }),
  );
  store.subscribe((state) =>
    local.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({ sidebarProjectScopeKey: state.sidebarProjectScopeKey }),
    ),
  );
  const scope = createWindowSidebarScope(
    {
      local,
      locks: options.locks,
      ...(options.clock ? { now: options.clock.now, setTimer: options.clock.setTimer } : {}),
    },
    windowId,
    options.seed ?? null,
  );
  const filter = bindWindowSidebarScope(store, scope);
  // The chooser's pick, through the store action as upstream's chooser calls it.
  const choose = (scopeKey: string | null) => store.getState().setSidebarProjectScopeKey(scopeKey);
  return { store, scope, filter, choose, scopeKey: () => store.getState().sidebarProjectScopeKey };
}

const entry = (key: string) => {
  const group = groups.find((candidate) => candidate.projectKey === key)!;
  return { key, members: group.memberProjectRefs };
};
const bothProjects: ProjectFilter = {
  entries: [entry("github.com/acme/api"), entry("github.com/acme/web")],
};

describe("per-window sidebar project scope", () => {
  it("restart: two windows keep different scopes", () => {
    const local = new Storage();
    const a = openWindow(local, WINDOW_A);
    const b = openWindow(local, WINDOW_B);
    a.choose("github.com/acme/api");
    b.choose("github.com/acme/web");

    // The shared blob holds only the last writer; each window reopens on its own.
    const restoredA = openWindow(local, WINDOW_A);
    const restoredB = openWindow(local, WINDOW_B);
    expect(restoredA.scopeKey()).toBe("github.com/acme/api");
    expect(restoredB.scopeKey()).toBe("github.com/acme/web");
  });

  it("restart: inherited scope survives another window's later pick", () => {
    const local = new Storage();
    openWindow(local, WINDOW_A).choose("github.com/acme/api");

    // A fresh launch: C inherits `api`, then B picks `web`, the last shared write.
    const c = openWindow(local, WINDOW_C);
    expect(c.scopeKey()).toBe("github.com/acme/api");
    openWindow(local, WINDOW_B).choose("github.com/acme/web");

    // An update restore reuses C's WindowId; it reopens on what it showed.
    expect(openWindow(local, WINDOW_C).scopeKey()).toBe("github.com/acme/api");
  });

  it("a fresh launch without a record or seed reopens on the last scope, as upstream", () => {
    const local = new Storage();
    openWindow(local, WINDOW_A).choose("github.com/acme/api");

    // Main mints a new WindowId on every launch that is not an update restore.
    expect(openWindow(local, WINDOW_B).scopeKey()).toBe("github.com/acme/api");
  });

  it("an all-projects seed opts a new window out of the last scope, and keeps it", () => {
    const local = new Storage();
    openWindow(local, WINDOW_A).choose("github.com/acme/api");

    expect(openWindow(local, WINDOW_B, { seed: "all-projects" }).scopeKey()).toBeNull();
    // An update restore reuses the WindowId without replaying the seed.
    expect(openWindow(local, WINDOW_B).scopeKey()).toBeNull();
  });

  it("clearing the scope is kept as all projects", () => {
    const local = new Storage();
    const a = openWindow(local, WINDOW_A);
    a.choose("github.com/acme/api");
    a.choose(null);
    openWindow(local, WINDOW_B).choose("github.com/acme/web");

    expect(openWindow(local, WINDOW_A).scopeKey()).toBeNull();
  });

  it("seed: a seeded window starts on its project", () => {
    const local = new Storage();
    const seeded = openWindow(local, WINDOW_A, { seed: ref("vm", "web") });
    expect(seeded.scopeKey()).toBeNull();

    // Groups load after startup; the seed resolves to its logical project once.
    expect(seeded.scope.takeSeed([], false)).toBeNull();
    const scopeKey = seeded.scope.takeSeed(groups, false);
    expect(scopeKey).toBe("github.com/acme/web");
    seeded.store.setState({ sidebarProjectScopeKey: scopeKey });
    expect(seeded.scope.takeSeed(groups, true)).toBeNull();

    // Electron replays the seed argument on reload; the window's own choice wins.
    seeded.choose("github.com/acme/api");
    const reloaded = openWindow(local, WINDOW_A, { seed: ref("vm", "web") });
    expect(reloaded.scopeKey()).toBe("github.com/acme/api");
    expect(reloaded.scope.takeSeed(groups, true)).toBeNull();
  });

  it("a choice made before the seed resolves outranks it", () => {
    const seeded = openWindow(new Storage(), WINDOW_A, { seed: ref("local", "api") });
    seeded.choose("github.com/acme/web");

    expect(seeded.scope.takeSeed(groups, true)).toBeNull();
  });

  it("a seed whose project never loads is dropped once projects settle", () => {
    const seeded = openWindow(new Storage(), WINDOW_A, { seed: ref("local", "gone") });

    expect(seeded.scope.takeSeed(groups, true)).toBeNull();
    expect(
      seeded.scope.takeSeed(
        [...groups, { projectKey: "late", memberProjectRefs: [ref("local", "gone")] }],
        true,
      ),
    ).toBeNull();
  });

  it("close: closing a window drops its state", async () => {
    const local = new Storage();
    const locks = createLocks();
    const clock = createClock();
    const env = { locks, clock };
    const a = openWindow(local, WINDOW_A, env);
    const b = openWindow(local, WINDOW_B, env);
    a.choose("github.com/acme/api");
    b.choose("github.com/acme/web");
    const bKey = `${WINDOW_SIDEBAR_SCOPE_PREFIX}${WINDOW_B}`;

    // B closes. Inside the restore horizon an update relaunch may still restore
    // its WindowId, so a sweep keeps the record.
    b.scope.stamp();
    locks.close(WINDOW_B);
    clock.advance(WINDOW_SIDEBAR_SCOPE_RESTORE_HORIZON_MS - 1);
    await a.scope.sweep();
    clock.advance(WINDOW_SIDEBAR_SCOPE_GRACE_MS);
    await clock.fire();
    expect(local.getItem(bKey)).not.toBeNull();

    // Past the horizon, and still unlocked after the grace re-check, it is dropped.
    clock.advance(1);
    await openWindow(local, WINDOW_A, env).scope.sweep();
    expect(local.getItem(bKey)).not.toBeNull();
    clock.advance(WINDOW_SIDEBAR_SCOPE_GRACE_MS);
    await clock.fire();
    expect(local.getItem(bKey)).toBeNull();
    // B's own scope is gone; reopened, it inherits the shared one A last put back.
    expect(openWindow(local, WINDOW_B, env).scopeKey()).toBe("github.com/acme/api");
  });

  it("a live window keeps its state however old, and an update restore reclaims it", async () => {
    const local = new Storage();
    const locks = createLocks();
    const clock = createClock();
    const env = { locks, clock };
    const a = openWindow(local, WINDOW_A, env);
    const b = openWindow(local, WINDOW_B, env);
    a.choose("github.com/acme/api");
    b.choose("github.com/acme/web");

    // Both windows stay open well past the horizon.
    clock.advance(2 * WINDOW_SIDEBAR_SCOPE_RESTORE_HORIZON_MS);
    await a.scope.sweep();
    await clock.fire();
    expect(local.getItem(`${WINDOW_SIDEBAR_SCOPE_PREFIX}${WINDOW_B}`)).not.toBeNull();
  });

  it("restore: an update quit that skips unload keeps every window's old record", async () => {
    const local = new Storage();
    const locks = createLocks();
    const clock = createClock();
    const env = { locks, clock };
    openWindow(local, WINDOW_A, env).choose("github.com/acme/api");
    openWindow(local, WINDOW_B, env).choose("github.com/acme/web");

    // Hours later an update quits: windows are destroyed, never stamped.
    clock.advance(4 * WINDOW_SIDEBAR_SCOPE_RESTORE_HORIZON_MS);
    locks.close(WINDOW_A);
    locks.close(WINDOW_B);

    // A restores and sweeps before B's page has taken its lock back.
    clock.advance(5_000);
    const restoredA = openWindow(local, WINDOW_A, env);
    await restoredA.scope.sweep();
    clock.advance(5_000);
    const restoredB = openWindow(local, WINDOW_B, env);
    clock.advance(WINDOW_SIDEBAR_SCOPE_GRACE_MS);
    await clock.fire();

    expect(restoredA.scopeKey()).toBe("github.com/acme/api");
    expect(restoredB.scopeKey()).toBe("github.com/acme/web");
    expect(openWindow(local, WINDOW_B, env).scopeKey()).toBe("github.com/acme/web");
  });
});

describe("per-window project filter", () => {
  it("restart: a window reopens on every entry it selected", () => {
    const local = new Storage();
    const a = openWindow(local, WINDOW_A);
    a.filter.set(bothProjects);
    // Two entries have no single-select value, so the shared key shows all.
    expect(a.scopeKey()).toBeNull();
    openWindow(local, WINDOW_B).choose("github.com/acme/web");

    const restored = openWindow(local, WINDOW_A);
    expect(restored.filter.get()).toEqual(bothProjects);
    expect(restored.scopeKey()).toBeNull();
  });

  it("the single-select chooser's pick is a one-entry filter, and its reset clears it", () => {
    const a = openWindow(new Storage(), WINDOW_A);
    a.choose("github.com/acme/api");
    expect(a.filter.get()).toEqual({ entries: [{ key: "github.com/acme/api", members: [] }] });

    a.filter.set({ entries: [entry("github.com/acme/web")] });
    expect(a.scopeKey()).toBe("github.com/acme/web");
    a.choose(null);
    expect(a.filter.get().entries).toEqual([]);
  });

  it("with several entries, the chooser's All projects clears them and one pick replaces them", () => {
    const a = openWindow(new Storage(), WINDOW_A);
    a.filter.set(bothProjects);
    a.choose(null);
    expect(a.filter.get().entries).toEqual([]);

    a.filter.set(bothProjects);
    a.choose("github.com/acme/api");
    expect(a.filter.get().entries.map((entry) => entry.key)).toEqual(["github.com/acme/api"]);
    expect(a.scopeKey()).toBe("github.com/acme/api");
  });

  it("a scope record from before the filter reopens as a one-entry filter", () => {
    const local = new Storage();
    local.setItem(
      `${WINDOW_SIDEBAR_SCOPE_PREFIX}${WINDOW_A}`,
      JSON.stringify({ scopeKey: "github.com/acme/api", touchedAt: 1 }),
    );

    const a = openWindow(local, WINDOW_A);
    expect(a.scopeKey()).toBe("github.com/acme/api");
    expect(a.filter.get()).toEqual({ entries: [{ key: "github.com/acme/api", members: [] }] });
  });
});

describe("installing the per-window scope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // A fresh module per test: `install` binds one store per page.
  async function installInto(
    bridge: Record<string, unknown> | undefined,
    { local = new Storage(), session = new Storage() } = {},
  ) {
    local.setItem(PERSISTED_STATE_KEY, JSON.stringify({ sidebarProjectScopeKey: "shared" }));
    vi.stubGlobal("window", {
      desktopBridge: bridge,
      localStorage: local,
      sessionStorage: session,
      addEventListener() {},
    });
    vi.stubGlobal("navigator", {});
    vi.resetModules();
    const module = await import("./windowSidebarScope.fork");
    const store = create(() => parsePersistedState({ sidebarProjectScopeKey: "shared" }));
    module.install(store);
    return { module, store, local, session };
  }

  it("Web: plain web keeps each tab's filter in sessionStorage", async () => {
    const first = await installInto(undefined);
    // A new tab inherits the shared scope, as upstream.
    expect(first.module.windowProjectFilterState().get().entries).toEqual([
      { key: "shared", members: [] },
    ]);
    first.module.applyWindowSidebarScopeSeed(groups, true);
    first.module.windowProjectFilterState().set(bothProjects);

    const tabKey = `${WINDOW_SIDEBAR_SCOPE_PREFIX}${WEB_TAB_WINDOW_ID}`;
    expect(JSON.parse(first.session.getItem(tabKey) ?? "{}")).toEqual(
      expect.objectContaining({ filter: bothProjects }),
    );
    // Nothing per tab reaches the shared localStorage.
    const localKeys = Array.from({ length: first.local.length }, (_, i) => first.local.key(i));
    expect(localKeys).toEqual([PERSISTED_STATE_KEY]);

    // A reload keeps the tab's sessionStorage and reopens on its filter.
    const reloaded = await installInto(undefined, { session: first.session });
    expect(reloaded.module.windowProjectFilterState().get()).toEqual(bothProjects);
    expect(reloaded.store.getState().sidebarProjectScopeKey).toBeNull();

    // Another tab has its own sessionStorage and does not see it.
    const other = await installInto(undefined, { local: first.local });
    expect(other.module.windowProjectFilterState().get()).not.toEqual(bothProjects);
  });

  it("the sidebar's seed path puts the installed window on its seed project", async () => {
    const { module, store, local } = await installInto({
      windowId: WINDOW_A,
      windowScopeSeed: ref("vm", "web"),
    });
    expect(store.getState().sidebarProjectScopeKey).toBeNull();

    module.applyWindowSidebarScopeSeed([], false);
    expect(store.getState().sidebarProjectScopeKey).toBeNull();
    module.applyWindowSidebarScopeSeed(groups, false);

    expect(store.getState().sidebarProjectScopeKey).toBe("github.com/acme/web");
    expect(JSON.parse(local.getItem(`${WINDOW_SIDEBAR_SCOPE_PREFIX}${WINDOW_A}`) ?? "{}")).toEqual(
      expect.objectContaining({
        filter: { entries: [{ key: "github.com/acme/web", members: [] }] },
      }),
    );
  });
});
