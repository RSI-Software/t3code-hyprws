import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { AtomCommand, AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";

import type { ThreadRouteFamily } from "../threadRoutes";
import { useThreadRouteFamily } from "../lib/threadRouteNavigation";
import {
  forkInFlight,
  setForkInFlight,
  threadForkCommand,
  waitForChildShellFork,
} from "../state/threadFork.fork";

export { forkInFlight, readForkProviderFork } from "../state/threadFork.fork";
export {
  forkThreadMenuStateFork,
  forkThreadStateTailFork,
} from "../components/threadActionMenu.logic.fork";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

/** The command run's own shape: the client splits the target from the payload. */
type ThreadForkCommand = typeof threadForkCommand;
type ThreadForkCommandRun =
  ThreadForkCommand extends AtomCommand<infer W, infer A, infer E>
    ? (target: W) => Promise<AtomCommandResult<A, E>>
    : never;

/** The route options a thread navigation needs, straight from the family. */
type ThreadRouteTarget = ReturnType<ThreadRouteFamily["thread"]>;

const FORK_FAILED_TITLE = "Could not fork thread";

/**
 * Fork: Reset order dispatch for the chat-header thread menu. Clears the
 * manual active-order key through the existing active-reorder write (null =
 * automatic ordering). Single call so the header menu keeps a one-line hook.
 */
export function reportResetOrderThreadAction(input: {
  readonly threadRef: ScopedThreadRef;
  readonly reorderActiveThread: (
    target: ScopedThreadRef,
    orderKey: string | null,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly reportFailure: (
    title: string,
    run: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => Promise<void>;
}): Promise<void> {
  const { threadRef, reorderActiveThread, reportFailure } = input;
  return reportFailure("Failed to reset thread order", () => reorderActiveThread(threadRef, null));
}

/** One fork RPC from click to navigation; both menu surfaces share it. */
export async function forkThreadActionFork(input: {
  readonly threadRef: ScopedThreadRef;
  readonly routeFamily: ThreadRouteFamily;
  readonly navigate: (options: ThreadRouteTarget) => Promise<void> | void;
  readonly forkThread: ThreadForkCommandRun;
  /** Defaults to the real store wait; tests substitute a gate. */
  readonly waitForShell?: (ref: ScopedThreadRef) => Promise<boolean>;
}): Promise<void> {
  const { threadRef, routeFamily, navigate, forkThread } = input;
  const waitForShell = input.waitForShell ?? waitForChildShellFork;
  const threadKey = scopedThreadKey(threadRef);
  if (forkInFlight(threadKey)) return;
  const toastFailure = (cause: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: FORK_FAILED_TITLE,
        description: cause instanceof Error ? cause.message : "An error occurred.",
      }),
    );
  // The command target splits environment routing from the RPC payload; the
  // payload itself is only {threadId}. Refusals surface as a Failure result,
  // defects (wire/schema crashes) as a rejected run, and interruption as an
  // interrupts-only cause — all paths clear the in-flight flag, and only
  // interruption stays silent.
  setForkInFlight(threadKey, true);
  try {
    const result = await forkThread({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      throw squashAtomCommandFailure(result);
    }
    // The child's shell can lag the RPC reply; landing first would read as
    // a missing thread and bounce to the index. Hold the in-flight flag and
    // wait for the store, but never hang: on timeout navigate anyway.
    const childRef: ScopedThreadRef = {
      environmentId: threadRef.environmentId,
      threadId: result.value.childThreadId,
    };
    await waitForShell(childRef);
    try {
      await navigate(
        routeFamily.thread({
          environmentId: childRef.environmentId,
          threadId: childRef.threadId,
        }),
      );
    } catch {
      // The child exists server-side; a navigation failure must not read as
      // a failed fork, so no error toast here.
    }
  } catch (cause) {
    toastFailure(cause);
  } finally {
    setForkInFlight(threadKey, false);
  }
}

/**
 * Fork: the shared dispatch for the sidebar row menu and the chat-header
 * menu. Runs the fork RPC, toasts readable refusals and defects, and
 * navigates to the child on success. One hook per surface keeps dispatch to a
 * one-line case.
 */
export function useThreadForkDispatchFork(): (threadRef: ScopedThreadRef) => Promise<void> {
  const router = useRouter();
  const routeFamily = useThreadRouteFamily();
  // reportFailure keeps the library's console warning (it never toasts);
  // the toast itself belongs to this dispatch.
  const forkThread = useAtomCommand(threadForkCommand);
  return useCallback(
    (threadRef) =>
      forkThreadActionFork({
        threadRef,
        routeFamily,
        navigate: (options) => router.navigate(options),
        forkThread,
      }),
    [forkThread, routeFamily, router],
  );
}
