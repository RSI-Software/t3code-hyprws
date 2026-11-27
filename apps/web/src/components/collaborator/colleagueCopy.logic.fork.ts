// Fork-only (colleague-collab): this device's copy of each thread a colleague shares, so it stays
// readable while their machine is offline. The copy is the thread's ordinary cache entry, which
// the thread view already opens offline; forking a colleague's thread reads it too.
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import { ThreadSnapshotLoader } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

type SharedThreadRow = Pick<
  OrchestrationV2ThreadShell,
  "id" | "collaboratorFork" | "activeRunId" | "latestRunId" | "itemCount" | "updatedAt"
>;

/** Changes whenever the host's thread does, so a copy is fetched once per change. */
const sharedThreadVersion = (thread: SharedThreadRow) =>
  `${DateTime.formatIso(thread.updatedAt)}|${thread.itemCount}|${thread.latestRunId ?? ""}`;

/**
 * The shared threads whose copy is behind: still shared, between runs, and changed since
 * `copied` last recorded them. A running thread is copied once it settles.
 */
export function sharedThreadsToCopyFork(
  threads: ReadonlyArray<SharedThreadRow>,
  copied: ReadonlyMap<ThreadId, string>,
): ReadonlyArray<{ readonly threadId: ThreadId; readonly version: string }> {
  return threads.flatMap((thread) => {
    if (thread.collaboratorFork === undefined || thread.collaboratorFork === "frozen") return [];
    if (thread.activeRunId !== null) return [];
    const version = sharedThreadVersion(thread);
    return copied.get(thread.id) === version ? [] : [{ threadId: thread.id, version }];
  });
}

/**
 * Saves the host's current thread over HTTP as this device's copy. A copy already at or past that
 * point, such as an open thread's own, is kept. True once the copy is current.
 */
export const copySharedThreadFork = Effect.fn("ColleagueCopy.copyThread")(function* (
  environmentId: EnvironmentId,
  prepared: PreparedConnection,
  threadId: ThreadId,
) {
  const loader = yield* ThreadSnapshotLoader;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const loaded = yield* loader.load(prepared, threadId);
  if (loaded._tag !== "present") return false;
  const held = yield* cache
    .loadThread(environmentId, threadId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isSome(held) && held.value.snapshotSequence >= loaded.snapshot.snapshotSequence) {
    return true;
  }
  yield* cache.saveThread(environmentId, {
    ...loaded.snapshot,
    ...(loaded.history === undefined
      ? {}
      : {
          historyCursor: loaded.history.historyCursor,
          hasMoreHistory: loaded.history.hasMoreHistory,
        }),
  });
  return true;
});
