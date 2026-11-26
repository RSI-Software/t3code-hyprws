import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createColleagueReconcilerFork, type KnownColleagueFork } from "./colleagueReconcile.fork";

const alex = { environmentId: EnvironmentId.make("alex"), name: "Alex" };
const known = new Set([alex.environmentId]);

const device = (list: ReadonlyArray<KnownColleagueFork>) => {
  let stored = list;
  return {
    read: () => stored,
    write: (next: ReadonlyArray<KnownColleagueFork>) => (stored = next),
  };
};

// A window starts by reading the device's last list.
const openWindow = (storage: ReturnType<typeof device>) =>
  createColleagueReconcilerFork(storage.read(), storage.write);

describe("createColleagueReconcilerFork", () => {
  it("keeps a failed removal for the next list and announces only success", async () => {
    const storage = device([alex]);
    const reconcile = openWindow(storage);
    const forgotten: string[] = [];
    const run = (removed: boolean) =>
      reconcile({
        current: [],
        known,
        remove: async () => removed,
        forgotten: (colleague) => forgotten.push(colleague.name),
      });

    await run(false);
    expect(forgotten).toEqual([]);
    expect(storage.read()).toEqual([alex]);

    await run(true);
    expect(forgotten).toEqual(["Alex"]);
    expect(storage.read()).toEqual([]);
  });

  it.each([
    ["after both saw the colleague", true],
    ["when one window's first list arrives after the other cleaned up", false],
  ])("lets every open window forget a removed colleague %s", async (_, bothSawThem) => {
    const storage = device([alex]);
    const windows = [openWindow(storage), openWindow(storage)];
    const step = (index: number, current: ReadonlyArray<KnownColleagueFork>, log: string[]) =>
      windows[index]!({
        current,
        known,
        remove: async () => (log.push(`window ${index}`), true),
        forgotten: () => {},
      });

    if (bothSawThem) await Promise.all([step(0, [alex], []), step(1, [alex], [])]);
    const removed: string[] = [];
    await step(0, [], removed);
    await step(1, [], removed);
    expect(removed).toEqual(["window 0", "window 1"]);
  });
});
