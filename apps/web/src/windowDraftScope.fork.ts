// Per-window scope for unsent composer drafts (RSI-Software/t3code-hyprws#1346).
//
// The upstream store persists every draft under one route-derived key, so two
// windows on the same route share unsent (pre-thread) drafts and clobber each
// other. This module splits each persisted write in two:
//
// - the window bucket `<key>:window:<token>` holds draft sessions, their
//   composer drafts, and the project-to-session map; the token lives in
//   sessionStorage, so it survives a reload and differs per window;
// - the shared bucket `<key>` keeps thread drafts and sticky model choices.
//   A window writes only the slices it changed since it last read or wrote,
//   so another window's edits and deletions are never overwritten.
//
// Each live window holds a Web Lock named for its token. At startup, under the
// adopt lock, a window adopts every source nobody owns: draft sessions an older
// build left in the shared bucket, and window buckets whose token lock is not
// held (a closed tab, or every window of a previous Electron run) and whose
// `touchedAt` is older than a grace window. A window mid-reload takes its lock
// back inside that window; an unlocked fresh bucket is re-checked once after it.
// The adopter writes its own bucket first and clears the sources second, so no
// text is lost. Without the Web Locks API ownership is unknowable, so orphan
// buckets are left alone.
// Known limit: a duplicated web tab copies sessionStorage and shares the token.
import { Debouncer } from "@tanstack/react-pacer";

import type { DeferredStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

type StringStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
type DraftRecord = Readonly<Record<string, unknown>>;

export interface PersistedDraftsShape {
  readonly draftsByThreadKey: DraftRecord;
  readonly draftThreadsByThreadKey: DraftRecord;
  readonly logicalProjectDraftThreadKeyByLogicalProjectKey: DraftRecord;
  readonly stickyModelSelectionByProvider?: unknown;
  readonly stickyActiveProvider?: unknown;
}

interface PersistValue<S, P> {
  readonly state: { readonly capturedState: S } | P;
  readonly version?: number;
}

export interface LockManagerLike {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
  query(): Promise<{ readonly held?: ReadonlyArray<{ readonly name?: string }> }>;
}

export interface WindowDraftScopeEnv {
  readonly local: StringStorage;
  readonly session: StringStorage;
  readonly locks?: LockManagerLike | undefined;
  readonly debounceMs?: number;
  /** Clock and timer, injectable so tests need no real waits. */
  readonly now?: () => number;
  readonly setTimer?: (callback: () => unknown, ms: number) => unknown;
}

// An unlocked bucket touched within this window may belong to a window mid-reload,
// which takes its token lock back well inside it.
const ORPHAN_GRACE_MS = 5_000;

export const WINDOW_DRAFT_TOKEN_KEY = "t3code:composer-drafts:window-scope";
const WINDOW_DRAFT_ADOPT_LOCK = "t3code:composer-drafts:adopt";

const windowDraftBucketKey = (name: string, token: string): string => `${name}:window:${token}`;
const windowTokenLock = (token: string): string => `t3code:composer-drafts:window:${token}`;

interface Bucket {
  readonly state: Record<string, unknown>;
  readonly version: number | undefined;
  readonly touchedAt?: number | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordAt = (state: Record<string, unknown> | undefined, field: string) => {
  const value = state?.[field];
  return isRecord(value) ? value : {};
};

function readBucket(storage: StringStorage, key: string): Bucket | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.state)) return null;
    return {
      state: parsed.state,
      version: typeof parsed.version === "number" ? parsed.version : undefined,
      touchedAt: typeof parsed.touchedAt === "number" ? parsed.touchedAt : undefined,
    };
  } catch {
    return null;
  }
}

const writeBucket = (storage: StringStorage, key: string, bucket: Bucket) =>
  storage.setItem(key, JSON.stringify(bucket));

// The older version wins, so upstream `migrate` still sees legacy entries.
function oldestVersion(...buckets: ReadonlyArray<Bucket | null>): number | undefined {
  const versions = buckets.flatMap((bucket) =>
    bucket?.version === undefined ? [] : [bucket.version],
  );
  return versions.length > 0 ? Math.min(...versions) : undefined;
}

