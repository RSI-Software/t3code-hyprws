// Fork-only (zmux-estate): a compare-and-set on a thread's branch. Checkout
// HEAD follow names the branch it read, so a rename that lands between its
// read and its write is not overwritten. Reached from the decider through
// `zmux-estate/decider-expected-branch`.
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Refuses a metadata update whose `expectedBranch` is no longer the thread's branch. */
export const refuseStaleBranchFork = <E>(
  command: OrchestrationV2ServerCommand,
  branch: string | null,
  refuse: (cause: string) => E,
): Effect.Effect<void, E> =>
  command.type === "thread.metadata.update" &&
  command.expectedBranch !== undefined &&
  command.expectedBranch !== branch
    ? Effect.fail(
        refuse(
          `Thread ${command.threadId} branch changed before the metadata update could be applied.`,
        ),
      )
    : Effect.void;
