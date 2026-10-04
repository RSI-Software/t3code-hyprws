import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as HyprlandPlacement from "./HyprlandPlacement.ts";
import type { WindowId } from "./WindowId.fork.ts";
import { windowClaimTitle } from "./WindowPlacement.fork.ts";
import type { WindowProjectManifest } from "./WindowProjectManifest.fork.ts";

const PID = 4242;
const first = "00000000-0000-4000-8000-000000000001" as WindowId;
const second = "00000000-0000-4000-8000-000000000002" as WindowId;

// One mapped client titled `title`; every read resolves on a later tick, so two
// unserialized claims would both read it before either records it.
const oneClient = (title: string) => async (_environment: unknown, payload: string) => {
  await Promise.resolve();
  if (payload !== "j/clients") return "{}";
  return JSON.stringify([{ address: "0xabc", pid: PID, title, workspace: { id: 3, name: "3" } }]);
};

const client = (address: string, title: string) => ({
  address,
  pid: PID,
  title,
  workspace: { id: 3, name: "3" },
});

const listClients =
  (read: () => readonly ReturnType<typeof client>[]) =>
  async (_environment: unknown, payload: string) => {
    await Promise.resolve();
    return payload === "j/clients" ? JSON.stringify(read()) : "{}";
  };

const options = {
  environment: { instanceSignature: "test", runtimeDirectory: "/run/user/1000" },
  pid: PID,
  claimAttempts: 1,
  claimIntervalMs: 0,
};

describe("HyprlandPlacement", () => {
  it.effect("records its own workspace for each of three windows opened together", () =>
    Effect.gen(function* () {
      const third = "00000000-0000-4000-8000-000000000003" as WindowId;
      // One window maps under the normal title, the others under claim titles.
      const mapped = [
        { windowId: first, title: "T3 Code", workspace: 18 },
        { windowId: second, title: windowClaimTitle(second), workspace: 19 },
        { windowId: third, title: windowClaimTitle(third), workspace: 18 },
      ];
      const placement = yield* HyprlandPlacement.make({
        ...options,
        requestHyprland: listClients(() =>
          mapped.map(({ title, workspace }, index) => ({
            ...client(`0x${index}`, title),
            workspace: { id: workspace, name: String(workspace) },
          })),
        ),
      });
      const knownAddresses = new Set<string>();

      yield* Effect.all(
        mapped.map(({ windowId, title }) => placement.claim(windowId, title, { knownAddresses })),
        { concurrency: "unbounded" },
      );

      for (const { windowId, workspace } of mapped) {
        assert.deepEqual(
          yield* placement.workspaceOf(windowId),
          Option.some({ id: workspace, name: String(workspace) }),
        );
      }
    }),
  );

  it.effect("gives one compositor client to exactly one of two concurrent claims", () =>
    Effect.gen(function* () {
      const placement = yield* HyprlandPlacement.make({
        environment: { instanceSignature: "test", runtimeDirectory: "/run/user/1000" },
        pid: PID,
        claimAttempts: 1,
        claimIntervalMs: 0,
        requestHyprland: oneClient("shared-title"),
      });

      yield* Effect.all(
        [placement.claim(first, "shared-title"), placement.claim(second, "shared-title")],
        {
          concurrency: "unbounded",
        },
      );

      const owners = [
        Option.isSome(yield* placement.workspaceOf(first)),
        Option.isSome(yield* placement.workspaceOf(second)),
      ];
      assert.deepEqual(owners.filter(Boolean).length, 1, "exactly one window owns the client");
    }),
  );

  it.effect("claims a window its renderer retitled as the one client new since its show", () =>
    Effect.gen(function* () {
      let clients = [client("0x1", "T3 Code")];
      const placement = yield* HyprlandPlacement.make({
        ...options,
        requestHyprland: listClients(() => clients),
      });
      const knownAddresses = yield* placement.snapshotAddresses;
      clients = [...clients, client("0x2", "Project One")];

      yield* placement.claim(first, "project-1", { knownAddresses });

      assert.isTrue(Option.isSome(yield* placement.workspaceOf(first)));
    }),
  );

  it.effect("claims neither window when two new clients appear at once", () =>
    Effect.gen(function* () {
      let clients = [client("0x1", "T3 Code")];
      const placement = yield* HyprlandPlacement.make({
        ...options,
        requestHyprland: listClients(() => clients),
      });
      const knownAddresses = yield* placement.snapshotAddresses;
      clients = [...clients, client("0x2", "Project One"), client("0x3", "Project Two")];

      yield* placement.claim(first, "project-1", { knownAddresses });
      yield* placement.claim(second, "project-2", { knownAddresses });

      assert.isTrue(Option.isNone(yield* placement.workspaceOf(first)));
      assert.isTrue(Option.isNone(yield* placement.workspaceOf(second)));
    }),
  );

  it.effect("leaves a window unclaimed when no client carries its exact title", () =>
    Effect.gen(function* () {
      const placement = yield* HyprlandPlacement.make({
        environment: { instanceSignature: "test", runtimeDirectory: "/run/user/1000" },
        pid: PID,
        claimAttempts: 1,
        claimIntervalMs: 0,
        requestHyprland: oneClient("T3 Code"),
      });

      yield* placement.claim(first, `t3code-window-${first}`);

      assert.isTrue(Option.isNone(yield* placement.workspaceOf(first)));
    }),
  );

  it.effect("writes each window's address and published scope, and drops it on forget", () =>
    Effect.gen(function* () {
      const writes: WindowProjectManifest[] = [];
      const placement = yield* HyprlandPlacement.make({
        ...options,
        manifestPath: "/manifest.json",
        writeManifest: (path, manifest) =>
          Effect.sync(() => {
            assert.strictEqual(path, "/manifest.json");
            writes.push(manifest);
          }),
        requestHyprland: listClients(() => [client("0xaaa", "T3 Code")]),
      });
      const scope = {
        kind: "projects",
        projects: [{ environmentId: "env", projectId: "web", workspaceRoot: "/src/web" }],
      } as const;

      yield* placement.claim(first, "T3 Code");
      yield* placement.publishScope(first, scope);
      yield* placement.publishScope(second, { kind: "all" });
      yield* placement.forget(first);

      assert.deepEqual(
        writes.map((manifest) => manifest.windows),
        [
          [{ windowId: first, address: "0xaaa", scope: null }],
          [{ windowId: first, address: "0xaaa", scope }],
          [
            { windowId: first, address: "0xaaa", scope },
            { windowId: second, address: null, scope: { kind: "all" } },
          ],
          [{ windowId: second, address: null, scope: { kind: "all" } }],
        ],
      );
      assert.isTrue(writes.every((manifest) => manifest.pid === PID && manifest.version === 1));
    }),
  );

  it.effect("writes no manifest off Hyprland or without a path", () =>
    Effect.gen(function* () {
      const writes: unknown[] = [];
      const record = (_path: string, manifest: WindowProjectManifest) =>
        Effect.sync(() => void writes.push(manifest));
      const offHyprland = yield* HyprlandPlacement.make({
        ...options,
        environment: { instanceSignature: undefined, runtimeDirectory: "/run/user/1000" },
        manifestPath: "/manifest.json",
        writeManifest: record,
      });
      const pathless = yield* HyprlandPlacement.make({ ...options, writeManifest: record });

      yield* offHyprland.publishScope(first, { kind: "all" });
      yield* pathless.publishScope(first, { kind: "all" });

      assert.deepEqual(writes, []);
    }),
  );
});