const createdAt = (sessions: Record<string, unknown>, session: unknown): string => {
  const draftThread = typeof session === "string" ? sessions[session] : undefined;
  return isRecord(draftThread) && typeof draftThread.createdAt === "string"
    ? draftThread.createdAt
    : "";
};

const pick = (record: DraftRecord, keep: (key: string) => boolean) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)));

function readWindowToken(session: StringStorage): string {
  try {
    const existing = session.getItem(WINDOW_DRAFT_TOKEN_KEY);
    if (existing) return existing;
  } catch {
    // Denied storage falls through to a token scoped to this page load.
  }
  const token = randomUUID();
  try {
    session.setItem(WINDOW_DRAFT_TOKEN_KEY, token);
  } catch {
    // The in-memory token still separates this window from the others.
  }
  return token;
}

// Shared-bucket slices, keyed so a thread draft and a sticky field diff alike.
function sharedSlices(drafts: DraftRecord, state: Record<string, unknown> | PersistedDraftsShape) {
  const slices = new Map<string, string>();
  for (const [key, draft] of Object.entries(drafts))
    slices.set(`draft:${key}`, JSON.stringify(draft));
  for (const field of ["stickyModelSelectionByProvider", "stickyActiveProvider"] as const) {
    const value = (state as Record<string, unknown>)[field];
    if (value !== undefined) slices.set(`sticky:${field}`, JSON.stringify(value));
  }
  return slices;
}

function applySlice(state: Record<string, unknown>, slice: string, json: string | undefined) {
  const [kind, key] = [slice.slice(0, slice.indexOf(":")), slice.slice(slice.indexOf(":") + 1)];
  if (kind === "sticky") {
    if (json === undefined) delete state[key];
    else state[key] = JSON.parse(json);
    return;
  }
  const drafts = { ...recordAt(state, "draftsByThreadKey") };
  if (json === undefined) delete drafts[key];
  else drafts[key] = JSON.parse(json);
  state.draftsByThreadKey = drafts;
}

/** What one adoption moved into this window, in persisted shape. */
export interface AdoptedDrafts {
  readonly state: Record<string, unknown>;
  readonly version: number | undefined;
}

export interface WindowDraftScope<S, P extends PersistedDraftsShape> {
  readonly windowKey: (name: string) => string;
  readonly getItem: (name: string) => string | null;
  readonly setItem: (name: string, value: PersistValue<S, P>) => void;
  readonly removeItem: (name: string) => void;
  /** Writes both buckets for the pending value, once. */
  readonly flush: () => void;
  /** Moves unowned draft sessions (legacy shared, orphan windows) here; resolves whether any moved. */
  readonly adopt: (
    name: string,
    afterAdopt?: (adopted: AdoptedDrafts) => unknown,
  ) => Promise<boolean>;
  /** Attachment ids a window-owned draft persisted, or null when the draft is not window-owned. */
  readonly attachmentIds: (name: string, threadKey: string) => string[] | null;
}

