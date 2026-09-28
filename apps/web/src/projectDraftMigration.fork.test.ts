import { Storage } from "happy-dom";
import { describe, expect, it } from "vite-plus/test";

import {
  migrateProjectDraftBuckets,
  projectDraftDestinationKey,
} from "./projectDraftMigration.fork";

const KEY = "t3code:composer-drafts:v1";
const PROJECT_KEY = `${KEY}:project:env-1:project%20one`;

const bucket = (state: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ state, version: 9, ...extra });

const read = (storage: Storage, key: string) => JSON.parse(storage.getItem(key) ?? "null");

describe("projectDraftDestinationKey", () => {
  it.each([
    [PROJECT_KEY, KEY],
    [`${PROJECT_KEY}:window:token-1`, `${KEY}:window:token-1`],
    [KEY, null],
    [`${KEY}:window:token-1`, null],
    ["t3code:composer-drafts:window-scope", null],
  ])("%s folds into %s", (key, destination) => {
    expect(projectDraftDestinationKey(KEY, key)).toBe(destination);
  });
});

describe("migrateProjectDraftBuckets", () => {
  it("folds a project bucket into the route-free bucket without losing text", () => {
    const storage = new Storage();
    storage.setItem(
      KEY,
      bucket({
        draftsByThreadKey: { "thread:shared": { prompt: "base wins" } },
        draftThreadsByThreadKey: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
        stickyActiveProvider: "codex",
      }),
    );
    storage.setItem(
      PROJECT_KEY,
      bucket(
        {
          draftsByThreadKey: {
            "thread:shared": { prompt: "project copy" },
            "thread:project-only": { prompt: "keep me" },
            "draft:session": { prompt: "unsent" },
          },
          draftThreadsByThreadKey: { "draft:session": { projectId: "project one" } },
          logicalProjectDraftThreadKeyByLogicalProjectKey: { "project one": "draft:session" },
          stickyActiveProvider: "claude",
        },
        { version: 8 },
      ),
    );

    migrateProjectDraftBuckets(storage, KEY);

    expect(storage.getItem(PROJECT_KEY)).toBeNull();
    expect(read(storage, KEY)).toEqual({
      state: {
        draftsByThreadKey: {
          "thread:shared": { prompt: "base wins" },
          "thread:project-only": { prompt: "keep me" },
          "draft:session": { prompt: "unsent" },
        },
        draftThreadsByThreadKey: { "draft:session": { projectId: "project one" } },
        logicalProjectDraftThreadKeyByLogicalProjectKey: { "project one": "draft:session" },
        stickyActiveProvider: "codex",
      },
      version: 8,
    });
  });

  it("moves a project window bucket to the same window's route-free bucket", () => {
    const storage = new Storage();
    storage.setItem(
      `${PROJECT_KEY}:window:token-1`,
      bucket(
        {
          draftsByThreadKey: { "draft:s1": { prompt: "window text" } },
          draftThreadsByThreadKey: { "draft:s1": { projectId: "project one" } },
          logicalProjectDraftThreadKeyByLogicalProjectKey: { "project one": "draft:s1" },
        },
        { touchedAt: 42 },
      ),
    );

    migrateProjectDraftBuckets(storage, KEY);

    expect(storage.getItem(`${PROJECT_KEY}:window:token-1`)).toBeNull();
    expect(storage.getItem(KEY)).toBeNull();
    expect(read(storage, `${KEY}:window:token-1`)).toEqual({
      state: {
        draftsByThreadKey: { "draft:s1": { prompt: "window text" } },
        draftThreadsByThreadKey: { "draft:s1": { projectId: "project one" } },
        logicalProjectDraftThreadKeyByLogicalProjectKey: { "project one": "draft:s1" },
      },
      version: 9,
      touchedAt: 42,
    });
  });

  it("merges two projects' buckets into one without dropping either", () => {
    const storage = new Storage();
    storage.setItem(
      `${KEY}:project:env-1:a`,
      bucket({ draftsByThreadKey: { "thread:a": { prompt: "a" } } }),
    );
    storage.setItem(
      `${KEY}:project:env-2:b`,
      bucket({ draftsByThreadKey: { "thread:b": { prompt: "b" } } }),
    );

    migrateProjectDraftBuckets(storage, KEY);

    expect(read(storage, KEY).state.draftsByThreadKey).toEqual({
      "thread:a": { prompt: "a" },
      "thread:b": { prompt: "b" },
    });
    expect(storage.length).toBe(1);
  });

  it("leaves an unreadable project bucket in place", () => {
    const storage = new Storage();
    storage.setItem(PROJECT_KEY, "{not json");

    migrateProjectDraftBuckets(storage, KEY);

    expect(storage.getItem(PROJECT_KEY)).toBe("{not json");
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("keeps the source when the destination write fails", () => {
    const storage = new Storage();
    storage.setItem(PROJECT_KEY, bucket({ draftsByThreadKey: { "thread:a": { prompt: "a" } } }));
    const failing = {
      get length() {
        return storage.length;
      },
      key: (index: number) => storage.key(index),
      getItem: (key: string) => storage.getItem(key),
      removeItem: (key: string) => storage.removeItem(key),
      setItem: () => {
        throw new Error("quota");
      },
    };

    migrateProjectDraftBuckets(failing, KEY);

    expect(read(storage, PROJECT_KEY).state.draftsByThreadKey).toEqual({
      "thread:a": { prompt: "a" },
    });
  });
});
