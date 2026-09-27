import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { AtomCommand, AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";

import type { ThreadRouteFamily } from "../threadRoutes";
import { useThreadRouteFamily } from "../lib/threadRouteNavigation";
import { forkInFlight, setForkInFlight, threadForkCommand } from "../state/threadFork.fork";

export { forkInFlight, readForkProviderFork } from "../state/threadFork.fork";
export { forkThreadMenuStateFork } from "../components/threadActionMenu.logic.fork";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

/** The command run's own shape: the client splits the target from the payload. */
type ThreadForkCommand = typeof threadForkCommand;
type ThreadForkCommandRun =
  ThreadForkCommand extends AtomCommand<infer W, infer A, infer E>
    ? (target: W) => Promise<AtomCommandResult<A, E>>
    : never;

/** One settled fork run: ok, a readable refusal, or a user cancellation. */
type ForkOutcome =
  | { readonly ok: true; readonly childThreadId: ThreadId }
  | { readonly ok: false; readonly interrupted: true }
  | { readonly ok: false; readonly interrupted: false; readonly cause: unknown };

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
}): Promise<void> {
  const { threadRef, routeFamily, navigate, forkThread } = input;
  const threadKey = scopedThreadKey(threadRef);
  if (forkInFlight(threadKey)) return;
  setForkInFlight(threadKey, true);
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
  // and defects (wire/schema crashes) as a rejected run — both must toast.
  const outcome = await settlePromise(async (): Promise<ForkOutcome> => {
    const result = await forkThread({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return { ok: false, interrupted: true };
      return { ok: false, interrupted: false, cause: squashAtomCommandFailure(result) };
    }
    return { ok: true, childThreadId: result.value.childThreadId };
  });
  setForkInFlight(threadKey, false);
  if (outcome._tag === "Failure") {
    toastFailure(outcome.cause);
    return;
  }
  if (!outcome.value.ok) {
    if (!outcome.value.interrupted) toastFailure(outcome.value.cause);
    return;
  }
  try {
    await navigate(
      routeFamily.thread({
        environmentId: threadRef.environmentId,
        threadId: outcome.value.childThreadId,
      }),
    );
  } catch {
    // The child exists server-side; a navigation failure must not read as a
    // failed fork, so no error toast here.
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
