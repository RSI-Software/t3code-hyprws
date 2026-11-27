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

interface SharedThreadVersion {
  readonly threadId: ThreadId;
  readonly version: string;
}

/** Still shared and between runs, with a version that changes whenever the host's thread does. */
const idleSharedThreads = (threads: ReadonlyArray<SharedThreadRow>) =>
  threads.flatMap((thread): ReadonlyArray<SharedThreadVersion> => {
    if (thread.collaboratorFork === undefined || thread.collaboratorFork === "frozen") return [];
    if (thread.activeRunId !== null) return [];
    const version = `${DateTime.formatIso(thread.updatedAt)}|${thread.itemCount}|${thread.latestRunId ?? ""}`;
    return [{ threadId: thread.id, version }];
  });

/** The shared threads whose copy is behind `copied`. A running thread is copied once it settles. */
export const sharedThreadsToCopyFork = (
  threads: ReadonlyArray<SharedThreadRow>,
  copied: ReadonlyMap<ThreadId, string>,
) => idleSharedThreads(threads).filter(({ threadId, version }) => copied.get(threadId) !== version);

/** The shared threads whose copy matches the host's thread right now. */
export const sharedThreadsInSyncFork = (
  threads: ReadonlyArray<SharedThreadRow>,
  copied: ReadonlyMap<ThreadId, string>,
) =>
  idleSharedThreads(threads)
    .filter(({ threadId, version }) => copied.get(threadId) === version)
    .map(({ threadId }) => threadId);

/**
 * Saves the host's current thread over HTTP as this device's copy, unless `wanted` turned false
 * meanwhile, as when the host left this app. A copy at or past that point, such as an open
 * thread's own, is kept.
 */
export const copySharedThreadFork = Effect.fn("ColleagueCopy.copyThread")(function* (
  environmentId: EnvironmentId,
  prepared: PreparedConnection,
  threadId: ThreadId,
  wanted: Effect.Effect<boolean>,
) {
  const loader = yield* ThreadSnapshotLoader;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const loaded = yield* loader.load(prepared, threadId);
  if (loaded._tag !== "present") return loaded._tag;
  const held = yield* cache
    .loadThread(environmentId, threadId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isSome(held) && held.value.snapshotSequence >= loaded.snapshot.snapshotSequence) {
    return "current" as const;
  }
  if (!(yield* wanted)) return "missing" as const;
  yield* cache.saveThread(environmentId, {
    ...loaded.snapshot,
    ...(loaded.history === undefined
      ? {}
      : {
          historyCursor: loaded.history.historyCursor,
          hasMoreHistory: loaded.history.hasMoreHistory,
        }),
  });
  return "current" as const;
});
