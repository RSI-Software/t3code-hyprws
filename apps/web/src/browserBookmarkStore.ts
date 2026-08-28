import { useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

import {
  BROWSER_HISTORY_MAX_TITLE_LENGTH,
  isValidHistoryTimestamp,
  normalizeHistoryUrl,
} from "~/browserHistoryStore";
import { resolveStorage } from "~/lib/storage";

export type BrowserBookmarkScope = "project" | "global";
export type BrowserBookmarkEntry = {
  url: string;
  createdAt: number;
  title?: string;
};

export const BROWSER_BOOKMARK_MAX_ENTRIES_PER_SCOPE = 50;
export const BROWSER_BOOKMARK_MAX_PROJECTS = 20;
export const BROWSER_BOOKMARK_STORAGE_KEY = "t3code:browser-bookmarks:v1";

const EMPTY_BOOKMARKS: ReadonlyArray<BrowserBookmarkEntry> = [];

interface BrowserBookmarkStoreState {
  global: BrowserBookmarkEntry[];
  byProjectKey: Record<string, BrowserBookmarkEntry[]>;
  setBookmarkScope: (input: {
    projectKey: string | null;
    scope: BrowserBookmarkScope;
    url: string;
    title?: string | undefined;
    createdAt?: number | undefined;
  }) => void;
  removeBookmark: (projectKey: string | null, url: string) => void;
}

function bookmarkIndex(
  entries: ReadonlyArray<BrowserBookmarkEntry>,
  normalizedUrl: string,
): number {
  return entries.findIndex((entry) => entry.url === normalizedUrl);
}

function withoutBookmark(
  entries: ReadonlyArray<BrowserBookmarkEntry>,
  normalizedUrl: string,
): BrowserBookmarkEntry[] {
  return entries.filter((entry) => entry.url !== normalizedUrl);
}

function prependBookmark(
  entries: ReadonlyArray<BrowserBookmarkEntry>,
  entry: BrowserBookmarkEntry,
): BrowserBookmarkEntry[] {
  return [entry, ...withoutBookmark(entries, entry.url)].slice(
    0,
    BROWSER_BOOKMARK_MAX_ENTRIES_PER_SCOPE,
  );
}

function evictExcessBookmarkProjects(
  byProjectKey: Record<string, BrowserBookmarkEntry[]>,
): Record<string, BrowserBookmarkEntry[]> {
  const projectKeys = Object.keys(byProjectKey);
  if (projectKeys.length <= BROWSER_BOOKMARK_MAX_PROJECTS) return byProjectKey;
  const kept = projectKeys
    .toSorted(
      (left, right) =>
        (byProjectKey[right]?.[0]?.createdAt ?? 0) - (byProjectKey[left]?.[0]?.createdAt ?? 0),
    )
    .slice(0, BROWSER_BOOKMARK_MAX_PROJECTS);
  return Object.fromEntries(kept.map((projectKey) => [projectKey, byProjectKey[projectKey] ?? []]));
}

function migrateBookmarkEntries(raw: unknown): BrowserBookmarkEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw
    .flatMap<BrowserBookmarkEntry>((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const { url, title, createdAt } = candidate as Record<string, unknown>;
      if (typeof url !== "string" || !isValidHistoryTimestamp(createdAt)) return [];
      const normalizedUrl = normalizeHistoryUrl(url);
      if (!normalizedUrl) return [];
      const trimmedTitle = typeof title === "string" ? title.trim() : "";
      return [
        {
          url: normalizedUrl,
          createdAt,
          ...(trimmedTitle.length > 0
            ? { title: trimmedTitle.slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH) }
            : {}),
        },
      ];
    })
    .toSorted((left, right) => right.createdAt - left.createdAt)
    .filter((entry) => {
      if (seen.has(entry.url)) return false;
      seen.add(entry.url);
      return true;
    })
    .slice(0, BROWSER_BOOKMARK_MAX_ENTRIES_PER_SCOPE);
}

export function migratePersistedBrowserBookmarkState(persistedState: unknown): {
  global: BrowserBookmarkEntry[];
  byProjectKey: Record<string, BrowserBookmarkEntry[]>;
} {
  if (!persistedState || typeof persistedState !== "object") {
    return { global: [], byProjectKey: {} };
  }
  const state = persistedState as { global?: unknown; byProjectKey?: unknown };
  const byProjectKey: Record<string, BrowserBookmarkEntry[]> = {};
  if (
    state.byProjectKey &&
    typeof state.byProjectKey === "object" &&
    !Array.isArray(state.byProjectKey)
  ) {
    for (const [projectKey, rawEntries] of Object.entries(
      state.byProjectKey as Record<string, unknown>,
    )) {
      if (projectKey.length === 0) continue;
      const entries = migrateBookmarkEntries(rawEntries);
      if (entries.length > 0) byProjectKey[projectKey] = entries;
    }
  }
  const global = migrateBookmarkEntries(state.global);
  const globalUrls = new Set(global.map((entry) => entry.url));
  for (const [projectKey, entries] of Object.entries(byProjectKey)) {
    const projectOnlyEntries = entries.filter((entry) => !globalUrls.has(entry.url));
    if (projectOnlyEntries.length > 0) byProjectKey[projectKey] = projectOnlyEntries;
    else delete byProjectKey[projectKey];
  }
  return {
    global,
    byProjectKey: evictExcessBookmarkProjects(byProjectKey),
  };
}