export function createWindowDraftScope<S, P extends PersistedDraftsShape>(
  env: WindowDraftScopeEnv,
  partialize: (state: S) => P,
): WindowDraftScope<S, P> {
  const token = readWindowToken(env.session);
  const windowKey = (name: string) => windowDraftBucketKey(name, token);
  // The shared slices as this window last read or wrote them.
  let baseline = new Map<string, string>();
  const now = env.now ?? Date.now;
  let lastName: string | null = null;
  const writeOwn = (name: string, bucket: Bucket) =>
    writeBucket(env.local, windowKey(name), { ...bucket, touchedAt: now() });

  const write = (name: string, value: PersistValue<S, P>) => {
    const persisted =
      "capturedState" in value.state ? partialize(value.state.capturedState) : value.state;
    const sessions = new Set(Object.keys(persisted.draftThreadsByThreadKey));
    writeOwn(name, {
      state: {
        draftsByThreadKey: pick(persisted.draftsByThreadKey, (key) => sessions.has(key)),
        draftThreadsByThreadKey: persisted.draftThreadsByThreadKey,
        logicalProjectDraftThreadKeyByLogicalProjectKey:
          persisted.logicalProjectDraftThreadKeyByLogicalProjectKey,
      },
      version: value.version,
    });
    const next = sharedSlices(
      pick(persisted.draftsByThreadKey, (key) => !sessions.has(key)),
      persisted,
    );
    const changed = [...new Set([...baseline.keys(), ...next.keys()])].filter(
      (slice) => baseline.get(slice) !== next.get(slice),
    );
    baseline = next;
    if (changed.length === 0) return;
    const shared = readBucket(env.local, name);
    const state: Record<string, unknown> = { ...shared?.state };
    for (const slice of changed) applySlice(state, slice, next.get(slice));
    writeBucket(env.local, name, { state, version: shared?.version ?? value.version });
  };

  const debouncer = new Debouncer(write, { wait: env.debounceMs ?? 300 });

  // Every flush, the unload one included, re-stamps this window's bucket.
  const flush = () => {
    debouncer.flush();
    const own = lastName === null ? null : readBucket(env.local, windowKey(lastName));
    if (own && lastName !== null) writeOwn(lastName, own);
  };

  // Unlocked buckets, split by whether their grace window has passed.
  const unlockedBuckets = (name: string, heldLocks: ReadonlySet<string>) => {
    const prefix = windowDraftBucketKey(name, "");
    const stale: string[] = [];
    const fresh: string[] = [];
    for (let index = 0; index < env.local.length; index += 1) {
      const key = env.local.key(index);
      if (key === null || !key.startsWith(prefix) || key === windowKey(name)) continue;
      if (heldLocks.has(windowTokenLock(key.slice(prefix.length)))) continue;
      const touchedAt = readBucket(env.local, key)?.touchedAt ?? 0;
      (now() - touchedAt >= ORPHAN_GRACE_MS ? stale : fresh).push(key);
    }
    return { stale: stale.toSorted(), fresh };
  };

  const adoptNow = (name: string, orphans: ReadonlyArray<string>): AdoptedDrafts | null => {
    flush();
    const shared = readBucket(env.local, name);
    const legacySessions = recordAt(shared?.state, "draftThreadsByThreadKey");
    const legacyMap = recordAt(shared?.state, "logicalProjectDraftThreadKeyByLogicalProjectKey");
    const hasLegacy = Object.keys(legacySessions).length > 0 || Object.keys(legacyMap).length > 0;
    if (!hasLegacy && orphans.length === 0) return null;

    const legacyKeys = new Set(Object.keys(legacySessions));
    const sharedDrafts = recordAt(shared?.state, "draftsByThreadKey");
    const own = readBucket(env.local, windowKey(name));
    const sources: Bucket[] = [];
    if (shared && hasLegacy) {
      sources.push({
        state: {
          draftsByThreadKey: pick(sharedDrafts, (key) => legacyKeys.has(key)),
          draftThreadsByThreadKey: legacySessions,
          logicalProjectDraftThreadKeyByLogicalProjectKey: legacyMap,
        },
        version: shared.version,
      });
    }
    for (const key of orphans) {
      const bucket = readBucket(env.local, key);
      if (bucket) sources.push(bucket);
    }
    // This window's entries win; sources only fill gaps.
    const drafts: Record<string, unknown> = {};
    const sessions: Record<string, unknown> = {};
    const projectMap: Record<string, unknown> = {};
    for (const source of sources) {
      Object.assign(drafts, recordAt(source.state, "draftsByThreadKey"));
      Object.assign(sessions, recordAt(source.state, "draftThreadsByThreadKey"));
      const map = recordAt(source.state, "logicalProjectDraftThreadKeyByLogicalProjectKey");
      for (const [project, session] of Object.entries(map)) {
        const current = projectMap[project];
        // Two sources map one project: the newer session keeps the mapping, first
        // source on a tie. The other session keeps its text as an unmapped draft.
        if (current === undefined || createdAt(sessions, session) > createdAt(sessions, current)) {
          projectMap[project] = session;
        }
      }
    }
    // Destination first: a failed later write leaves a copy, never a loss.
    writeOwn(name, {
      state: {
        ...own?.state,
        draftsByThreadKey: { ...drafts, ...recordAt(own?.state, "draftsByThreadKey") },
        draftThreadsByThreadKey: {
          ...sessions,
          ...recordAt(own?.state, "draftThreadsByThreadKey"),
        },
        logicalProjectDraftThreadKeyByLogicalProjectKey: {
          ...projectMap,
          ...recordAt(own?.state, "logicalProjectDraftThreadKeyByLogicalProjectKey"),
        },
      },
      version: oldestVersion(own, ...sources),
    });
    if (shared && hasLegacy) {
      writeBucket(env.local, name, {
        state: {
          ...shared.state,
          draftsByThreadKey: pick(sharedDrafts, (key) => !legacyKeys.has(key)),
          draftThreadsByThreadKey: {},
          logicalProjectDraftThreadKeyByLogicalProjectKey: {},
        },
        version: shared.version,
      });
    }
    for (const key of orphans) env.local.removeItem(key);
    return {
      state: {
        draftsByThreadKey: drafts,
        draftThreadsByThreadKey: sessions,
        logicalProjectDraftThreadKeyByLogicalProjectKey: projectMap,
      },
      version: oldestVersion(...sources),
    };
  };

  // Held for this page's lifetime; the browser releases it when the window closes.
  const tokenHeld = env.locks
    ? new Promise<void>((granted) => {
        void env.locks?.request(windowTokenLock(token), () => {
          granted();
          return new Promise<never>(() => {});
        });
      })
    : Promise.resolve();

  return {
    windowKey,
    getItem: (name) => {
      lastName = name;
      const own = readBucket(env.local, windowKey(name));
      const shared = readBucket(env.local, name);
      if (!own && !shared) return null;
      // Legacy sessions still in the shared bucket stay hidden until adopted.
      const legacyKeys = new Set(Object.keys(recordAt(shared?.state, "draftThreadsByThreadKey")));
      const durable = pick(
        recordAt(shared?.state, "draftsByThreadKey"),
        (key) => !legacyKeys.has(key),
      );
      const sharedState = shared?.state ?? {};
      baseline = sharedSlices(durable, sharedState);
      return JSON.stringify({
        state: {
          ...sharedState,
          draftsByThreadKey: { ...durable, ...recordAt(own?.state, "draftsByThreadKey") },
          draftThreadsByThreadKey: recordAt(own?.state, "draftThreadsByThreadKey"),
          logicalProjectDraftThreadKeyByLogicalProjectKey: recordAt(
            own?.state,
            "logicalProjectDraftThreadKeyByLogicalProjectKey",
          ),
        },
        version: oldestVersion(own, shared),
      });
    },
    setItem: (name, value) => {
      lastName = name;
      debouncer.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncer.cancel();
      debouncer.reset();
      env.local.removeItem(windowKey(name));
      env.local.removeItem(name);
      baseline = new Map();
    },
    flush,
    adopt: async (name, afterAdopt) => {
      const locks = env.locks;
      if (!locks) {
        const adopted = adoptNow(name, []);
        if (adopted) afterAdopt?.(adopted);
        return adopted !== null;
      }
      const adoptLocked = () =>
        locks.request(WINDOW_DRAFT_ADOPT_LOCK, async () => {
          const { held = [] } = await locks.query();
          const heldNames = new Set(held.flatMap((lock) => (lock.name ? [lock.name] : [])));
          const { stale, fresh } = unlockedBuckets(name, heldNames);
          const adopted = adoptNow(name, stale);
          if (adopted) afterAdopt?.(adopted);
          return { moved: adopted !== null, fresh };
        });
      await tokenHeld;
      const first = await adoptLocked();
      // One re-check: a fresh bucket still unlocked after the grace window was closed.
      if (first.fresh.length > 0) {
        (env.setTimer ?? setTimeout)(() => adoptLocked(), ORPHAN_GRACE_MS);
      }
      return first.moved;
    },
    attachmentIds: (name, threadKey) => {
      const own = readBucket(env.local, windowKey(name));
      const draft = recordAt(own?.state, "draftsByThreadKey")[threadKey];
      if (!isRecord(draft)) return null;
      const attachments = Array.isArray(draft.attachments) ? draft.attachments : [];
      return attachments.flatMap((attachment) =>
        isRecord(attachment) && typeof attachment.id === "string" ? [attachment.id] : [],
      );
    },
  };
}

