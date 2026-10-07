// Fork-only: the fork dispatch's failure surfaces. A refused or defected
// fork must produce a toast call — silence reads as a dead click.
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../components/ui/toast";
import { forkThreadActionFork } from "./useThreadActionMenu.fork";

const THREAD_REF: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const failureResult = (cause: Cause.Cause<unknown>): AtomCommandResult<never, unknown> =>
  AsyncResult.failure(cause) as AtomCommandResult<never, unknown>;

type ForkTarget = {
  readonly environmentId: string;
  readonly input: {
    readonly type: string;
    readonly sourceThreadId: string;
    readonly targetThreadId: string;
  };
};

/** The dispatch RPC answers with the committed sequence only. */
const dispatched = AsyncResult.success({ sequence: 1 }) as unknown as AtomCommandResult<
  unknown,
  unknown
>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("forkThreadActionFork failure surfaces", () => {
  it("toasts a refused fork with the server's reason", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("fork-error-toast");
    const navigate = vi.fn(async () => undefined);
    // An orchestrator refusal: the toast copies the server's message.
    const refusal = new Error("Thread 'thread-1' has no stable run to fork.");
    await forkThreadActionFork({
      threadRef: THREAD_REF,
      navigate,
      forkThread: (() => Promise.resolve(failureResult(Cause.fail(refusal)))) as never,
    });
    expect(add).toHaveBeenCalledTimes(1);
    const toast = add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Could not fork thread");
    expect(toast?.description).toContain("no stable run to fork");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("toasts a defected fork (the run rejects)", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("fork-error-toast");
    const navigate = vi.fn(async () => undefined);
    await forkThreadActionFork({
      threadRef: THREAD_REF,
      navigate,
      forkThread: (() => Promise.reject(new Error("Schema validation failed"))) as never,
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]?.title).toBe("Could not fork thread");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("stays silent for an interrupted run", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("fork-error-toast");
    await forkThreadActionFork({
      threadRef: THREAD_REF,
      navigate: vi.fn(async () => undefined),
      forkThread: (() => Promise.resolve(failureResult(Cause.interrupt()))) as never,
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("dispatches a latest-stable V2 fork and navigates to the minted child", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("fork-error-toast");
    const navigate = vi.fn(async () => undefined);
    const targets: Array<ForkTarget> = [];
    const forkThread = vi.fn((target: ForkTarget) => {
      targets.push(target);
      return Promise.resolve(dispatched);
    });
    await forkThreadActionFork({
      threadRef: THREAD_REF,
      navigate,
      forkThread: forkThread as never,
      waitForShell: async () => true,
      readSourceTitle: () => "Sidebar polish (fork)",
    });
    expect(add).not.toHaveBeenCalled();
    const target = targets[0]!;
    // The command target splits environment routing from the dispatch payload.
    expect(target.environmentId).toBe("environment-1");
    expect(target.input).toMatchObject({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      sourceThreadId: "thread-1",
      sourcePoint: { type: "latest_stable" },
      // Forking a fork does not stack the suffix.
      title: "Sidebar polish (fork)",
    });
    expect(target.input.targetThreadId).not.toBe("thread-1");
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "environment-1", threadId: target.input.targetThreadId },
    });
  });

  it("stays silent when only the navigation to the child fails", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("fork-error-toast");
    const navigate = vi.fn(async () => {
      throw new Error("router gone");
    });
    await forkThreadActionFork({
      threadRef: THREAD_REF,
      navigate,
      forkThread: (() => Promise.resolve(dispatched)) as never,
    });
    // The child exists server-side; a navigation failure must not read as a
    // failed fork.
    expect(add).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("holds navigation until the child shell reaches the store", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("fork-toast");
    const order: string[] = [];
    let releaseShell: (landed: boolean) => void = () => {};
    const shellGate = new Promise<boolean>((resolve) => {
      releaseShell = resolve;
    });
    const navigate = vi.fn(async () => {
      order.push("navigate");
    });
    const done = forkThreadActionFork({
      threadRef: THREAD_REF,
      navigate,
      forkThread: (() => {
        order.push("rpc");
        return Promise.resolve(dispatched);
      }) as never,
      waitForShell: () => {
        order.push("wait");
        return shellGate;
      },
    });
    // Flush microtasks: the RPC settled, but navigation must still be held.
    await Promise.resolve();
    expect(order).toEqual(["rpc", "wait"]);
    expect(navigate).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    releaseShell(true);
    await done;
    expect(order).toEqual(["rpc", "wait", "navigate"]);
  });

  it("navigates anyway when the child shell never lands", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("fork-toast");
    const navigate = vi.fn(async () => undefined);
    await forkThreadActionFork({
      threadRef: THREAD_REF,
      navigate,
      forkThread: (() => Promise.resolve(dispatched)) as never,
      waitForShell: async () => false,
    });
    // Timeout is never a stuck spinner or a false error toast.
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
  });

  it("clears the in-flight flag after a failure so a retry can run", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("fork-error-toast");
    const forkThread = vi.fn(() =>
      Promise.resolve(failureResult(Cause.fail(new Error("refused")))),
    );
    const run = () =>
      forkThreadActionFork({
        threadRef: THREAD_REF,
        navigate: vi.fn(async () => undefined),
        forkThread: forkThread as never,
      });
    await run();
    await run();
    // Both runs reached the command: no in-flight guard swallowed the retry.
    expect(forkThread).toHaveBeenCalledTimes(2);
  });
});
