// Fork-only (zmux-estate): moves a thread to another checkout of the same
// repository. The move's durable state rides on the thread payload through
// `thread.metadata.update`; a move requested during a run waits as `queued`
// and commits once the thread is idle, including after a server restart.
import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type ThreadCheckoutMove,
  ThreadCheckoutMoveError,
  type ThreadCheckoutMoveRequestInput,
  type ThreadCheckoutMoveRequestResult,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { layerEventSink } from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { CheckoutMutationCoordinator } from "./CheckoutMutationCoordinator.ts";
import {
  CheckoutMoveValidationError,
  isThreadBusyOnCheckoutFork,
  resolveCheckoutPhysicalIdentity,
  sameCheckoutIdentity,
  withVerifiedCheckoutMove,
} from "./checkoutMoveIdentity.fork.ts";
import { isCheckoutMoveInFlightFork, makeCheckoutRecoveryFork } from "./checkoutRecovery.fork.ts";

export { isCheckoutMoveInFlightFork };

export class CheckoutMoveServiceFork extends Context.Service<
  CheckoutMoveServiceFork,
  {
    readonly request: (
      input: ThreadCheckoutMoveRequestInput,
    ) => Effect.Effect<ThreadCheckoutMoveRequestResult, ThreadCheckoutMoveError>;
    /**
     * Recovers an idle thread whose worktree was removed outside T3 before a
     * client turn starts there: recreates it from its branch, or moves the
     * thread to its project root. Returns the shell the turn runs on.
     */
    readonly recoverRemovedWorktree: (
      thread: OrchestrationV2ThreadShell,
    ) => Effect.Effect<OrchestrationV2ThreadShell>;
    /** Resolves once every move enqueued so far was processed. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/git/CheckoutMoveService.fork/CheckoutMoveServiceFork") {}

const failureDetail = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  const detail = Schema.is(CheckoutMoveValidationError)(error)
    ? error.reason
    : error instanceof Error
      ? error.message
      : String(error);
  return detail.trim() || "Checkout move failed.";
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const eventSink = yield* EventSink.EventSinkV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const { workspaceRootOf, activeOnCheckout, recoverRemovedWorktree } =
    yield* makeCheckoutRecoveryFork;
  // The identity helpers resolve these per call; capture them once so the
  // service methods need nothing from their caller.
  const services = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | VcsDriverRegistry.VcsDriverRegistry
    | CheckoutMutationCoordinator
  >();

  const pending = new Set<ThreadId>();
  const newUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const realPath = (path: string) =>
    fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const samePath = (left: string, right: string) =>
    left === right
      ? Effect.succeed(true)
      : Effect.all([realPath(left), realPath(right)]).pipe(Effect.map(([a, b]) => a === b));
  /** Writes the move, checked against the worktree the caller last read. */
  const writeMove = Effect.fn("CheckoutMoveServiceFork.writeMove")(function* (
    thread: Pick<OrchestrationV2ThreadShell, "id" | "worktreePath">,
    checkoutMove: ThreadCheckoutMove,
    checkout?: { readonly branch: string | null; readonly worktreePath: string | null },
  ) {
    const uuid = yield* newUuid;
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`server:checkout-move:${thread.id}:${uuid}`),
      threadId: thread.id,
      expectedWorktreePath: thread.worktreePath,
      checkoutMove,
      ...(checkout === undefined
        ? {}
        : {
            branch: checkout.branch as OrchestrationV2ThreadShell["branch"],
            worktreePath: checkout.worktreePath as OrchestrationV2ThreadShell["worktreePath"],
          }),
    });
  });

  const commit = Effect.fn("CheckoutMoveServiceFork.commit")(function* (
    threadId: ThreadId,
    move: ThreadCheckoutMove & {
      readonly destination: NonNullable<ThreadCheckoutMove["destination"]>;
    },
  ) {
    yield* withVerifiedCheckoutMove({
      sourcePath: move.source.checkoutRoot,
      destinationPath: move.destination.checkoutRoot,
      effect: (source, destination) =>
        Effect.gen(function* () {
          if (
            !sameCheckoutIdentity(source, move.source) ||
            !sameCheckoutIdentity(destination, move.destination)
          ) {
            return yield* new CheckoutMoveValidationError({
              reason: "checkout identity changed before transition",
            });
          }
          const owned = yield* threads.getThreadShell(threadId);
          if (owned === null || owned.checkoutMove?.requestId !== move.requestId) {
            return yield* new CheckoutMoveValidationError({
              reason: "checkout move ownership changed before transition",
            });
          }
          if (owned.worktreePath !== (move.sourceThreadWorktreePath ?? null)) {
            return yield* new CheckoutMoveValidationError({
              reason: "thread metadata changed during move preparation",
            });
          }
          const now = yield* nowIso;
          // A run can start between the idle check and the leases; wait for it.
          if (isThreadBusyOnCheckoutFork(owned)) {
            yield* writeMove(owned, { ...move, status: "queued", updatedAt: now });
            return;
          }
          const roots = [...new Set([source.checkoutRoot, destination.checkoutRoot])];
          const activeThreadId = yield* activeOnCheckout(threadId, roots);
          if (activeThreadId !== null) {
            return yield* new CheckoutMoveValidationError({
              reason: `checkout is active on thread ${activeThreadId}`,
            });
          }
          const workspaceRoot = yield* workspaceRootOf(owned);
          const toProjectRoot =
            workspaceRoot !== undefined &&
            (yield* samePath(destination.checkoutRoot, workspaceRoot));
          // One update moves the thread; the decider detaches its provider
          // sessions, so the next turn starts in the destination. A turn from
          // a starter outside the client lease (queue, MCP, schedule, wake)
          // can still begin after the idle check: the decider then refuses
          // the commit and the move waits for that run.
          yield* writeMove(
            owned,
            {
              ...move,
              status: "committed",
              completedSteps: ["metadata"],
              effectiveProvider: null,
              updatedAt: now,
            },
            {
              branch: destination.branch,
              worktreePath: toProjectRoot ? null : destination.checkoutRoot,
            },
          ).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                const latest = yield* threads.getThreadShell(threadId);
                if (
                  latest === null ||
                  latest.checkoutMove?.requestId !== move.requestId ||
                  !isThreadBusyOnCheckoutFork(latest)
                ) {
                  return yield* error;
                }
                yield* writeMove(latest, { ...move, status: "queued", updatedAt: yield* nowIso });
              }),
            ),
          );
        }),
    });
  });

  /** Records a move that could not proceed, unless another request replaced it. */
  const recordFailure = (
    threadId: ThreadId,
    move: ThreadCheckoutMove,
    cause: Cause.Cause<unknown>,
  ) =>
    Effect.gen(function* () {
      const latest = yield* threads.getThreadShell(threadId);
      if (latest === null || latest.checkoutMove?.requestId !== move.requestId) return;
      if (!isCheckoutMoveInFlightFork(latest.checkoutMove)) return;
      yield* writeMove(latest, {
        ...move,
        status: "failed",
        detail: failureDetail(cause) as NonNullable<ThreadCheckoutMove["detail"]>,
        updatedAt: yield* nowIso,
      });
    });

  const advance = Effect.fn("CheckoutMoveServiceFork.advance")(function* (
    thread: OrchestrationV2ThreadShell,
    move: ThreadCheckoutMove & {
      readonly destination: NonNullable<ThreadCheckoutMove["destination"]>;
    },
  ) {
    if (isThreadBusyOnCheckoutFork(thread)) {
      if (move.status === "preparing") {
        yield* writeMove(thread, { ...move, status: "queued", updatedAt: yield* nowIso });
      }
      return;
    }
    const preparing = { ...move, status: "preparing" as const };
    if (move.status === "queued") {
      yield* writeMove(thread, { ...preparing, updatedAt: yield* nowIso });
    }
    yield* commit(thread.id, preparing);
  });

  const process = Effect.fn("CheckoutMoveServiceFork.process")(function* (threadId: ThreadId) {
    const thread = yield* threads.getThreadShell(threadId);
    const move = thread?.checkoutMove;
    if (thread === null || move === undefined || !isCheckoutMoveInFlightFork(move)) {
      pending.delete(threadId);
      return;
    }
    const destination = move.destination;
    if (destination === null) {
      pending.delete(threadId);
      return;
    }
    // Every step records its failure on the move: a move left in flight
    // refuses the thread's next turn and any other move request.
    yield* advance(thread, { ...move, destination }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : recordFailure(threadId, { ...move, destination }, cause),
      ),
    );
    const settled = yield* threads.getThreadShell(threadId);
    if (!isCheckoutMoveInFlightFork(settled?.checkoutMove)) pending.delete(threadId);
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    process(threadId).pipe(
      Effect.provide(services),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("checkout move processing failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );
  const enqueue = (threadId: ThreadId) =>
    Effect.suspend(() => {
      pending.add(threadId);
      return worker.enqueue(threadId);
    });

  // One request per thread at a time, from its in-flight check to its write.
  const requests = yield* KeyedLock.make<ThreadId>();
  const request = Effect.fn("CheckoutMoveServiceFork.request")(function* (
    input: ThreadCheckoutMoveRequestInput,
  ) {
    const refuse = (detail: string) => (cause?: unknown) =>
      new ThreadCheckoutMoveError({
        threadId: input.threadId,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const thread = yield* threads
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(refuse("Could not read the thread.")));
    if (thread === null) return yield* refuse("Checkout move thread was not found")();
    const workspaceRoot = yield* workspaceRootOf(thread);
    if (workspaceRoot === undefined) return yield* refuse("Checkout move project was not found")();

    const current = thread.checkoutMove;
    if (input.requestId !== undefined && current?.requestId === input.requestId) {
      if (
        current.requestedPath !== input.requestedPath ||
        current.expectedCheckoutRoot !== input.expectedCheckoutRoot ||
        current.reverseOfRequestId !== input.reverseOfRequestId
      ) {
        return yield* refuse("Checkout move request identity was reused with different input")();
      }
      // A replay also resumes a move whose processing was lost.
      if (isCheckoutMoveInFlightFork(current)) yield* enqueue(thread.id);
      return { requestId: current.requestId, status: current.status };
    }
    if (isCheckoutMoveInFlightFork(current)) {
      return yield* refuse("A checkout move is already in progress for this thread")();
    }

    const sourcePath = thread.worktreePath ?? workspaceRoot;
    if (!(yield* samePath(input.expectedCheckoutRoot, sourcePath))) {
      return yield* refuse("Checkout move context changed; refresh and retry")();
    }
    const identityFailed = refuse("Checkout move identity validation failed");
    const [source, destination] = yield* Effect.all([
      resolveCheckoutPhysicalIdentity(sourcePath),
      resolveCheckoutPhysicalIdentity(input.requestedPath),
    ]).pipe(Effect.mapError(identityFailed));
    if (source.repositoryRoot !== destination.repositoryRoot) {
      return yield* refuse(
        "Checkout move identity validation failed: the destination belongs to another repository",
      )();
    }
    if (input.reverseOfRequestId !== undefined) {
      if (
        current?.requestId !== input.reverseOfRequestId ||
        current.status !== "committed" ||
        current.destination === null ||
        !sameCheckoutIdentity(current.destination, source) ||
        !sameCheckoutIdentity(current.source, destination)
      ) {
        return yield* refuse("The reverse move no longer matches the effective checkout")();
      }
    }

    const requestId =
      input.requestId ?? CommandId.make(`server:checkout-move:${thread.id}:${yield* newUuid}`);
    const now = yield* nowIso;
    const move: ThreadCheckoutMove = {
      requestId,
      source,
      sourceThreadBranch: thread.branch,
      sourceThreadWorktreePath: thread.worktreePath,
      requestedPath: input.requestedPath,
      destination,
      expectedCheckoutRoot: input.expectedCheckoutRoot,
      status: isThreadBusyOnCheckoutFork(thread) ? "queued" : "preparing",
      ...(input.reverseOfRequestId === undefined
        ? {}
        : { reverseOfRequestId: input.reverseOfRequestId }),
      completedSteps: [],
      effectiveProvider: null,
      requestedAt: now,
      updatedAt: now,
    };
    yield* writeMove(thread, move).pipe(
      Effect.mapError(refuse("Checkout move context changed; refresh and retry")),
    );
    yield* enqueue(thread.id);
    return { requestId, status: move.status };
  });

  // Resume moves left in flight by a restart, archived threads included so
  // one unarchived later is not stuck; then follow run completions. One fiber
  // reads the event cursor before the scan, so a run that settles between the
  // scan's busy check and the subscription still reaches the listener.
  yield* forkParked(
    Effect.gen(function* () {
      const afterSequence = yield* eventSink.latestSequence();
      yield* Effect.all([
        threads.getShellSnapshot({ location: "active" }),
        threads.getShellSnapshot({ location: "archive" }),
      ]).pipe(
        Effect.flatMap((shells) =>
          Effect.forEach(
            shells
              .flatMap((shell) => shell.threads)
              .filter((thread) => isCheckoutMoveInFlightFork(thread.checkoutMove)),
            (thread) => enqueue(thread.id),
            { discard: true },
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("checkout move recovery skipped", { cause: Cause.pretty(cause) }),
        ),
      );
      yield* Stream.runForEach(
        eventSink.stream({ afterSequence, eventType: "run.updated" }),
        ({ event }) =>
          event.type === "run.updated" &&
          ThreadManagement.isTerminalRunStatus(event.payload.status) &&
          pending.has(event.threadId)
            ? worker.enqueue(event.threadId)
            : Effect.void,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("checkout move event stream failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  return CheckoutMoveServiceFork.of({
    request: (input) =>
      requests.withLock(input.threadId, request(input).pipe(Effect.provide(services))),
    recoverRemovedWorktree: (thread) =>
      newUuid.pipe(
        Effect.flatMap((uuid) =>
          recoverRemovedWorktree(thread, {
            recoveryId: `server:worktree-checkout-recovery:${uuid}`,
            duringRun: false,
          }),
        ),
        Effect.map((recovered) => recovered.thread),
      ),
    drain: worker.drain,
  });
});

/** The service over a caller-provided event sink. */
export const checkoutMoveServiceLayerFork = Layer.effect(CheckoutMoveServiceFork, make);

/**
 * Server-lifetime service: one queue and one event subscription for every
 * client. The listener reads its cursor from the orchestrator's own event sink;
 * layer memoization shares that one instance.
 */
export const checkoutMoveServiceLiveFork = checkoutMoveServiceLayerFork.pipe(
  Layer.provide(layerEventSink),
);

/** Spread into the WebSocket handler table through `zmux-estate/ws-checkout-move-handlers`. */
export const checkoutMoveRpcHandlersFork = (checkoutMoves: CheckoutMoveServiceFork["Service"]) => ({
  "thread.checkoutMove.request": (input: ThreadCheckoutMoveRequestInput) =>
    checkoutMoves.request(input),
});
