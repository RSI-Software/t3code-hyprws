import { Storage } from "happy-dom";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { COMPOSER_DRAFT_STORAGE_KEY } from "./composerDraftStore";
import {
  createWindowDraftScope,
  mergeAdoptedDrafts,
  type LockManagerLike,
  type PersistedDraftsShape,
  WINDOW_DRAFT_RESTORE_GRACE_MS,
  WINDOW_DRAFT_TOKEN_KEY,
} from "./windowDraftScope.fork";

const KEY = COMPOSER_DRAFT_STORAGE_KEY;
const VERSION = 9;

interface Persisted extends PersistedDraftsShape {
  readonly draftsByThreadKey: Record<string, { prompt: string; attachments?: { id: string }[] }>;
  readonly draftThreadsByThreadKey: Record<string, { projectId: string }>;
  readonly logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
}

const persisted = (overrides: Partial<Persisted> = {}): Persisted => ({
  draftsByThreadKey: {},
  draftThreadsByThreadKey: {},
  logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  ...overrides,
});

interface FakeLocks extends LockManagerLike {
  /** Releases every lock a closed window held. */
  readonly close: (session: Storage) => void;
  /** Releases a desktop window's WindowId lock, as quit destroying it does. */
  readonly destroy: (windowId: string) => void;
}

