import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { FileSaveCoordinator } from "./fileSaveCoordinator";

it("does not retry a refused draft through its old debounce timer after draining a flush", async () => {
  vi.useFakeTimers();
  try {
    const first = Promise.withResolvers<AsyncResult.AsyncResult<unknown, unknown>>();
    const persist = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(AsyncResult.failure(Cause.interrupt()));
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });
    coordinator.change("first");
    coordinator.flush();
    coordinator.change("conflicting newest draft");
    first.resolve(AsyncResult.success(undefined));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(persist.mock.calls).toEqual([["first"], ["conflicting newest draft"]]);
  } finally {
    vi.useRealTimers();
  }
});
