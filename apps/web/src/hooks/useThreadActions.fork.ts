import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { readEnvironmentSupportsActiveReorder } from "../state/entities.ts";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { ThreadActiveReorderUnsupportedError } from "./useThreadActions.ts";

/**
 * Fork: the order key the active-reorder write accepts. A string places the
 * thread manually; null restores automatic ordering by clearing the
 * thread's activeOrderKey.
 */
export type ActiveThreadOrderKey = string | null;

/**
 * Fork: the active-reorder write with a null-capable key. Upstream's
 * `reorderActiveThread` callback stays untouched; this hook exposes the
 * same `thread.active.reorder` command accepting null to restore automatic
 * ordering — the path drags use for manual placement.
 */
export function useReorderActiveThreadFork(input: {
  readonly reorderActiveThreadMutation: (value: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly input: {
      readonly threadId: ScopedThreadRef["threadId"];
      readonly orderKey: string | null;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): (
  target: ScopedThreadRef,
  orderKey: ActiveThreadOrderKey,
) => Promise<AtomCommandResult<unknown, unknown>> {
  return useCallback(
    async (target: ScopedThreadRef, orderKey: ActiveThreadOrderKey) => {
      if (!readEnvironmentSupportsActiveReorder(target.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadActiveReorderUnsupportedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      return input.reorderActiveThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, orderKey },
      });
    },
    [input.reorderActiveThreadMutation],
  );
}

/**
 * Fork: the memoized Reset order callback for the sidebar row menu. Clears
 * the manual key through the existing active-reorder write (null =
 * automatic ordering); failure toasts match the sidebar's attempt* helpers.
 */
export function useAttemptResetThreadOrder(
  reorderActiveThreadOrClear: (
    target: ScopedThreadRef,
    orderKey: ActiveThreadOrderKey,
  ) => Promise<AtomCommandResult<unknown, unknown>>,
): (threadRef: ScopedThreadRef) => void {
  return useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await reorderActiveThreadOrClear(threadRef, null);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to reset thread order",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [reorderActiveThreadOrClear],
  );
}
