import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  BROWSER_BOOKMARK_STORAGE_KEY,
  migratePersistedBrowserBookmarkState,
  resetBrowserBookmarksForTests,
  useBrowserBookmarkStore,
} from "./browserBookmarkStore";

afterEach(() => resetBrowserBookmarksForTests());

describe("browserBookmarkStore", () => {
  it("moves a bookmark between project and global scope without duplicating it", () => {
    const store = useBrowserBookmarkStore.getState();
    store.setBookmarkScope({
      projectKey: "project-a",
      scope: "project",
      url: "example.com/docs",
      title: "Docs",
      createdAt: 1,
    });
    store.setBookmarkScope({
      projectKey: "project-a",
      scope: "global",
      url: "https://example.com/docs",
      createdAt: 2,
    });

    expect(useBrowserBookmarkStore.getState()).toMatchObject({
      global: [{ url: "https://example.com/docs", title: "Docs", createdAt: 2 }],
      byProjectKey: {},
    });
  });

  it("removes project copies everywhere when a bookmark becomes global", () => {
    useBrowserBookmarkStore.setState({
      global: [],
      byProjectKey: {
        "project-a": [{ url: "https://example.com/", createdAt: 1 }],
        "project-b": [{ url: "https://example.com/", createdAt: 2 }],
      },
    });

    useBrowserBookmarkStore.getState().setBookmarkScope({
      projectKey: "project-a",
      scope: "global",
      url: "example.com",
      createdAt: 3,
    });

    expect(useBrowserBookmarkStore.getState()).toMatchObject({
      global: [{ url: "https://example.com/", createdAt: 3 }],
      byProjectKey: {},
    });
  });

  it("keeps project bookmarks isolated while sharing global bookmarks", () => {
    const store = useBrowserBookmarkStore.getState();
    store.setBookmarkScope({
      projectKey: "project-a",
      scope: "project",
      url: "https://project.test/",
      createdAt: 1,
    });
    store.setBookmarkScope({
      projectKey: "project-b",
      scope: "global",
      url: "https://global.test/",
      createdAt: 2,
    });

    const state = useBrowserBookmarkStore.getState();
    expect(state.byProjectKey["project-a"]?.map((entry) => entry.url)).toEqual([
      "https://project.test/",
    ]);
    expect(state.byProjectKey["project-b"]).toBeUndefined();
    expect(state.global.map((entry) => entry.url)).toEqual(["https://global.test/"]);
  });

  it("persists project and global collections for the next app session", async () => {
    const store = useBrowserBookmarkStore.getState();
    store.setBookmarkScope({
      projectKey: "project-a",
      scope: "project",
      url: "https://project.test/",
      createdAt: 1,
    });
    store.setBookmarkScope({
      projectKey: "project-a",
      scope: "global",
      url: "https://global.test/",
      createdAt: 2,
    });

    const storage = useBrowserBookmarkStore.persist.getOptions().storage;
    if (!storage) throw new Error("Browser bookmark persistence storage is unavailable.");

    expect(await storage.getItem(BROWSER_BOOKMARK_STORAGE_KEY)).toMatchObject({
      state: {
        global: [{ url: "https://global.test/", createdAt: 2 }],
        byProjectKey: {
          "project-a": [{ url: "https://project.test/", createdAt: 1 }],
        },
      },
      version: 1,
    });
  });

  it("removes the active project's copy and the global copy together", () => {
    useBrowserBookmarkStore.setState({
      global: [{ url: "https://example.com/", createdAt: 1 }],
      byProjectKey: {
        "project-a": [{ url: "https://example.com/", createdAt: 2 }],
        "project-b": [{ url: "https://example.com/", createdAt: 3 }],
      },
    });

    useBrowserBookmarkStore.getState().removeBookmark("project-a", "example.com");

    expect(useBrowserBookmarkStore.getState()).toMatchObject({
      global: [],
      byProjectKey: {
        "project-b": [{ url: "https://example.com/", createdAt: 3 }],
      },
    });
  });

  it("migrates only valid normalized bookmarks and deduplicates URLs", () => {
    expect(
      migratePersistedBrowserBookmarkState({
        global: [
          { url: "example.com", title: " First ", createdAt: 1 },
          { url: "https://example.com/", title: "Newer", createdAt: 2 },
          { url: "not a url", createdAt: 3 },
          { url: "https://bad-date.test", createdAt: Number.POSITIVE_INFINITY },
        ],
        byProjectKey: {
          valid: [
            { url: "https://project.test", createdAt: 4 },
            { url: "https://example.com", createdAt: 5 },
          ],
          empty: [{ url: "http://[", createdAt: 5 }],
        },
      }),
    ).toEqual({
      global: [{ url: "https://example.com/", title: "Newer", createdAt: 2 }],
      byProjectKey: {
        valid: [{ url: "https://project.test/", createdAt: 4 }],
      },
    });
  });
});
