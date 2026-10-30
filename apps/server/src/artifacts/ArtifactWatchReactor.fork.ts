// Fork-owned (thread-artifacts): keeps linked artifacts' `updatedAt` and `missing` current.
// Watches each linked file's parent directory, since editors and agents often replace a file by
// rename, which ends a watch on the file itself. Observations fold back through
// `thread.artifact.observe`, so replay rebuilds the same projection.
import {
  CommandId,
  type OrchestrationV2AppThread,
  type ThreadArtifactLink,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import {
  ArtifactDirectoryWatch,
  type ArtifactDirectoryWatcher,
} from "./ArtifactDirectoryWatch.fork.ts";

/** A burst of writes to one file settles into one check this long after its first event. */
export const ARTIFACT_CHANGE_SETTLE = Duration.millis(150);

interface WatchedPath {
  readonly directory: string;
  readonly name: string;
  /** Each linking thread's last known link, to dispatch only real changes. */
  readonly links: Map<ThreadId, ThreadArtifactLink>;
  /** Inode, size and mtime at the last check, to catch a replacement that kept the old mtime. */
  fingerprint: string | undefined;
}

interface WatchedDirectory {
  /** Linked paths inside it; the watcher closes with the last one. */
  readonly paths: Set<string>;
  /**
   * On the directory, or while it is missing on its nearest existing ancestor. Unset when nothing
   * can be watched; a later update to a link retries.
   */
  watcher: ArtifactDirectoryWatcher | undefined;
}

type TopologyChange =
  | { readonly kind: "snapshot" }
  | {
      readonly kind: "thread";
      readonly threadId: ThreadId;
      readonly links: ReadonlyArray<ThreadArtifactLink>;
    };

export class ArtifactWatchReactor extends Context.Service<
  ArtifactWatchReactor,
  {
    /** Resolves once every queued link change and file check was processed. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/artifacts/ArtifactWatchReactor.fork/ArtifactWatchReactor") {}

const liveLinks = (
  thread: Pick<OrchestrationV2AppThread, "archivedAt" | "deletedAt" | "artifacts">,
): ReadonlyArray<ThreadArtifactLink> =>
  thread.archivedAt === null && thread.deletedAt === null ? (thread.artifacts ?? []) : [];

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const watchDirectory = yield* ArtifactDirectoryWatch;

  const threadPaths = new Map<ThreadId, Set<string>>();
  const paths = new Map<string, WatchedPath>();
  const directories = new Map<string, WatchedDirectory>();

  const logSkipped =
    (message: string, fields: Record<string, string>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning(message, cause).pipe(Effect.annotateLogs(fields));

  const closeWatcher = (directory: WatchedDirectory) => {
    const watcher = directory.watcher;
    directory.watcher = undefined;
    try {
      watcher?.close();
    } catch {
      // A watcher that already failed has nothing left to release.
    }
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const directory of directories.values()) closeWatcher(directory);
      directories.clear();
    }),
  );

  const observe = Effect.fn("ArtifactWatchReactor.observe")(function* (filePath: string) {
    const entry = paths.get(filePath);
    if (entry === undefined) return;
    const info = yield* fs.stat(filePath).pipe(Effect.option);
    const missing = Option.isNone(info);
    const mtimeMs = Option.getOrUndefined(Option.flatMap(info, (file) => file.mtime))?.getTime();
    const fingerprint = Option.match(info, {
      onNone: () => undefined,
      onSome: (file) => `${Option.getOrUndefined(file.ino)}:${file.size}:${mtimeMs}`,
    });
    const replaced =
      entry.fingerprint !== undefined &&
      fingerprint !== undefined &&
      fingerprint !== entry.fingerprint;
    entry.fingerprint = fingerprint;
    yield* Effect.forEach(
      [...entry.links],
      ([threadId, link]) => {
        const linkedMs = Date.parse(link.updatedAt);
        // A replacement that kept its mtime reports one millisecond on, so clients see a new
        // revision; until the file changes again, that bump is the current revision.
        const current =
          mtimeMs === linkedMs || (!replaced && mtimeMs !== undefined && mtimeMs + 1 === linkedMs);
        const changed = missing
          ? !link.missing
          : // Any other mtime is a change: a replacement may carry an older one.
            link.missing || replaced || (mtimeMs !== undefined && !current);
        if (!changed) return Effect.void;
        // A missing file keeps its last known change; a present one reports its own mtime.
        const updatedAt =
          missing || mtimeMs === undefined
            ? link.updatedAt
            : DateTime.formatIso(
                DateTime.makeUnsafe(replaced && mtimeMs === linkedMs ? mtimeMs + 1 : mtimeMs),
              );
        return crypto.randomUUIDv4().pipe(
          Effect.flatMap((uuid) =>
            engine.dispatch({
              type: "thread.artifact.observe",
              commandId: CommandId.make(`server:artifact-observe:${threadId}:${uuid}`),
              threadId,
              path: filePath,
              updatedAt,
              missing,
            }),
          ),
          Effect.catchCause(
            logSkipped("linked artifact observation skipped", { threadId, path: filePath }),
          ),
        );
      },
      { discard: true },
    );
  });

  const checks = yield* makeDrainableWorker((filePath: string) =>
    observe(filePath).pipe(
      Effect.catchCause(logSkipped("linked artifact check failed", { path: filePath })),
    ),
  );

  // One settle timer per path: events during it fold into its check, and an event after it
  // started its check queues another, so the last write is always read.
  const runSettle = yield* FiberMap.makeRuntime<never, string>();
  const runRewatch = yield* FiberMap.makeRuntime<never, string>();
  const settle = (filePath: string) =>
    runSettle(
      filePath,
      Effect.sleep(ARTIFACT_CHANGE_SETTLE).pipe(Effect.andThen(checks.enqueue(filePath))),
      {
        onlyIfMissing: true,
      },
    );

  /**
   * Watches the directory, or while it is missing its nearest existing ancestor, which rewatches
   * once the next missing directory appears. Returns whether the directory itself is watched.
   */
  const watch = (directoryPath: string, directory: WatchedDirectory): boolean => {
    closeWatcher(directory);
    const self = path.basename(directoryPath);
    const checkAll = () => {
      for (const filePath of directory.paths) settle(filePath);
    };
    let target = directoryPath;
    let next = self;
    for (;;) {
      const ancestor = target !== directoryPath;
      const expected = next;
      const targetName = path.basename(target);
      try {
        const watcher = watchDirectory(target, (_event, filename) => {
          if (directory.watcher !== watcher) return;
          const name = filename?.toString() ?? expected;
          if (ancestor) {
            // The next directory appeared, or the ancestor itself moved or went.
            if ((name === expected || name === targetName) && watch(directoryPath, directory)) {
              checkAll();
            }
            return;
          }
          // No name, or the directory's own name when it moves or goes, may touch every file.
          if (name === self) {
            watch(directoryPath, directory);
            checkAll();
            return;
          }
          for (const filePath of directory.paths) {
            if (paths.get(filePath)?.name === name) settle(filePath);
          }
        });
        // A failed watcher reports nothing more: drop it, recheck every file it covered, and
        // rewatch after a pause, so one that keeps failing cannot spin.
        watcher.on("error", () => {
          if (directory.watcher !== watcher) return;
          closeWatcher(directory);
          checkAll();
          runRewatch(
            directoryPath,
            Effect.sleep(ARTIFACT_CHANGE_SETTLE).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (directories.get(directoryPath) !== directory) return;
                  if (directory.watcher !== undefined) return;
                  watch(directoryPath, directory);
                  checkAll();
                }),
              ),
            ),
            { onlyIfMissing: true },
          );
        });
        directory.watcher = watcher;
        return !ancestor;
      } catch {
        // Typically a missing directory: fall back to its parent.
        const parent = path.dirname(target);
        if (parent === target) return false;
        next = path.basename(target);
        target = parent;
      }
    }
  };

  const release = (threadId: ThreadId, filePath: string) => {
    const entry = paths.get(filePath);
    if (entry === undefined) return;
    entry.links.delete(threadId);
    if (entry.links.size > 0) return;
    paths.delete(filePath);
    const directory = directories.get(entry.directory);
    if (directory === undefined) return;
    directory.paths.delete(filePath);
    if (directory.paths.size > 0) return;
    closeWatcher(directory);
    directories.delete(entry.directory);
  };

  /** Moves a thread's watches to its current links; returns the paths that need a check. */
  const applyThread = (threadId: ThreadId, links: ReadonlyArray<ThreadArtifactLink>) => {
    const next = new Map<string, ThreadArtifactLink>();
    for (const link of links) if (path.isAbsolute(link.path)) next.set(link.path, link);
    for (const filePath of threadPaths.get(threadId) ?? []) {
      if (!next.has(filePath)) release(threadId, filePath);
    }
    if (next.size === 0) threadPaths.delete(threadId);
    else threadPaths.set(threadId, new Set(next.keys()));

    const toCheck = new Set<string>();
    for (const [filePath, link] of next) {
      let entry = paths.get(filePath);
      if (entry === undefined) {
        entry = {
          directory: path.dirname(filePath),
          name: path.basename(filePath),
          links: new Map(),
          fingerprint: undefined,
        };
        paths.set(filePath, entry);
      }
      // A new link, a relink, or an observation landing: the watcher cannot report a file that
      // was already gone, so recheck it. A check that finds nothing new dispatches nothing.
      const previous = entry.links.get(threadId);
      if (previous?.updatedAt !== link.updatedAt || previous.missing !== link.missing) {
        toCheck.add(filePath);
      }
      entry.links.set(threadId, link);

      let directory = directories.get(entry.directory);
      if (directory === undefined) {
        directory = { paths: new Set(), watcher: undefined };
        directories.set(entry.directory, directory);
      }
      directory.paths.add(filePath);
      // A newly watched directory may have changed while unwatched: check all its files.
      if (directory.watcher === undefined && watch(entry.directory, directory)) {
        for (const watchedPath of directory.paths) toCheck.add(watchedPath);
      }
    }
    return toCheck;
  };

  /** Files edited while the server was down: every active link gets one check. */
  const applySnapshot = Effect.fn("ArtifactWatchReactor.applySnapshot")(function* () {
    const shell = yield* engine.getShellSnapshot({ location: "active" });
    const live = new Set<ThreadId>();
    for (const thread of shell.threads) {
      live.add(thread.id);
      applyThread(thread.id, liveLinks(thread));
    }
    for (const threadId of threadPaths.keys()) {
      if (!live.has(threadId)) applyThread(threadId, []);
    }
    return new Set(paths.keys());
  });

  const topology = yield* makeDrainableWorker((change: TopologyChange) =>
    Effect.gen(function* () {
      const toCheck =
        change.kind === "thread"
          ? applyThread(change.threadId, change.links)
          : yield* applySnapshot();
      yield* Effect.forEach(toCheck, checks.enqueue, { discard: true });
    }).pipe(
      Effect.catchCause(logSkipped("linked artifact watch update failed", { change: change.kind })),
    ),
  );

  // Starts with its layer, parked until the server activates. The snapshot queues before the
  // event stream; each thread event carries the whole thread, so applying both in order
  // converges on the current links.
  yield* forkParked(
    topology.enqueue({ kind: "snapshot" }).pipe(
      Effect.andThen(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          switch (event.type) {
            case "thread.created":
            case "thread.metadata-updated":
            case "thread.archived":
            case "thread.unarchived":
            case "thread.deleted":
              return topology.enqueue({
                kind: "thread",
                threadId: event.threadId,
                links: liveLinks(event.payload),
              });
            default:
              return Effect.void;
          }
        }),
      ),
      Effect.catchCause(logSkipped("linked artifact event stream failed", {})),
    ),
  );

  return ArtifactWatchReactor.of({
    // Link changes queue checks, never the reverse.
    drain: Effect.andThen(topology.drain, checks.drain),
  });
});

/** Server-lifetime watcher for every active thread's linked artifacts. */
export const layer = Layer.effect(ArtifactWatchReactor, make);
