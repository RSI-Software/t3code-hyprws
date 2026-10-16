import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { createFileSaveSessions } from "./fileSaveSessions";

it("explicit save flushes the shared queue and its newest queued edit only once", async () => {
  vi.useFakeTimers();
  try {
    const first = Promise.withResolvers<AsyncResult.AsyncResult<unknown, unknown>>();
    const persist = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(AsyncResult.success(undefined));
    const sessions = createFileSaveSessions({
      debounceMs: 500,
      canPersist: () => true,
      subscribeWritable: () => () => {},
      persist,
      confirm: () => true,
      readUnsaved: () => null,
    });
    const target = {
      environmentId: EnvironmentId.make("explicit-file-save"),
      cwd: "/workspace",
      relativePath: "README.md",
    };
    const releaseSource = sessions.acquire(target, vi.fn());
    const releaseRich = sessions.acquire(target, vi.fn());
    sessions.change(target, "first");
    sessions.flushFork(target);
    sessions.change(target, "newest");
    sessions.flushFork(target);
    first.resolve(AsyncResult.success(undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(persist.mock.calls).toEqual([
      [target, "first"],
      [target, "newest"],
    ]);
    releaseSource();
    releaseRich();
    await vi.runAllTimersAsync();
    expect(persist).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
