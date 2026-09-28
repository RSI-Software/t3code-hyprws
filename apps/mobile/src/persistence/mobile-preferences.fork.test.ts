import { describe, expect, it } from "@effect/vitest";
import type { ProjectFilter } from "@t3tools/client-runtime/state/project-filter";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

// SQLite is unavailable, so preferences land in the device's secure storage.
const secureItems = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: () => Promise.reject(new Error("SQLite unavailable")),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => secureItems.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void secureItems.set(key, value),
  deleteItemAsync: async (key: string) => void secureItems.delete(key),
}));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

const openStore = MobilePreferences.make().pipe(
  Effect.provide(
    Layer.mergeAll(
      MobileDatabase.layer,
      Layer.succeed(MobileSecureStorage.MobileSecureStorage, MobileSecureStorage.make),
    ),
  ),
);

const ref = (environmentId: string, projectId: string) => ({
  environmentId: EnvironmentId.make(environmentId),
  projectId: ProjectId.make(projectId),
});
const filter: ProjectFilter = {
  entries: [
    { key: "github.com/acme/web", members: [ref("local", "web"), ref("vm", "web")] },
    { key: "vm:api", members: [ref("vm", "api")] },
  ],
};

describe("mobile project filter preference", () => {
  it.effect("Mobile: the filter is a device-local preference that survives a relaunch", () =>
    Effect.gen(function* () {
      secureItems.clear();
      const store = yield* openStore;
      yield* store.savePatch({ projectGroupingMode: "repository", projectFilter: filter });

      // A relaunch reads the device's storage again.
      const relaunched = yield* openStore;
      const loaded = yield* relaunched.load;
      expect(loaded.projectFilter).toEqual(filter);
      expect(loaded.projectGroupingMode).toBe("repository");
      expect([...secureItems.keys()]).toEqual(["t3code.preferences.fallback"]);
    }),
  );

  it.effect("drops a stored filter it cannot read", () =>
    Effect.gen(function* () {
      secureItems.clear();
      secureItems.set(
        "t3code.preferences.fallback",
        JSON.stringify({ payload: JSON.stringify({ projectFilter: "web" }), updatedAt: 1 }),
      );
      const loaded = yield* (yield* openStore).load;
      expect(loaded).not.toHaveProperty("projectFilter");
    }),
  );
});
