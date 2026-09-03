import { describe, expect, it } from "vite-plus/test";
import {
  planPinnedMove,
  sortPinnedThreadsByOrderKey,
  sortThreads,
  type ThreadSortInput,
} from "./threadSort.ts";
type TestThread = {
  readonly id: string;
} & ThreadSortInput;
function makeThread(overrides: Partial<TestThread> = {}): TestThread {
  return {
    id: "thread-1",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    messages: [],
    latestUserMessageAt: null,
    ...overrides,
  };
}
describe("sortThreads", () => {
  it("preserves incoming order in manual mode", () => {
    const threads = [makeThread({ id: "thread-2" }), makeThread({ id: "thread-1" })];
    expect(sortThreads(threads, "manual").map((thread) => thread.id)).toEqual([
      "thread-2",
      "thread-1",
    ]);
    expect(sortThreads(threads, "manual")).not.toBe(threads);
  });
});
