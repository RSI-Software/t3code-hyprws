// Fork-only (zmux-estate): keeps thread branches on their checkout's real HEAD.
// A run that ends on another branch, or a `git switch` made outside T3 while
// the checkout is idle, moves every idle branch-bound thread sharing that
// checkout to the new branch. A managed session labels the checkout, not one
// thread, so drift is reconciled per checkout; an active run anywhere on it
// defers the whole reconcile.
import { CommandId, type OrchestrationV2ThreadShell, type ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ZmuxSessionBinder from "../zmux/ZmuxSessionBinder.ts";
import { CheckoutDirectoryWatch } from "./CheckoutDirectoryWatch.fork.ts";
import { isThreadBusyOnCheckoutFork } from "./checkoutMoveIdentity.fork.ts";
import { CheckoutMutationCoordinator } from "./CheckoutMutationCoordinator.ts";

export class CheckoutHeadFollowFork extends Context.Service<
  CheckoutHeadFollowFork,
  {
    /** Moves idle branch-bound threads on the checkout at `cwd` to its HEAD branch. */
    readonly follow: (cwd: string) => Effect.Effect<void>;
    /** Resolves once every run completion and watcher sync enqueued so far was processed. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/git/CheckoutHeadFollow.fork/CheckoutHeadFollowFork") {}

/** How many projects or checkouts a sweep over all threads resolves at once. */
const RESOLVE_CONCURRENCY = 4;

interface WatchedCheckout {
  readonly cwd: string;
  readonly token: object;
  /**
   * Whether HEAD may have moved since the checkout's last follow. It starts
   * set, since HEAD can move before the watcher opens, and a deferred or
   * failed follow sets it again.
   */
  headChanged: boolean;
  fiber?: Fiber.Fiber<void, never>;
}

/** The checkout a thread resolved to at the last watcher sync. */
interface SyncedCheckout {
  readonly worktreePath: string | null;
  readonly cwd: string;
  readonly root: string;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const coordinator = yield* CheckoutMutationCoordinator;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const zmux = yield* Effect.serviceOption(ZmuxSessionBinder.ZmuxSessionBinder);
  const watchDirectory = yield* CheckoutDirectoryWatch;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const newUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const watched = new Map<string, WatchedCheckout>();
  const markHeadChanged = (root: string, headChanged: boolean) => {
    const entry = watched.get(root);
    if (entry !== undefined) entry.headChanged = headChanged;
  };

  const projectRootOf = (projectId: OrchestrationV2ThreadShell["projectId"]) =>
    projects.getShell(projectId).pipe(
      Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
      Effect.orElseSucceed(() => undefined),
    );
  const threadCwd = (thread: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath">) =>
    thread.worktreePath !== null
      ? Effect.succeed<string | undefined>(thread.worktreePath)
      : projectRootOf(thread.projectId);
  const checkoutRootOf = (cwd: string) =>
    registry.resolve({ cwd }).pipe(
      Effect.map((handle) => handle.repository.rootPath),
      Effect.option,
    );

  const isWithin = (directory: string, cwd: string) => {
    const relative = path.relative(directory, cwd);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  };

  /**
   * Each thread's cwd and checkout root. Threads mostly share a few checkouts,
   * so each project and each cwd resolves once, a few at a time. `within`
   * skips every cwd outside those directories before its checkout resolves.
   */
  const resolveCheckouts = Effect.fn("CheckoutHeadFollowFork.resolveCheckouts")(function* (
    candidates: ReadonlyArray<OrchestrationV2ThreadShell>,
    within?: ReadonlyArray<string>,
  ) {
    const projectIds = new Set(
      candidates.flatMap((thread) => (thread.worktreePath === null ? [thread.projectId] : [])),
    );
    const projectRoots = new Map(
      yield* Effect.forEach(
        projectIds,
        (projectId) =>
          projectRootOf(projectId).pipe(Effect.map((cwd) => [projectId, cwd] as const)),
        { concurrency: RESOLVE_CONCURRENCY },
      ),
    );
    const cwds = new Map<ThreadId, string>();
    for (const thread of candidates) {
      const cwd = thread.worktreePath ?? projectRoots.get(thread.projectId);
      if (cwd !== undefined && (within?.some((directory) => isWithin(directory, cwd)) ?? true))
        cwds.set(thread.id, cwd);
    }
    const roots = new Map(
      yield* Effect.forEach(
        new Set(cwds.values()),
        (cwd) =>
          checkoutRootOf(cwd).pipe(
            Effect.map((root) => [cwd, Option.getOrUndefined(root)] as const),
          ),
        { concurrency: RESOLVE_CONCURRENCY },
      ),
    );
    const checkouts = new Map<ThreadId, { readonly cwd: string; readonly root: string }>();
    for (const [threadId, cwd] of cwds) {
      const root = roots.get(cwd);
      if (root !== undefined) checkouts.set(threadId, { cwd, root });
    }
    return checkouts;
  });
  const git = (root: string, operation: string, args: ReadonlyArray<string>) =>
    registry
      .resolve({ cwd: root })
      .pipe(
        Effect.flatMap((handle) =>
          handle.driver.execute({ operation, args, cwd: root, allowNonZeroExit: true }),
        ),
      );

  const logFailure =
    (message: string, context: Readonly<Record<string, unknown>>) =>
    (cause: Cause.Cause<unknown>) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(message, { ...context, cause: Cause.pretty(cause) });

  /** Runs under the checkout lease, so no turn start or branch switch interleaves. */
  const followLocked = Effect.fn("CheckoutHeadFollowFork.followLocked")(function* (
    cwd: string,
    root: string,
  ) {
    markHeadChanged(root, false);
    const head = yield* git(root, "CheckoutHeadFollowFork.head", [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const branch = head.exitCode === 0 ? head.stdout.trim() : "";
    // Detached HEAD has no branch to adopt; a temporary placeholder means the
    // first-turn rename is still in flight.
    if (branch === "" || isTemporaryWorktreeBranch(branch)) return;
    // A thread with no recorded branch is not bound to the checkout's branch.
    const drifted = (thread: OrchestrationV2ThreadShell) =>
      thread.branch !== null && thread.branch !== branch;
    const shell = yield* threads.getShellSnapshot({ location: "active" });
    // Only a drifted thread has anything to follow, and only a busy one defers
    // it; both resolve wherever they run.
    const candidates = shell.threads.filter(
      (thread) => drifted(thread) || isThreadBusyOnCheckoutFork(thread),
    );
    const checkouts = yield* resolveCheckouts(candidates);
    const sharing = candidates.filter((thread) => checkouts.get(thread.id)?.root === root);
    if (sharing.some(isThreadBusyOnCheckoutFork)) return markHeadChanged(root, true);
    // The managed session labels the checkout's branch, so an idle checkout
    // with threads reconciles it even when no thread drifted. Finding those
    // threads resolves only cwds inside this checkout, never every checkout.
    if (sharing.length === 0) {
      const rest = shell.threads.filter((thread) => !candidates.includes(thread));
      const others = yield* resolveCheckouts(rest, [root, cwd]);
      if (!rest.some((thread) => others.get(thread.id)?.root === root)) return;
    }
    if (Option.isSome(zmux)) {
      const reconciliation = yield* zmux.value.reconcileExisting(cwd);
      if (reconciliation.status === "failed") {
        markHeadChanged(root, true);
        yield* Effect.logWarning("checkout HEAD follow could not reconcile managed session", {
          cwd,
          detail: reconciliation.notice.detail,
        });
        return;
      }
    }
    for (const thread of sharing) {
      if (!drifted(thread)) continue;
      // A thread renamed or moved since the snapshot keeps its new state; the
      // rest still follow.
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`server:checkout-head-follow:${thread.id}:${yield* newUuid}`),
          threadId: thread.id,
          expectedWorktreePath: thread.worktreePath,
          expectedBranch: thread.branch,
          branch: branch as NonNullable<OrchestrationV2ThreadShell["branch"]>,
        })
        .pipe(
          Effect.andThen(
            Effect.logInfo("thread branch followed checkout HEAD", {
              threadId: thread.id,
              previousBranch: thread.branch,
              branch,
            }),
          ),
          // A refused update, a conflict included, leaves the next run's end
          // to retry from a fresh snapshot.
          Effect.catchCause((cause) =>
            Effect.sync(() => markHeadChanged(root, true)).pipe(
              Effect.andThen(
                logFailure("thread branch could not follow checkout HEAD", {
                  threadId: thread.id,
                  branch,
                })(cause),
              ),
            ),
          ),
        );
    }
  });

  /** A follow cut short leaves the next run's end to finish it. */
  const followCheckout = (cwd: string, root: string) =>
    followLocked(cwd, root).pipe(
      Effect.onError(() => Effect.sync(() => markHeadChanged(root, true))),
    );

  const follow = (cwd: string) =>
    checkoutRootOf(cwd).pipe(
      Effect.flatMap((root) =>
        Option.isNone(root)
          ? Effect.void
          : coordinator.withLease(root.value, followCheckout(cwd, root.value)),
      ),
      Effect.catchCause(logFailure("failed to follow checkout HEAD", { cwd })),
    );

  // Watchers follow the thread topology: a thread created, removed, or moved
  // to another checkout re-syncs them. Projects never change workspace root in
  // the domain stream, so thread events cover every checkout a thread runs in.
  const knownWorktrees = new Map<ThreadId, string | null>();
  const syncedCheckouts = new Map<ThreadId, SyncedCheckout>();

  /**
   * A run's end has nothing to follow when its thread is still on the checkout
   * it last synced to, a watcher holds that checkout, and HEAD has not moved
   * since the checkout's last follow; the watcher follows any later change.
   */
  const runEndedOnSettledCheckout = (threadId: ThreadId) => {
    const synced = syncedCheckouts.get(threadId);
    return (
      synced !== undefined &&
      knownWorktrees.get(threadId) === synced.worktreePath &&
      watched.get(synced.root)?.headChanged === false
    );
  };

  const runWorker = yield* makeDrainableWorker((threadId: ThreadId) =>
    runEndedOnSettledCheckout(threadId)
      ? Effect.void
      : threads.getThreadShell(threadId).pipe(
          Effect.flatMap((thread) => (thread === null ? Effect.void : threadCwd(thread))),
          Effect.flatMap((cwd) => (cwd === undefined ? Effect.void : follow(cwd))),
          Effect.catchCause(logFailure("failed to follow checkout HEAD after a run", { threadId })),
        ),
  );

  const watchCheckoutHead = Effect.fn("CheckoutHeadFollowFork.watchCheckoutHead")(function* (
    root: string,
    cwd: string,
  ) {
    if (watched.has(root)) return;
    const gitDirResult = yield* git(root, "CheckoutHeadFollowFork.gitDir", [
      "rev-parse",
      "--git-dir",
    ]);
    const rawGitDir = gitDirResult.stdout.trim();
    if (gitDirResult.exitCode !== 0 || rawGitDir === "") return;
    const gitDir = path.resolve(root, rawGitDir);
    const ready = yield* Deferred.make<boolean>();
    const entry: WatchedCheckout = { cwd, token: {}, headChanged: true };
    watched.set(root, entry);
    const release = Effect.sync(() => {
      if (watched.get(root)?.token === entry.token) watched.delete(root);
    });
    entry.fiber = yield* Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* Queue.unbounded<void, Cause.Done>();
        const watcher = yield* Effect.acquireRelease(
          Effect.try(() =>
            watchDirectory(gitDir, (_event, filename) => {
              if (filename === null || path.basename(filename.toString()) === "HEAD") {
                entry.headChanged = true;
                Queue.offerUnsafe(changes, undefined);
              }
            }),
          ),
          (watcher) => Effect.sync(() => watcher.close()),
        );
        // A watcher error ends the stream and frees the checkout for the next sync.
        watcher.on("error", () => Queue.endUnsafe(changes));
        yield* Deferred.succeed(ready, true);
        yield* Stream.fromQueue(changes).pipe(
          Stream.debounce(Duration.millis(75)),
          Stream.runForEach(() =>
            coordinator
              .withLease(
                root,
                // Refreshing also pushes the external branch change to clients.
                vcsStatus
                  .refreshLocalStatus(cwd)
                  .pipe(Effect.ignore, Effect.andThen(followCheckout(cwd, root))),
              )
              .pipe(Effect.catchCause(logFailure("failed to follow checkout HEAD", { cwd }))),
          ),
        );
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Deferred.succeed(ready, false).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
      Effect.catchCause(logFailure("checkout HEAD watcher stopped", { root })),
      Effect.ensuring(release),
      Effect.forkScoped({ startImmediately: true }),
    );
    // A failed acquisition leaves the checkout unwatched, so the next topology
    // change retries it.
    if (!(yield* Deferred.await(ready))) yield* release;
  });

  const syncWatchers = Effect.fn("CheckoutHeadFollowFork.syncWatchers")(function* () {
    const shell = yield* threads.getShellSnapshot({ location: "active" });
    // A thread keeps the checkout it resolved to until its worktree changes,
    // so a topology change resolves only the threads it touched.
    const moved = shell.threads.filter(
      (thread) => syncedCheckouts.get(thread.id)?.worktreePath !== thread.worktreePath,
    );
    const resolved = yield* resolveCheckouts(moved);
    const movedIds = new Set(moved.map((thread) => thread.id));
    const current = new Map<ThreadId, SyncedCheckout>();
    for (const thread of shell.threads) {
      const checkout = movedIds.has(thread.id)
        ? resolved.get(thread.id)
        : syncedCheckouts.get(thread.id);
      if (checkout !== undefined)
        current.set(thread.id, { worktreePath: thread.worktreePath, ...checkout });
    }
    syncedCheckouts.clear();
    const desired = new Map<string, string>();
    for (const [threadId, checkout] of current) {
      syncedCheckouts.set(threadId, checkout);
      if (!desired.has(checkout.root)) desired.set(checkout.root, checkout.cwd);
    }
    for (const [root, entry] of watched) {
      if (desired.get(root) === entry.cwd) continue;
      watched.delete(root);
      if (entry.fiber) yield* Fiber.interrupt(entry.fiber);
    }
    yield* Effect.forEach(desired, ([root, cwd]) => watchCheckoutHead(root, cwd), {
      discard: true,
    });
    // A thread new to a checkout has not followed its HEAD yet.
    for (const thread of moved) {
      const checkout = current.get(thread.id);
      if (checkout !== undefined) markHeadChanged(checkout.root, true);
    }
  });

  const watcherWorker = yield* makeDrainableWorker(() =>
    syncWatchers().pipe(Effect.catchCause(logFailure("checkout HEAD watcher sync failed", {}))),
  );

  yield* forkParked(
    Effect.gen(function* () {
      const shell = yield* threads.getShellSnapshot({ location: "active" });
      for (const thread of shell.threads) knownWorktrees.set(thread.id, thread.worktreePath);
      yield* watcherWorker.enqueue(undefined);
    }).pipe(Effect.catchCause(logFailure("checkout HEAD watcher startup skipped", {}))),
  );
  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) => {
      if (event.type === "run.updated") {
        return ThreadManagement.isTerminalRunStatus(event.payload.status)
          ? runWorker.enqueue(event.threadId)
          : Effect.void;
      }
      if (event.type === "thread.deleted" || event.type === "thread.archived") {
        knownWorktrees.delete(event.threadId);
        return watcherWorker.enqueue(undefined);
      }
      if (
        event.type === "thread.created" ||
        event.type === "thread.unarchived" ||
        event.type === "thread.metadata-updated"
      ) {
        const worktreePath = event.payload.worktreePath;
        if (
          knownWorktrees.has(event.threadId) &&
          knownWorktrees.get(event.threadId) === worktreePath
        ) {
          return Effect.void;
        }
        knownWorktrees.set(event.threadId, worktreePath);
        return watcherWorker.enqueue(undefined);
      }
      return Effect.void;
    }).pipe(Effect.catchCause(logFailure("checkout HEAD event stream failed", {}))),
  );

  return CheckoutHeadFollowFork.of({
    follow,
    drain: Effect.all([runWorker.drain, watcherWorker.drain], { discard: true }),
  });
});

/** Server-lifetime service: one watcher per checkout any active thread runs in. */
export const checkoutHeadFollowLiveFork = Layer.effect(CheckoutHeadFollowFork, make);
