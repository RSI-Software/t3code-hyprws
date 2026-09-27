// Fork-only: the fork dispatch's failure surfaces. A refused or defected
// fork must produce a toast call — silence reads as a dead click.
import { Cause } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId, ProviderDriverKind, ThreadForkError, ThreadId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../components/ui/toast";
import type { ThreadRouteFamily } from "../threadRoutes";
import { forkThreadActionFork } from "./useThreadActionMenu.fork";

const THREAD_REF: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const routeFamily = {
  kind: "hub",
  thread: (ref: ScopedThreadRef) => ({
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: ref.environmentId, threadId: ref.threadId },
  }),
} as unknown as ThreadRouteFamily;

const failureResult = (cause: Cause.Cause<unknown>): AtomCommandResult<never, unknown> =>
  AsyncResult.failure(cause) as AtomCommandResult<never, unknown>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("forkThreadActionFork failure surfaces", () => {
  it("toasts a refused fork with the server's reason", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("fork-error-toast");
    const navigate = vi.fn(async () => undefined);
    // A real coded refusal: the toast copies the server's reason message.
    const refusal = new ThreadForkError({
      threadId: THREAD_REF.threadId,
      reason: "instance-mismatch",
      provider: ProviderDriverKind.make("claudeAgent"),
      detail: "Provider instance 'claudeAgent' is not an available Claude instance.",
    });
    await forkThreadActionFork({
      threadRef: THREAD_REF,
      routeFamily,
      navigate,
      forkThread: (() => Promise.resolve(failureResult(Cause.fail(refusal)))) as never,
    });
    expect(add).toHaveBeenCalledTimes(1);
    const toast = add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Could not fork thread");
    expect(toast?.description).toContain("not an available Claude instance");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("toasts a defected fork (the run rejects)", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("fork-error-toast");
    const navigate = vi.fn(async () => undefined);
    await forkThreadActionFork({
      threadRef: THREAD_REF,
      routeFamily,
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
      routeFamily,
      navigate: vi.fn(async () => undefined),
      forkThread: (() => Promise.resolve(failureResult(Cause.interrupt()))) as never,
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("navigates to the child on success without toasting", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("fork-error-toast");
    const navigate = vi.fn(async () => undefined);
    const forkThread = vi.fn((target: { environmentId: string; input: { threadId: string } }) => {
      // The command target splits environment routing from the payload.
      expect(target).toEqual({
        environmentId: "environment-1",
        input: { threadId: "thread-1" },
      });
      return Promise.resolve(
        AsyncResult.success({
          childThreadId: ThreadId.make("import:claudeAgent:fork-child"),
        }) as unknown as AtomCommandResult<unknown, unknown>,
      );
    });
    await forkThreadActionFork({
      threadRef: THREAD_REF,
      routeFamily,
      navigate,
      forkThread: forkThread as never,
      waitForShell: async () => true,
    });
    expect(add).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "environment-1", threadId: "import:claudeAgent:fork-child" },
    });
  });

  it("stays silent when only the navigation to the child fails", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("fork-error-toast");
    const navigate = vi.fn(async () => {
      throw new Error("router gone");
    });
    await forkThreadActionFork({
      threadRef: THREAD_REF,
      routeFamily,
      navigate,
      forkThread: (() =>
        Promise.resolve(
          AsyncResult.success({
            childThreadId: ThreadId.make("import:claudeAgent:fork-child"),
          }) as unknown as AtomCommandResult<unknown, unknown>,
        )) as never,
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
      routeFamily,
      navigate,
      forkThread: (() => {
        order.push("rpc");
        return Promise.resolve(
          AsyncResult.success({
            childThreadId: ThreadId.make("import:claudeAgent:fork-child"),
          }) as unknown as AtomCommandResult<unknown, unknown>,
        );
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
      routeFamily,
      navigate,
      forkThread: (() =>
        Promise.resolve(
          AsyncResult.success({
            childThreadId: ThreadId.make("import:claudeAgent:fork-child"),
          }) as unknown as AtomCommandResult<unknown, unknown>,
        )) as never,
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
        routeFamily,
        navigate: vi.fn(async () => undefined),
        forkThread: forkThread as never,
      });
    await run();
    await run();
    // Both runs reached the command: no in-flight guard swallowed the retry.
    expect(forkThread).toHaveBeenCalledTimes(2);
  });
});