export const useBrowserBookmarkStore = create<BrowserBookmarkStoreState>()(
  persist(
    (set) => ({
      global: [],
      byProjectKey: {},
      setBookmarkScope: ({ projectKey, scope, url, title, createdAt = Date.now() }) => {
        const normalizedUrl = normalizeHistoryUrl(url);
        if (!normalizedUrl || (scope === "project" && !projectKey)) return;
        set((state) => {
          const projectEntries = projectKey ? (state.byProjectKey[projectKey] ?? []) : [];
          const existing =
            projectEntries[bookmarkIndex(projectEntries, normalizedUrl)] ??
            state.global[bookmarkIndex(state.global, normalizedUrl)];
          const trimmedTitle = title?.trim().slice(0, BROWSER_HISTORY_MAX_TITLE_LENGTH);
          const entry: BrowserBookmarkEntry = {
            url: normalizedUrl,
            createdAt,
            ...(trimmedTitle
              ? { title: trimmedTitle }
              : existing?.title
                ? { title: existing.title }
                : {}),
          };
          const byProjectKey = { ...state.byProjectKey };
          if (scope === "global") {
            for (const [candidateProjectKey, candidateEntries] of Object.entries(byProjectKey)) {
              const remaining = withoutBookmark(candidateEntries, normalizedUrl);
              if (remaining.length > 0) byProjectKey[candidateProjectKey] = remaining;
              else delete byProjectKey[candidateProjectKey];
            }
          } else if (projectKey) {
            const remainingProjectEntries = withoutBookmark(projectEntries, normalizedUrl);
            if (remainingProjectEntries.length > 0)
              byProjectKey[projectKey] = remainingProjectEntries;
            else delete byProjectKey[projectKey];
          }
          if (scope === "project" && projectKey) {
            byProjectKey[projectKey] = prependBookmark(byProjectKey[projectKey] ?? [], entry);
          }
          return {
            global:
              scope === "global"
                ? prependBookmark(state.global, entry)
                : withoutBookmark(state.global, normalizedUrl),
            byProjectKey: evictExcessBookmarkProjects(byProjectKey),
          };
        });
      },
      removeBookmark: (projectKey, url) => {
        const normalizedUrl = normalizeHistoryUrl(url);
        if (!normalizedUrl) return;
        set((state) => {
          const byProjectKey = { ...state.byProjectKey };
          if (projectKey) {
            const remaining = withoutBookmark(byProjectKey[projectKey] ?? [], normalizedUrl);
            if (remaining.length > 0) byProjectKey[projectKey] = remaining;
            else delete byProjectKey[projectKey];
          }
          return {
            global: withoutBookmark(state.global, normalizedUrl),
            byProjectKey,
          };
        });
      },
    }),
    {
      name: BROWSER_BOOKMARK_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ global: state.global, byProjectKey: state.byProjectKey }),
      migrate: migratePersistedBrowserBookmarkState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...migratePersistedBrowserBookmarkState(persistedState),
      }),
    },
  ),
);

export function useBrowserBookmarks(
  projectKey: string | null,
  currentUrl: string,
): {
  projectBookmarks: ReadonlyArray<BrowserBookmarkEntry>;
  globalBookmarks: ReadonlyArray<BrowserBookmarkEntry>;
  bookmarkScope: BrowserBookmarkScope | null;
} {
  const normalizedUrl = normalizeHistoryUrl(currentUrl);
  return useBrowserBookmarkStore(
    useShallow((state) => {
      const projectBookmarks = projectKey
        ? (state.byProjectKey[projectKey] ?? EMPTY_BOOKMARKS)
        : EMPTY_BOOKMARKS;
      const bookmarkScope = normalizedUrl
        ? bookmarkIndex(projectBookmarks, normalizedUrl) !== -1
          ? "project"
          : bookmarkIndex(state.global, normalizedUrl) !== -1
            ? "global"
            : null
        : null;
      return {
        projectBookmarks,
        globalBookmarks: state.global,
        bookmarkScope,
      };
    }),
  );
}

export function useBrowserBookmarkStorageSync(): void {
  useEffect(() => {
    const syncFromOtherWindow = (event: StorageEvent) => {
      if (event.key !== BROWSER_BOOKMARK_STORAGE_KEY) return;
      void useBrowserBookmarkStore.persist.rehydrate();
    };
    window.addEventListener("storage", syncFromOtherWindow);
    return () => window.removeEventListener("storage", syncFromOtherWindow);
  }, []);
}

export function resetBrowserBookmarksForTests(): void {
  useBrowserBookmarkStore.setState({ global: [], byProjectKey: {} });
  useBrowserBookmarkStore.persist.clearStorage();
}
