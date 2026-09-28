// Per-window sidebar project filter (RSI-Software/t3code-hyprws#1344,
// RSI-Software/t3code-hyprws#1351).
//
// Upstream persists one `sidebarProjectScopeKey` in the shared UI-state blob,
// so the last window to change it wins and every window reopens on that value.
// Each window instead keeps its own `ProjectFilter` record under
// `<prefix><WindowId>`, read at startup over the shared value. The upstream key
// stays the single-select chooser's value: picking an entry makes a one-entry
// filter, and a one-entry filter shows as that entry.
//
// Desktop keeps the record in localStorage, because an update relaunch
// restores a window's WindowId and must find its filter:
//
// - a window with a record reopens on it (reload, crash reload, update restore);
// - a window without one starts on its seed project, or all projects when
//   seeded so, else on the shared value as upstream does (a fresh launch);
// - a record whose window lock is free and whose stamp is past the restore
//   horizon, and still free after one grace re-check, belongs to a closed
//   window and is dropped.
//
// Plain web has no WindowId; each tab keeps its record in sessionStorage,
// which the browser already scopes to the tab and drops when it closes.
import {
  ALL_PROJECTS_FILTER,
  decodeProjectFilter,
  projectFilterFromKey,
  projectFilterScopeKey,
  type ProjectFilter,
} from "@t3tools/client-runtime/state/project-filter";
import type { ScopedProjectRef, WindowScopeSeed } from "@t3tools/contracts";
import { useEffect } from "react";

type StringStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export interface LockManagerLike {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
  query(): Promise<{ readonly held?: ReadonlyArray<{ readonly name?: string }> }>;
}

export interface WindowSidebarScopeEnv {
  readonly local: StringStorage;
  readonly locks?: LockManagerLike | undefined;
  /** Clock and timer, injectable so tests need no real waits. */
  readonly now?: () => number;
  readonly setTimer?: (callback: () => unknown, ms: number) => unknown;
}

interface ScopeState {
  readonly sidebarProjectScopeKey: string | null;
  /** The single-select chooser's action; every pick goes through it. */
  readonly setSidebarProjectScopeKey?: (projectKey: string | null) => void;
}

/** The slice of the UI-state store this module reads and writes. */
export interface ScopeStore {
  readonly getState: () => ScopeState;
  readonly setState: (partial: Partial<ScopeState>) => void;
  readonly subscribe: (listener: (state: ScopeState, previous: ScopeState) => void) => () => void;
}

export const WINDOW_SIDEBAR_SCOPE_PREFIX = "t3code:window-sidebar-scope:v1:";
const windowLock = (windowId: string) => `t3code:window-sidebar-scope:window:${windowId}`;

// A closed window's record stays this long because an update relaunch may
// still restore its WindowId. Matches the desktop restore manifest's max age.
export const WINDOW_SIDEBAR_SCOPE_RESTORE_HORIZON_MS = 30 * 60 * 1_000;

// Quit destroys windows without unloading them, so a restored window's record
// can be old and unlocked until its page loads and takes the lock back. A
// sweep re-checks the lock once after this long before dropping a record.
export const WINDOW_SIDEBAR_SCOPE_GRACE_MS = 60 * 1_000;

// The plain-web tab's record key; sessionStorage already scopes it to the tab.
export const WEB_TAB_WINDOW_ID = "tab";

interface ScopeRecord {
  readonly filter: ProjectFilter;
  readonly touchedAt: number;
}

function readRecord(storage: StringStorage, key: string): ScopeRecord | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { filter, scopeKey, touchedAt } = parsed as Record<string, unknown>;
    return {
      // A single-scope record from before the filter becomes a one-entry filter.
      filter:
        decodeProjectFilter(filter) ??
        projectFilterFromKey(typeof scopeKey === "string" && scopeKey.length > 0 ? scopeKey : null),
      touchedAt: typeof touchedAt === "number" ? touchedAt : 0,
    };
  } catch {
    return null;
  }
}

const sameRef = (a: ScopedProjectRef, b: ScopedProjectRef) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId;

