import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import type * as TerminalManager from "./Manager.ts";

/**
 * Fork eviction skips a starting session, so the upstream resumed-attach test
 * must exit the newer terminal before the older one evicts. The older attach
 * detaches first: fork eviction publishes `closed` to it.
 */
export const awaitStartingExitEvictionFork = Effect.fn(
  "Manager.eviction.awaitStartingExitEvictionFork",
)(function* (
  manager: TerminalManager.TerminalManager["Service"],
  detach: () => void,
  threadId: string,
) {
  detach();
  const evicted = yield* Deferred.make<void>();
  const unsubscribe = yield* manager.subscribe((event) =>
    event.type === "closed" && event.threadId === threadId
      ? Deferred.succeed(evicted, undefined).pipe(Effect.asVoid)
      : Effect.void,
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  return (newer: { emitExit(event: PtyAdapter.PtyExitEvent): void } | undefined) =>
    Effect.suspend(() => {
      newer?.emitExit({ exitCode: 0, signal: 0 });
      return Deferred.await(evicted);
    });
});