// The live store's scope; null outside a browser window, where upstream persistence stands.
let activeScope: WindowDraftScope<never, PersistedDraftsShape> | null = null;
let activeName: string | null = null;

function browserEnv(): WindowDraftScopeEnv | null {
  try {
    if (typeof window === "undefined" || !window.localStorage || !window.sessionStorage)
      return null;
    return {
      local: window.localStorage,
      session: window.sessionStorage,
      locks: typeof navigator !== "undefined" ? navigator.locks : undefined,
    };
  } catch {
    return null;
  }
}

/** Routes the composer store's deferred storage through the per-window scope. */
export function install<S, P extends PersistedDraftsShape>(
  deferred: DeferredStorage<PersistValue<S, P>>,
  partialize: (state: S) => P,
): void {
  const env = browserEnv();
  if (!env) return;
  const scope = createWindowDraftScope(env, partialize);
  activeScope = scope as unknown as WindowDraftScope<never, PersistedDraftsShape>;
  Object.assign(deferred, {
    getItem: (name: string) => {
      activeName = name;
      return scope.getItem(name);
    },
    setItem: scope.setItem,
    removeItem: scope.removeItem,
    flush: scope.flush,
  });
}

const ADOPTED_MAPS = [
  "draftsByThreadKey",
  "draftThreadsByThreadKey",
  "logicalProjectDraftThreadKeyByLogicalProjectKey",
] as const;