export interface WindowSidebarScope {
  /**
   * The filter this window opens on: its own record, else all projects while a
   * seed is pending or when seeded so; `undefined` keeps the shared value.
   */
  readonly initialFilter: ProjectFilter | undefined;
  /** Records this window's filter. */
  readonly write: (filter: ProjectFilter) => void;
  /** Re-stamps this window's record so a restore within the horizon finds it. */
  readonly stamp: () => void;
  /** Resolves the seed against the loaded project groups, once. */
  readonly takeSeed: (
    groups: ReadonlyArray<{
      readonly projectKey: string;
      readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
    }>,
    settled: boolean,
  ) => string | null;
  /**
   * Drops the records of closed windows. Resolves once the one grace re-check
   * is scheduled; the scheduled callback returns the re-check's promise.
   */
  readonly sweep: () => Promise<void>;
}

export function createWindowSidebarScope(
  env: WindowSidebarScopeEnv,
  windowId: string,
  seed: WindowScopeSeed | null,
): WindowSidebarScope {
  const now = env.now ?? Date.now;
  const ownKey = `${WINDOW_SIDEBAR_SCOPE_PREFIX}${windowId}`;
  const own = readRecord(env.local, ownKey);
  // A record wins over the seed: the window already chose a scope.
  let pendingSeed = own === null && seed !== "all-projects" ? seed : null;

  const write = (filter: ProjectFilter) => {
    // A choice made before the seed resolved outranks the seed.
    pendingSeed = null;
    try {
      env.local.setItem(ownKey, JSON.stringify({ filter, touchedAt: now() }));
    } catch {
      // Denied storage: the scope still holds for this page.
    }
  };

  // An all-projects seed is a choice: keep it across reloads and restores.
  if (own === null && seed === "all-projects") write(ALL_PROJECTS_FILTER);

  // Held for this page's lifetime; the browser releases it when the window closes.
  const lockHeld = env.locks
    ? new Promise<void>((granted) => {
        void env.locks?.request(windowLock(windowId), () => {
          granted();
          return new Promise<never>(() => {});
        });
      })
    : Promise.resolve();

  return {
    initialFilter: own !== null ? own.filter : seed === null ? undefined : ALL_PROJECTS_FILTER,
    write,
    stamp: () => {
      const current = readRecord(env.local, ownKey);
      if (current === null) return;
      try {
        env.local.setItem(ownKey, JSON.stringify({ ...current, touchedAt: now() }));
      } catch {
        // Denied storage: nothing to keep.
      }
    },
    takeSeed: (groups, settled) => {
      if (pendingSeed === null) return null;
      const target = pendingSeed;
      const group = groups.find((candidate) =>
        candidate.memberProjectRefs.some((ref) => sameRef(ref, target)),
      );
      // A seed whose project never loads is dropped, not held forever.
      if (group !== undefined || settled) pendingSeed = null;
      return group?.projectKey ?? null;
    },
    sweep: async () => {
      const locks = env.locks;
      // Without Web Locks a live window is indistinguishable from a closed one.
      if (!locks) return;
      await lockHeld;
      const unlocked = async (keys: ReadonlyArray<string>) => {
        const { held = [] } = await locks.query();
        const heldNames = new Set(held.flatMap((lock) => (lock.name ? [lock.name] : [])));
        return keys.filter(
          (key) => !heldNames.has(windowLock(key.slice(WINDOW_SIDEBAR_SCOPE_PREFIX.length))),
        );
      };
      const others: string[] = [];
      for (let index = 0; index < env.local.length; index += 1) {
        const key = env.local.key(index);
        if (key !== null && key.startsWith(WINDOW_SIDEBAR_SCOPE_PREFIX) && key !== ownKey) {
          others.push(key);
        }
      }
      const expired = (await unlocked(others)).filter(
        (key) =>
          now() - (readRecord(env.local, key)?.touchedAt ?? 0) >=
          WINDOW_SIDEBAR_SCOPE_RESTORE_HORIZON_MS,
      );
      if (expired.length === 0) return;
      // One re-check: a window still loading takes its lock back inside the grace.
      (env.setTimer ?? setTimeout)(async () => {
        for (const key of await unlocked(expired)) env.local.removeItem(key);
      }, WINDOW_SIDEBAR_SCOPE_GRACE_MS);
    },
  };
}

