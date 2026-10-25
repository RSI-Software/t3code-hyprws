import { EnvironmentId, ThreadId, type ThreadGroupsSnapshotFork } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const storage = new Map<string, string>([
    // Groups this client kept locally before the server owned them.
    [
      "t3code:thread-groups-import:v1",
      JSON.stringify([{ id: "local", title: "Local", threadIds: ["env:c", "env:d"] }]),
    ],
  ]);
  globalThis.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  } as Storage;
  return { runAtomCommand: vi.fn() };
});

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));
vi.mock("@t3tools/client-runtime/state/thread-groups", () => ({
  createThreadGroupEnvironmentAtoms: () => ({ mutate: "mutate", groups: () => "groups" }),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import {
  receiveThreadGroupsSnapshotFork,
  renameThreadGroup,
  setThreadGroupMembership,
  useThreadGroupStoreFork,
} from "./threadGroups";

const env = EnvironmentId.make("env");
const snapshot = (revision: number, groups: ThreadGroupsSnapshotFork["groups"]) => ({
  epoch: "run-1",
  revision,
  groups,
});
const shown = () =>
  useThreadGroupStoreFork.getState().threadGroups.map(({ id, title }) => `${id} ${title}`);

/** Each call to the server waits until the test answers it. */
function answers() {
  const calls: Array<(value: unknown) => void> = [];
  mocks.runAtomCommand.mockImplementation(() => new Promise((resolve) => calls.push(resolve)));
  return {
    sent: () => calls.length,
    answer: async (call: number, value: unknown) => {
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(call));
      calls[call]!(value);
    },
  };
}

describe("thread group store", () => {
  it("retries a failed import, keeps pending edits over snapshots, and sends edits in order", async () => {
    const server = answers();
    receiveThreadGroupsSnapshotFork(env, snapshot(1, []));
    // The import fails; the next snapshot tries again.
    await server.answer(0, { _tag: "Failure", error: new Error("offline") });
    await vi.waitFor(() => {
      receiveThreadGroupsSnapshotFork(env, snapshot(1, []));
      expect(server.sent()).toBe(2);
    });
    const local = { id: "local", title: "Local", threadIds: ["c", "d"] } as never;
    await server.answer(1, { _tag: "Success", value: snapshot(2, [local]) });
    await vi.waitFor(() => expect(shown()).toEqual(["env:local Local"]));

    expect(
      setThreadGroupMembership(["env:a", "env:b"], {
        kind: "new",
        group: { id: "env:g1", title: "New group" },
      }),
    ).toBe(true);
    // Another client's change arrives while the edit is in flight.
    receiveThreadGroupsSnapshotFork(env, snapshot(3, []));
    expect(shown()).toEqual(["env:g1 New group"]);

    // Two renames: the second waits for the first, so the older one never
    // replays over the newer answer.
    renameThreadGroup("env:g1", "First");
    renameThreadGroup("env:g1", "Second");
    const g1 = {
      id: "g1",
      title: "New group",
      threadIds: [ThreadId.make("a"), ThreadId.make("b")],
    };
    await server.answer(2, { _tag: "Success", value: snapshot(4, [g1]) });
    expect(server.sent()).toBe(3);
    await server.answer(3, { _tag: "Success", value: snapshot(5, [{ ...g1, title: "First" }]) });
    await server.answer(4, { _tag: "Success", value: snapshot(6, [{ ...g1, title: "Second" }]) });
    await vi.waitFor(() => expect(useThreadGroupStoreFork.getState().pending[env]).toEqual([]));
    expect(shown()).toEqual(["env:g1 Second"]);

    // A thread from another environment cannot join, so callers skip follow-ups.
    expect(setThreadGroupMembership(["other:x"], { kind: "existing", groupId: "env:g1" })).toBe(
      false,
    );
  });
});