// Exclusive and FIFO per name, with `query()` reporting held names: the Web Locks
// semantics the scope relies on. `close` ends a window's page, which releases
// its never-settling token lock the way a browser does.
function createLocks(): FakeLocks {
  const tails = new Map<string, Promise<unknown>>();
  const held = new Set<string>();
  const releases = new Map<string, () => void>();
  return {
    request: (name, callback) => {
      const released = new Promise<void>((release) => releases.set(name, release));
      const run = (tails.get(name) ?? Promise.resolve()).then(async () => {
        held.add(name);
        try {
          return await Promise.race([callback(), released as Promise<never>]);
        } finally {
          held.delete(name);
        }
      });
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
    query: async () => ({ held: [...held].map((name) => ({ name })) }),
    close: (session) => {
      releases.get(`t3code:composer-drafts:window:${session.getItem(WINDOW_DRAFT_TOKEN_KEY)}`)?.();
    },
    destroy: (windowId) => releases.get(`t3code:composer-drafts:window:${windowId}`)?.(),
  };
}

// A controlled clock: `advance` moves time and fires due timers, awaiting each.
function createClock() {
  let time = 1_000_000;
  const timers: { at: number; callback: () => unknown }[] = [];
  return {
    now: () => time,
    setTimer: (callback: () => unknown, ms: number) => {
      timers.push({ at: time + ms, callback });
    },
    advance: async (ms: number) => {
      time += ms;
      for (const timer of timers.filter((entry) => entry.at <= time)) {
        timers.splice(timers.indexOf(timer), 1);
        await timer.callback();
      }
    },
    pending: () => timers.length,
  };
}

let clock = createClock();

function openWindow(local: Storage, session = new Storage(), locks: FakeLocks = createLocks()) {
  const scope = createWindowDraftScope<Persisted, Persisted>(
    { local, session, locks, now: clock.now, setTimer: clock.setTimer },
    (state) => state,
  );
  return { scope, session, locks };
}

// A desktop window: a fresh page (empty sessionStorage) carrying its WindowId.
function openDesktopWindow(local: Storage, windowId: string, locks: FakeLocks) {
  const scope = createWindowDraftScope<Persisted, Persisted>(
    { local, session: new Storage(), locks, windowId, now: clock.now, setTimer: clock.setTimer },
    (state) => state,
  );
  return { scope, session: new Storage(), locks };
}

const hydrate = (window: ReturnType<typeof openWindow>) =>
  JSON.parse(window.scope.getItem(KEY) ?? "null") as { state: Persisted } | null;

const save = (window: ReturnType<typeof openWindow>, state: Persisted) =>
  window.scope.setItem(KEY, { state: { capturedState: state }, version: VERSION });

const readShared = (local: Storage) => JSON.parse(local.getItem(KEY) ?? "null").state as Persisted;

const legacyShared = () =>
  JSON.stringify({
    state: persisted({
      draftsByThreadKey: {
        "draft:s1": { prompt: "unsent text" },
        "thread:t1": { prompt: "durable" },
      },
      draftThreadsByThreadKey: { "draft:s1": { projectId: "p1" } },
      logicalProjectDraftThreadKeyByLogicalProjectKey: { p1: "draft:s1" },
    }),
    version: VERSION,
  });

describe("window draft scope", () => {
  beforeEach(() => {
    clock = createClock();
  });

  it("gives each window its own token that survives a reload", () => {
    const local = new Storage();
    const first = openWindow(local);
    const other = openWindow(local);
    const reloaded = openWindow(local, first.session);
    expect(reloaded.scope.windowKey(KEY)).toBe(first.scope.windowKey(KEY));
    expect(other.scope.windowKey(KEY)).not.toBe(first.scope.windowKey(KEY));
    expect(first.session.getItem(WINDOW_DRAFT_TOKEN_KEY)).toBeTruthy();
  });

  it("lets exactly one of two simultaneously upgraded windows adopt legacy drafts", async () => {
    const local = new Storage();
    local.setItem(KEY, legacyShared());
    const locks = createLocks();
    const a = openWindow(local, new Storage(), locks);
    const b = openWindow(local, new Storage(), locks);
    // First load never shows legacy sessions, so neither window claims them unlocked.
    expect(hydrate(a)?.state.draftThreadsByThreadKey).toEqual({});
    expect(hydrate(b)?.state.draftThreadsByThreadKey).toEqual({});

    const results = await Promise.all([a.scope.adopt(KEY), b.scope.adopt(KEY)]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const winner = results[0] ? a : b;
    const loser = results[0] ? b : a;
    expect(hydrate(winner)?.state.draftsByThreadKey["draft:s1"]).toEqual({ prompt: "unsent text" });
    expect(hydrate(loser)?.state.draftsByThreadKey["draft:s1"]).toBeUndefined();
    const shared = readShared(local);
    expect(shared.draftThreadsByThreadKey).toEqual({});
    expect(shared.draftsByThreadKey).toEqual({ "thread:t1": { prompt: "durable" } });
  });

  it("writes the adoption destination before clearing the source", async () => {
    const storage = new Storage();
    storage.setItem(KEY, legacyShared());
    const writes: string[] = [];
    const local = {
      getItem: (key: string) => storage.getItem(key),
      removeItem: (key: string) => storage.removeItem(key),
      key: (index: number) => storage.key(index),
      get length() {
        return storage.length;
      },
      setItem: (key: string, value: string) => {
        writes.push(key);
        storage.setItem(key, value);
      },
    };
    const scope = createWindowDraftScope<Persisted, Persisted>(
      { local, session: new Storage(), locks: createLocks() },
      (state) => state,
    );
    scope.getItem(KEY);
    await scope.adopt(KEY);
    expect(writes).toEqual([scope.windowKey(KEY), KEY]);
  });

  it("keeps a pending edit and the adopted drafts when adoption runs mid-debounce", async () => {
    const local = new Storage();
    local.setItem(KEY, legacyShared());
    const window = openWindow(local);
    hydrate(window);
    save(
      window,
      persisted({
        draftsByThreadKey: { "draft:s2": { prompt: "typed before adopt" } },
        draftThreadsByThreadKey: { "draft:s2": { projectId: "p2" } },
      }),
    );
    await window.scope.adopt(KEY);
    window.scope.flush();
    const state = hydrate(window)?.state;
    expect(state?.draftsByThreadKey["draft:s1"]).toEqual({ prompt: "unsent text" });
    expect(state?.draftsByThreadKey["draft:s2"]).toEqual({ prompt: "typed before adopt" });
  });

  it("restores adopted drafts after a reload and never re-adopts them", async () => {
    const local = new Storage();
    local.setItem(KEY, legacyShared());
    const window = openWindow(local);
    hydrate(window);
    await window.scope.adopt(KEY);

    const reloaded = openWindow(local, window.session);
    const state = hydrate(reloaded)?.state;
    expect(state?.draftsByThreadKey["draft:s1"]).toEqual({ prompt: "unsent text" });
    expect(state?.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual({ p1: "draft:s1" });
    expect(await reloaded.scope.adopt(KEY)).toBe(false);
  });

  it("does not resurrect a durable draft another window cleared", () => {
    const local = new Storage();
    local.setItem(
      KEY,
      JSON.stringify({
        state: persisted({ draftsByThreadKey: { "thread:t1": { prompt: "old" } } }),
        version: VERSION,
      }),
    );
    const a = openWindow(local);
    const b = openWindow(local);
    hydrate(a);
    const stale = hydrate(b)!.state;

    save(a, persisted());
    a.scope.flush();
    expect(readShared(local).draftsByThreadKey["thread:t1"]).toBeUndefined();

    save(b, {
      ...stale,
      draftsByThreadKey: { ...stale.draftsByThreadKey, "thread:t2": { prompt: "new" } },
    });
    b.scope.flush();
    expect(readShared(local).draftsByThreadKey).toEqual({ "thread:t2": { prompt: "new" } });
  });

  it("merges interleaved durable edits from two windows", () => {
    const local = new Storage();
    const a = openWindow(local);
    const b = openWindow(local);
    hydrate(a);
    hydrate(b);
    save(a, persisted({ draftsByThreadKey: { "thread:t1": { prompt: "a1" } } }));
    save(b, persisted({ draftsByThreadKey: { "thread:t2": { prompt: "b1" } } }));
    a.scope.flush();
    b.scope.flush();
    save(a, persisted({ draftsByThreadKey: { "thread:t1": { prompt: "a2" } } }));
    a.scope.flush();
    expect(readShared(local).draftsByThreadKey).toEqual({
      "thread:t1": { prompt: "a2" },
      "thread:t2": { prompt: "b1" },
    });
  });

  it("keeps unsent drafts per window", () => {
    const local = new Storage();
    const a = openWindow(local);
    const b = openWindow(local);
    hydrate(a);
    hydrate(b);
    save(
      a,
      persisted({
        draftsByThreadKey: { "draft:sa": { prompt: "only in a" } },
        draftThreadsByThreadKey: { "draft:sa": { projectId: "p1" } },
      }),
    );
    a.scope.flush();
    expect(hydrate(b)).toBeNull();
    expect(local.getItem(KEY)).toBeNull();
  });

  it("writes both buckets with one unload flush and nothing before it", () => {
    const local = new Storage();
    const window = openWindow(local);
    hydrate(window);
    save(
      window,
      persisted({
        draftsByThreadKey: {
          "draft:s2": { prompt: "unsent", attachments: [{ id: "img-1" }] },
          "thread:t3": { prompt: "durable" },
        },
        draftThreadsByThreadKey: { "draft:s2": { projectId: "p2" } },
      }),
    );
    expect(local.getItem(window.scope.windowKey(KEY))).toBeNull();
    expect(local.getItem(KEY)).toBeNull();

    window.scope.flush();
    expect(window.scope.attachmentIds(KEY, "draft:s2")).toEqual(["img-1"]);
    expect(window.scope.attachmentIds(KEY, "thread:t3")).toBeNull();
    expect(readShared(local).draftsByThreadKey).toEqual({ "thread:t3": { prompt: "durable" } });
  });

  const unsentSession = (window: ReturnType<typeof openWindow>, id: string, createdAt: string) =>
    save(
      window,
      persisted({
        draftsByThreadKey: { [id]: { prompt: `text of ${id}` } },
        draftThreadsByThreadKey: { [id]: { projectId: "p1", createdAt } as { projectId: string } },
        logicalProjectDraftThreadKeyByLogicalProjectKey: { p1: id },
      }),
    );

  it("recovers a closed window's unsent draft in the next window and removes its bucket", async () => {
    const local = new Storage();
    const locks = createLocks();
    const closed = openWindow(local, new Storage(), locks);
    hydrate(closed);
    await closed.scope.adopt(KEY);
    unsentSession(closed, "draft:c1", "2026-01-01T00:00:00Z");
    closed.scope.flush();
    locks.close(closed.session);
    await clock.advance(5_000);

    const reopened = openWindow(local, new Storage(), locks);
    hydrate(reopened);
    expect(await reopened.scope.adopt(KEY)).toBe(true);
    expect(hydrate(reopened)?.state.draftsByThreadKey["draft:c1"]).toEqual({
      prompt: "text of draft:c1",
    });
    expect(local.getItem(closed.scope.windowKey(KEY))).toBeNull();
  });

  it("adopts every orphan bucket after a relaunch; the newer session keeps the project", async () => {
    const local = new Storage();
    const previousRun = createLocks();
    const older = openWindow(local, new Storage(), previousRun);
    const newer = openWindow(local, new Storage(), previousRun);
    unsentSession(older, "draft:o1", "2026-01-01T00:00:00Z");
    unsentSession(newer, "draft:o2", "2026-02-01T00:00:00Z");
    older.scope.flush();
    newer.scope.flush();
    await clock.advance(5_000);

    const fresh = openWindow(local, new Storage(), createLocks());
    hydrate(fresh);
    expect(await fresh.scope.adopt(KEY)).toBe(true);
    const state = hydrate(fresh)?.state;
    expect(Object.keys(state?.draftsByThreadKey ?? {}).toSorted()).toEqual([
      "draft:o1",
      "draft:o2",
    ]);
    expect(state?.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual({ p1: "draft:o2" });
    expect(local.getItem(older.scope.windowKey(KEY))).toBeNull();
    expect(local.getItem(newer.scope.windowKey(KEY))).toBeNull();
  });

  it("never adopts a live window's bucket", async () => {
    const local = new Storage();
    const locks = createLocks();
    const live = openWindow(local, new Storage(), locks);
    hydrate(live);
    await live.scope.adopt(KEY);
    unsentSession(live, "draft:l1", "2026-01-01T00:00:00Z");
    live.scope.flush();

    const other = openWindow(local, new Storage(), locks);
    hydrate(other);
    expect(await other.scope.adopt(KEY)).toBe(false);
    expect(hydrate(live)?.state.draftsByThreadKey["draft:l1"]).toBeDefined();
    expect(local.getItem(other.scope.windowKey(KEY))).toBeNull();
  });

  it("does not adopt a window reloading inside the grace window", async () => {
    const local = new Storage();
    const locks = createLocks();
    const reloading = openWindow(local, new Storage(), locks);
    hydrate(reloading);
    unsentSession(reloading, "draft:r1", "2026-01-01T00:00:00Z");
    reloading.scope.flush();
    locks.close(reloading.session);

    await clock.advance(100);
    const other = openWindow(local, new Storage(), locks);
    hydrate(other);
    expect(await other.scope.adopt(KEY)).toBe(false);

    const back = openWindow(local, reloading.session, locks);
    hydrate(back);
    await back.scope.adopt(KEY);
    await clock.advance(5_000);
    expect(hydrate(back)?.state.draftsByThreadKey["draft:r1"]).toBeDefined();
    expect(local.getItem(other.scope.windowKey(KEY))).toBeNull();
  });

  it("adopts a fresh bucket on the re-check once its window stays closed", async () => {
    const local = new Storage();
    const locks = createLocks();
    const closing = openWindow(local, new Storage(), locks);
    hydrate(closing);
    unsentSession(closing, "draft:f1", "2026-01-01T00:00:00Z");
    closing.scope.flush();
    locks.close(closing.session);

    await clock.advance(100);
    const survivor = openWindow(local, new Storage(), locks);
    hydrate(survivor);
    expect(await survivor.scope.adopt(KEY)).toBe(false);
    expect(clock.pending()).toBe(1);

    await clock.advance(5_000);
    expect(hydrate(survivor)?.state.draftsByThreadKey["draft:f1"]).toEqual({
      prompt: "text of draft:f1",
    });
    expect(local.getItem(closing.scope.windowKey(KEY))).toBeNull();
  });

  it("merges adopted drafts into the live store and keeps unsaved in-memory state", async () => {
    interface LiveDraft {
      prompt: string;
      images?: string[];
      hydrated?: boolean;
    }
    interface LiveState {
      draftsByThreadKey: Record<string, LiveDraft>;
      draftThreadsByThreadKey: Record<string, unknown>;
      logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
    }
    const local = new Storage();
    local.setItem(KEY, legacyShared());
    const window = openWindow(local);
    // A real zustand persist store whose hydrate `merge` marks converted drafts.
    const store = create<LiveState>()(
      persist<LiveState>(
        (): LiveState => ({
          draftsByThreadKey: { "draft:mine": { prompt: "typing", images: ["pasted-blob"] } },
          draftThreadsByThreadKey: { "draft:mine": { projectId: "p1" } },
          logicalProjectDraftThreadKeyByLogicalProjectKey: { p1: "draft:mine" },
        }),
        {
          name: "test-store",
          version: VERSION,
          storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
          merge: (persistedState, current) => {
            const state = persistedState as LiveState;
            return {
              ...current,
              ...state,
              draftsByThreadKey: Object.fromEntries(
                Object.entries(state.draftsByThreadKey).map(([key, draft]) => [
                  key,
                  { ...draft, hydrated: true },
                ]),
              ),
            };
          },
        },
      ),
    );
    hydrate(window);
    await window.scope.adopt(KEY, (adopted) => mergeAdoptedDrafts(store, adopted));

    const state = store.getState();
    expect(state.draftsByThreadKey["draft:s1"]).toEqual({ prompt: "unsent text", hydrated: true });
    expect(state.draftThreadsByThreadKey["draft:s1"]).toEqual({ projectId: "p1" });
    expect(state.draftsByThreadKey["draft:mine"]).toEqual({
      prompt: "typing",
      images: ["pasted-blob"],
    });
    expect(state.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual({ p1: "draft:mine" });
  });
});

describe("window draft scope across an update-relaunch restore", () => {
  beforeEach(() => {
    clock = createClock();
  });

  const WINDOWS = ["w0", "w1", "w2"] as const;

  // Three desktop windows each hold one unsent draft, then quit destroys them unflushed.
  async function previousRun(local: Storage) {
    const run = createLocks();
    for (const windowId of WINDOWS) {
      const window = openDesktopWindow(local, windowId, run);
      hydrate(window);
      save(
        window,
        persisted({
          draftsByThreadKey: { [`draft:${windowId}`]: { prompt: `typed in ${windowId}` } },
          draftThreadsByThreadKey: { [`draft:${windowId}`]: { projectId: "p1" } },
          logicalProjectDraftThreadKeyByLogicalProjectKey: { p1: `draft:${windowId}` },
        }),
      );
      window.scope.flush();
      run.destroy(windowId);
    }
    await clock.advance(10 * 60 * 1_000);
  }

  it("reopens each restored window on its own draft, even when a peer adopts first", async () => {
    const local = new Storage();
    await previousRun(local);

    const relaunch = createLocks();
    const restored = new Map<string, ReturnType<typeof openDesktopWindow>>();
    for (const windowId of WINDOWS) {
      const window = openDesktopWindow(local, windowId, relaunch);
      restored.set(windowId, window);
      expect(hydrate(window)?.state.draftsByThreadKey).toEqual({
        [`draft:${windowId}`]: { prompt: `typed in ${windowId}` },
      });
      // Peers not yet loaded hold no lock; adoption must still leave their drafts.
      expect(await window.scope.adopt(KEY)).toBe(false);
    }
    await clock.advance(WINDOW_DRAFT_RESTORE_GRACE_MS);
    for (const [windowId, window] of restored) {
      expect(Object.keys(hydrate(window)?.state.draftThreadsByThreadKey ?? {})).toEqual([
        `draft:${windowId}`,
      ]);
    }
  });

  it("resolves a restored `/draft/<id>` route to that draft session", async () => {
    const local = new Storage();
    await previousRun(local);
    // The window whose manifest route is `/draft/draft:w1` loads last.
    const relaunch = createLocks();
    const first = openDesktopWindow(local, "w0", relaunch);
    hydrate(first);
    await first.scope.adopt(KEY);

    const routed = openDesktopWindow(local, "w1", relaunch);
    // `getDraftSession(draftId)` reads `draftThreadsByThreadKey[draftId]` at hydration.
    const state = hydrate(routed)?.state;
    expect(state?.draftThreadsByThreadKey["draft:w1"]).toEqual({ projectId: "p1" });
    expect(state?.draftsByThreadKey["draft:w1"]).toEqual({ prompt: "typed in w1" });
  });

  it("adopts a desktop window's draft once it stays closed past the restore grace", async () => {
    const local = new Storage();
    await previousRun(local);

    const fresh = openDesktopWindow(local, "w-new", createLocks());
    hydrate(fresh);
    expect(await fresh.scope.adopt(KEY)).toBe(false);
    await clock.advance(WINDOW_DRAFT_RESTORE_GRACE_MS);
    expect(Object.keys(hydrate(fresh)?.state.draftThreadsByThreadKey ?? {}).toSorted()).toEqual([
      "draft:w0",
      "draft:w1",
      "draft:w2",
    ]);
  });
});
