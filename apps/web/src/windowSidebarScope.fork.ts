// Per-window sidebar project scope (RSI-Software/t3code-hyprws#1344).
//
// Upstream persists `sidebarProjectScopeKey` in the one shared UI-state blob,
// so the last window to change it wins and every window reopens on that value.
// On desktop each window instead keeps its own record under
// `<prefix><WindowId>`, read at startup over the shared value:
//
// - a window with a record reopens on it (reload, crash reload, update restore);
// - a window without one starts on its seed project, or all projects when
//   seeded so, else on the shared value as upstream does (a fresh launch);
// - a record whose window lock is free and whose stamp is past the restore
//   horizon, and still free after one grace re-check, belongs to a closed
//   window and is dropped.
//
// Plain web has no WindowId and keeps upstream's shared scope unchanged.
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

/** The slice of the UI-state store this module reads and writes. */
export interface ScopeStore {
  readonly getState: () => { readonly sidebarProjectScopeKey: string | null };
  readonly setState: (partial: { readonly sidebarProjectScopeKey: string | null }) => void;
  readonly subscribe: (
    listener: (
      state: { readonly sidebarProjectScopeKey: string | null },
      previous: { readonly sidebarProjectScopeKey: string | null },
    ) => void,
  ) => () => void;
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

interface ScopeRecord {
  readonly scopeKey: string | null;
  readonly touchedAt: number;
}

function readRecord(storage: StringStorage, key: string): ScopeRecord | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { scopeKey, touchedAt } = parsed as Record<string, unknown>;
    return {
      scopeKey: typeof scopeKey === "string" && scopeKey.length > 0 ? scopeKey : null,
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
   * The scope this window opens on: its own record, else all projects while a
   * seed is pending or when seeded so; `undefined` keeps the shared value.
   */
  readonly initialScopeKey: string | null | undefined;
  /** Records this window's scope. */
  readonly write: (scopeKey: string | null) => void;
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

  const write = (scopeKey: string | null) => {
    // A choice made before the seed resolved outranks the seed.
    pendingSeed = null;
    try {
      env.local.setItem(ownKey, JSON.stringify({ scopeKey, touchedAt: now() }));
    } catch {
      // Denied storage: the scope still holds for this page.
    }
  };

  // An all-projects seed is a choice: keep it across reloads and restores.
  if (own === null && seed === "all-projects") write(null);

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
    initialScopeKey: own !== null ? own.scopeKey : seed === null ? undefined : null,
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

/** Puts `store` on this window's scope and records every later change. */
export function bindWindowSidebarScope(store: ScopeStore, scope: WindowSidebarScope): () => void {
  if (
    scope.initialScopeKey !== undefined &&
    store.getState().sidebarProjectScopeKey !== scope.initialScopeKey
  ) {
    store.setState({ sidebarProjectScopeKey: scope.initialScopeKey });
  }
  // An inherited scope becomes this window's own, so a restore finds it even
  // after another window changes the shared value.
  if (scope.initialScopeKey === undefined) scope.write(store.getState().sidebarProjectScopeKey);
  return store.subscribe((state, previous) => {
    if (state.sidebarProjectScopeKey !== previous.sidebarProjectScopeKey) {
      scope.write(state.sidebarProjectScopeKey);
    }
  });
}

let active: { readonly store: ScopeStore; readonly scope: WindowSidebarScope } | null = null;

/** Scopes the UI-state store to this desktop window; a no-op on plain web. */
export function install(store: ScopeStore): void {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  const windowId = bridge?.windowId;
  if (windowId === undefined || windowId.length === 0) return;
  let local: Storage;
  try {
    local = window.localStorage;
  } catch {
    return;
  }
  const scope = createWindowSidebarScope(
    { local, locks: typeof navigator !== "undefined" ? navigator.locks : undefined },
    windowId,
    bridge?.windowScopeSeed ?? null,
  );
  bindWindowSidebarScope(store, scope);
  active = { store, scope };
  window.addEventListener("pagehide", scope.stamp);
  void scope.sweep();
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
