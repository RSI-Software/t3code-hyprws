import type { ScopedThreadRef } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

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
