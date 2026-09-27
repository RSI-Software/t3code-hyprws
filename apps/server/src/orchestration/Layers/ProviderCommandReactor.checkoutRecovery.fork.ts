// Fork-owned worktree recovery for `ProviderCommandReactor.ts`: a thread whose
// worktree and branch were removed outside T3 moves back to its project's root
// checkout through the fork's checkout-move path, so the pending turn can run.
import {
  CommandId,
  EventId,
  type OrchestrationThreadShell,
  type ThreadCheckoutMove,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { resolveCheckoutPhysicalIdentity } from "../CheckoutMoveCoordinator.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "../ThreadSettlementPolicy.ts";

type CheckoutMoveRunner<E, R> = (
  threadId: ThreadId,
  move: ThreadCheckoutMove,
  createdAt: string,
) => Effect.Effect<void, E, R>;

type WorktreeRepair<E, R> = (
  thread: OrchestrationThreadShell,
) => Effect.Effect<string | null, E, R>;

export const checkoutRecoveryFork = (
  orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">,
  projectionSnapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    "getProjectShellById" | "getThreadShellById"
  >,
  crypto: Pick<Crypto.Crypto, "randomUUIDv4">,
) => {
  // Moves this module runs inline; the move worker leaves them alone so it
  // cannot requeue them behind the very turn that triggered them.
  const inlineRequestIds = new Set<CommandId>();
  // Shells moved by `repair`, read once by `turnThread` for the same turn.
  const movedShells = new Map<ThreadId, OrchestrationThreadShell>();
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const threadShell = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadShellById(threadId).pipe(Effect.map(Option.getOrUndefined));

  /** The move worker's entry: skips a move recovery is running inline. */
  const workerRun = <E, R>(
    runMove: CheckoutMoveRunner<E, R>,
    job: {
      readonly threadId: ThreadId;
      readonly move: ThreadCheckoutMove;
      readonly createdAt: string;
    },
  ) =>
    inlineRequestIds.has(job.move.requestId)
      ? Effect.void
      : runMove(job.threadId, job.move, job.createdAt);

  /**
   * Whether a pending turn start keeps the move from running now. An inline
   * recovery move bypasses only the moving thread's own pending turn: this
   * check sees the moving thread, never an owner candidate.
   */
  const pendingTurnBlocks = (
    thread: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "session">,
    createdAt: string,
    requestId: CommandId,
  ) => !inlineRequestIds.has(requestId) && threadHasQueuedTurnStart(thread, createdAt);

  /**
   * The checkout identity an owner scan compares. A candidate whose worktree
   * no longer exists owns no live checkout, so its dead path stands in as an
   * identity that matches nothing instead of failing the scan.
   */
  const ownerIdentity = (cwd: string) =>
    resolveCheckoutPhysicalIdentity(cwd).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const exists = yield* fs.exists(cwd).pipe(Effect.orElseSucceed(() => true));
          if (exists) return yield* error;
          return { repositoryRoot: cwd, checkoutRoot: cwd, revision: "", branch: null };
        }),
      ),
    );

  /** Wraps the upstream repair; null after a committed move to the project root. */
  const repair = <E, R, E2, R2>(
    thread: OrchestrationThreadShell,
    ensure: WorktreeRepair<E, R>,
    runMove: CheckoutMoveRunner<E2, R2>,
  ) =>
    Effect.gen(function* () {
      const failure = yield* ensure(thread);
      const moved = yield* recover(thread, failure, runMove);
      if (moved === null) return failure;
      movedShells.set(thread.id, moved);
      return null;
    });

  /** The shell the turn runs on: the moved one after recovery, else `thread`. */
  const turnThread = (thread: OrchestrationThreadShell) =>
    Effect.sync(() => {
      const moved = movedShells.get(thread.id);
      movedShells.delete(thread.id);
      return moved ?? thread;
    });

  /**
   * Called after the upstream worktree repair: when it failed, moves the
   * thread to the project root and returns the moved shell. Null when there
   * was nothing to recover or the move did not commit.
   */
  const recover = <E, R>(
    thread: OrchestrationThreadShell,
    repairFailure: string | null,
    runMove: CheckoutMoveRunner<E, R>,
  ) =>
    Effect.gen(function* () {
      const { worktreePath } = thread;
      if (repairFailure === null || worktreePath === null) return null;
      const project = Option.getOrUndefined(
        yield* projectionSnapshotQuery
          .getProjectShellById(thread.projectId)
          .pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (!project) return null;
      const requestId = yield* commandId("worktree-checkout-recovery");
      inlineRequestIds.add(requestId);
      return yield* Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const root = yield* resolveCheckoutPhysicalIdentity(project.workspaceRoot);
        yield* orchestrationEngine.dispatch({
          type: "thread.checkout-move.prepare",
          commandId: requestId,
          threadId: thread.id,
          requestId,
          source: root,
          sourceThreadBranch: thread.branch,
          sourceThreadWorktreePath: worktreePath,
          reason: "worktree-recovery",
          destination: root,
          queued: false,
          createdAt,
        });
        const move = (yield* threadShell(thread.id))?.checkoutMove;
        if (!move || move.requestId !== requestId || move.status !== "preparing") return null;
        yield* runMove(thread.id, move, createdAt);
        const moved = yield* threadShell(thread.id);
        const movedTo = moved?.checkoutMove;
        if (!moved || movedTo?.requestId !== requestId || movedTo.status !== "committed") {
          return null;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: yield* commandId("worktree-checkout-recovery-activity"),
          threadId: thread.id,
          activity: {
            id: EventId.make(yield* crypto.randomUUIDv4),
            tone: "info",
            kind: "worktree.checkout-recovery",
            summary: `Worktree ${worktreePath} no longer exists; moved this thread to ${root.checkoutRoot} on ${root.branch ?? "a detached HEAD"}`,
            payload: {
              worktreePath,
              branch: thread.branch,
              checkoutRoot: root.checkoutRoot,
              checkoutBranch: root.branch,
            },
            turnId: null,
            createdAt,
          },
          createdAt,
        });
        return moved;
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("worktree recovery could not move thread to project root", {
              threadId: thread.id,
              worktreePath,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(null)),
        ),
        Effect.ensuring(Effect.sync(() => void inlineRequestIds.delete(requestId))),
      );
    }).pipe(Effect.withSpan("checkoutRecoveryFork.recover"));

  return { workerRun, pendingTurnBlocks, ownerIdentity, repair, turnThread };
};