type AdoptTarget<T> = {
  readonly getState: () => T;
  readonly setState: (update: (state: T) => Partial<T>) => void;
  readonly persist: {
    readonly getOptions: () => {
      readonly version?: number;
      readonly migrate?: (state: unknown, version: number) => unknown;
      readonly merge?: (persisted: unknown, current: T) => T;
    };
  };
};

/**
 * Adds adopted drafts to the live store without a rehydrate, so unsaved
 * in-memory state (a pasted image, text mid-edit) is untouched. Adopted entries
 * pass through the store's own hydrate `migrate` and `merge`; existing keys win.
 */
export function mergeAdoptedDrafts<T>(store: AdoptTarget<T>, adopted: AdoptedDrafts): void {
  const { migrate, merge, version } = store.persist.getOptions();
  if (!merge) return;
  const persisted =
    migrate && adopted.version !== version
      ? migrate(adopted.state, adopted.version ?? 0)
      : adopted.state;
  const hydrated = merge(persisted, store.getState()) as Record<string, unknown>;
  store.setState((state) => {
    const current = state as Record<string, unknown>;
    return Object.fromEntries(
      ADOPTED_MAPS.map((field) => [
        field,
        { ...recordAt(hydrated, field), ...recordAt(current, field) },
      ]),
    ) as Partial<T>;
  });
}

/** Adopts unowned draft sessions into this window at startup and on the one re-check. */
export function adoptInto<T>(store: AdoptTarget<T>): void {
  const scope = activeScope;
  const name = activeName;
  if (!scope || name === null) return;
  void scope.adopt(name, (adopted) => mergeAdoptedDrafts(store, adopted));
}

/** Whether the draft for `threadKey` lives in this window's bucket. */
export const ownsDraft = (threadKey: string): boolean =>
  activeScope !== null &&
  activeName !== null &&
  activeScope.attachmentIds(activeName, threadKey) !== null;

export const attachmentIds = (threadKey: string): string[] =>
  (activeName !== null && activeScope?.attachmentIds(activeName, threadKey)) || [];