/** This window's filter, kept in step with the store's single-select key. */
export interface WindowProjectFilterState {
  readonly get: () => ProjectFilter;
  readonly set: (filter: ProjectFilter) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Puts `store` on this window's filter and records every later change. A new
 * store key becomes a one-entry filter; a filter shows in the store as its one
 * entry's key, else `null`.
 */
export function bindWindowSidebarScope(
  store: ScopeStore,
  scope: WindowSidebarScope,
): WindowProjectFilterState {
  let filter = scope.initialFilter ?? projectFilterFromKey(store.getState().sidebarProjectScopeKey);
  const listeners = new Set<() => void>();
  const mirror = () => {
    const scopeKey = projectFilterScopeKey(filter);
    if (store.getState().sidebarProjectScopeKey !== scopeKey) {
      store.setState({ sidebarProjectScopeKey: scopeKey });
    }
  };
  const set = (next: ProjectFilter) => {
    if (next === filter) return;
    filter = next;
    scope.write(next);
    mirror();
    for (const listener of listeners) listener();
  };
  mirror();
  // An inherited scope becomes this window's own, so a restore finds it even
  // after another window changes the shared value.
  if (scope.initialFilter === undefined) scope.write(filter);
  store.subscribe((state, previous) => {
    const scopeKey = state.sidebarProjectScopeKey;
    // The filter's own mirror is not a new pick.
    if (scopeKey === previous.sidebarProjectScopeKey) return;
    if (scopeKey === projectFilterScopeKey(filter)) return;
    set(projectFilterFromKey(scopeKey));
  });
  // Several entries show as no key, so the chooser's "All projects" changes
  // nothing in the store; the pick itself still clears or replaces them.
  const choose = store.getState().setSidebarProjectScopeKey;
  if (choose !== undefined) {
    store.setState({
      setSidebarProjectScopeKey: (projectKey) => {
        choose(projectKey);
        const picked = store.getState().sidebarProjectScopeKey;
        if (filter.entries.length > 1 || projectFilterScopeKey(filter) !== picked) {
          set(projectFilterFromKey(picked));
        }
      },
    });
  }
  return {
    get: () => filter,
    set,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let active: {
  readonly store: ScopeStore;
  readonly scope: WindowSidebarScope;
  readonly filter: WindowProjectFilterState;
} | null = null;

const NO_STORAGE: StringStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  key: () => null,
  length: 0,
};

function readStorage(name: "localStorage" | "sessionStorage"): StringStorage {
  try {
    return window[name] ?? NO_STORAGE;
  } catch {
    // Denied storage: the filter still holds for this page.
    return NO_STORAGE;
  }
}

/** Scopes the UI-state store's project filter to this window or tab. */
export function install(store: ScopeStore): void {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  const windowId = bridge?.windowId;
  if (windowId === undefined || windowId.length === 0) {
    const scope = createWindowSidebarScope(
      { local: readStorage("sessionStorage") },
      WEB_TAB_WINDOW_ID,
      null,
    );
    active = { store, scope, filter: bindWindowSidebarScope(store, scope) };
    return;
  }
  const scope = createWindowSidebarScope(
    {
      local: readStorage("localStorage"),
      locks: typeof navigator !== "undefined" ? navigator.locks : undefined,
    },
    windowId,
    bridge?.windowScopeSeed ?? null,
  );
  active = { store, scope, filter: bindWindowSidebarScope(store, scope) };
  window.addEventListener("pagehide", scope.stamp);
  void scope.sweep();
}

const detachedFilter: WindowProjectFilterState = {
  get: () => ALL_PROJECTS_FILTER,
  set: () => {},
  subscribe: () => () => {},
};

/** The installed window's filter; a fixed all-projects filter where none is installed. */
export function windowProjectFilterState(): WindowProjectFilterState {
  return active?.filter ?? detachedFilter;
}

type SeedGroups = Parameters<WindowSidebarScope["takeSeed"]>[0];

/** Applies the installed window's seed project once `groups` resolve it. */
export function applyWindowSidebarScopeSeed(groups: SeedGroups, settled: boolean): void {
  if (active === null) return;
  const scopeKey = active.scope.takeSeed(groups, settled);
  if (scopeKey !== null) active.store.setState({ sidebarProjectScopeKey: scopeKey });
}

/** Applies this window's seed project once the sidebar's project groups resolve it. */
export function useWindowSidebarScopeSeed(groups: SeedGroups, settled: boolean): void {
  useEffect(() => applyWindowSidebarScopeSeed(groups, settled), [groups, settled]);
}
