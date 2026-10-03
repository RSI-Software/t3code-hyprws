// Fork-only (zmux-estate): which threads occupy a checkout, and the recovery of
// a thread whose worktree was removed outside T3. Client turn starts recover
// before dispatch and every other turn recovers in the turn-start gate, so both
// share this one implementation.
import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type ThreadCheckoutMove,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { CheckoutMutationCoordinator } from "./CheckoutMutationCoordinator.ts";
import {
  isThreadBusyOnCheckoutFork,
  resolveCheckoutPhysicalIdentity,
} from "./checkoutMoveIdentity.fork.ts";
import * as GitWorkflow from "./GitWorkflowService.ts";

export const isCheckoutMoveInFlightFork = (move: ThreadCheckoutMove | undefined) =>
  move?.status === "queued" || move?.status === "preparing";

export const makeCheckoutRecoveryFork = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const coordinator = yield* CheckoutMutationCoordinator;
  // The identity helpers resolve these per call; capture them once so the
  // returned functions need nothing from their caller.
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | VcsDriverRegistry.VcsDriverRegistry
  >();
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const workspaceRootOf = (thread: Pick<OrchestrationV2ThreadShell, "projectId">) =>
    projects.getShell(thread.projectId).pipe(
      Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
      Effect.orElseSucceed(() => undefined),
    );

  /** The first other thread busy on one of `checkoutRoots`, or null. */
  const activeOnCheckout = Effect.fn("CheckoutRecoveryFork.activeOnCheckout")(function* (
    threadId: ThreadId,
    checkoutRoots: ReadonlyArray<string>,
  ) {
    const shell = yield* threads.getShellSnapshot({ location: "active" });
    for (const candidate of shell.threads) {
      if (candidate.id === threadId || !isThreadBusyOnCheckoutFork(candidate)) continue;
      const cwd = candidate.worktreePath ?? (yield* workspaceRootOf(candidate));
      if (cwd === undefined) continue;
      // A candidate whose worktree is gone owns no live checkout.
      const identity = yield* resolveCheckoutPhysicalIdentity(cwd).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (identity !== null && checkoutRoots.includes(identity.checkoutRoot)) return candidate.id;
    }
    return null;
  }, Effect.provide(services));

  const recreateWorktree = (workspaceRoot: string, branch: string, path: string) =>
    gitWorkflow
      .pruneWorktrees({ cwd: workspaceRoot })
      .pipe(
        Effect.andThen(gitWorkflow.createWorktree({ cwd: workspaceRoot, refName: branch, path })),
        Effect.andThen(fileSystem.exists(path)),
      );

  const moveToProjectRoot = Effect.fn("CheckoutRecoveryFork.moveToProjectRoot")(function* (
    thread: OrchestrationV2ThreadShell,
    deadPath: string,
    workspaceRoot: string,
    recoveryId: string,
  ) {
    const root = yield* resolveCheckoutPhysicalIdentity(workspaceRoot);
    const now = yield* nowIso;
    const requestId = CommandId.make(recoveryId);
    const move: ThreadCheckoutMove = {
      requestId,
      source: root,
      sourceThreadBranch: thread.branch,
      sourceThreadWorktreePath: deadPath,
      reason: "worktree-recovery",
      requestedPath: root.checkoutRoot,
      destination: root,
      expectedCheckoutRoot: deadPath,
      status: "committed",
      completedSteps: ["metadata"],
      effectiveProvider: null,
      requestedAt: now,
      updatedAt: now,
    };
    return yield* coordinator.withLease(
      root.checkoutRoot,
      Effect.gen(function* () {
        // A thread already running in the root keeps it; this turn then
        // stops on the missing worktree and a resend retries the recovery.
        const owner = yield* activeOnCheckout(thread.id, [root.checkoutRoot]);
        yield* threads.dispatch({
          type: "thread.metadata.update",
          // The turn-start gate retries a run under one recovery id; a refusal
          // sharing the commit's command id would replay the commit as a no-op.
          commandId: owner === null ? requestId : CommandId.make(`${recoveryId}:refused`),
          threadId: thread.id,
          expectedWorktreePath: deadPath as OrchestrationV2ThreadShell["worktreePath"],
          ...(owner === null
            ? {
                checkoutMove: move,
                branch: root.branch as OrchestrationV2ThreadShell["branch"],
                worktreePath: null,
              }
            : {
                checkoutMove: {
                  ...move,
                  status: "failed",
                  completedSteps: [],
                  detail: `checkout is active on thread ${owner}` as NonNullable<
                    ThreadCheckoutMove["detail"]
                  >,
                },
              }),
        });
        if (owner !== null) return false;
        yield* Effect.logInfo(
          `Worktree ${deadPath} no longer exists; moved this thread to ${root.checkoutRoot} on ${root.branch ?? "a detached HEAD"}`,
        ).pipe(Effect.annotateLogs({ threadId: thread.id }));
        return true;
      }),
    );
  }, Effect.provide(services));

  /**
   * Recovers a thread whose recorded worktree no longer exists: recreates it
   * from the recorded branch, and moves the thread to its project root when
   * that fails or no branch is recorded. Returns whether the thread moved and
   * the shell the turn runs on. `duringRun` admits the thread's own starting
   * run; otherwise a busy thread is left alone.
   */
  const recoverRemovedWorktree = Effect.fn("CheckoutRecoveryFork.recoverRemovedWorktree")(
    function* (
      thread: OrchestrationV2ThreadShell,
      options: { readonly recoveryId: string; readonly duringRun: boolean },
    ) {
      const unchanged = { moved: false, thread };
      const deadPath = thread.worktreePath;
      if (
        deadPath === null ||
        (!options.duringRun && isThreadBusyOnCheckoutFork(thread)) ||
        isCheckoutMoveInFlightFork(thread.checkoutMove) ||
        (yield* fileSystem.exists(deadPath).pipe(Effect.orElseSucceed(() => true)))
      ) {
        return unchanged;
      }
      const workspaceRoot = yield* workspaceRootOf(thread);
      if (workspaceRoot === undefined) return unchanged;
      if (thread.branch !== null) {
        const recreated = yield* recreateWorktree(workspaceRoot, thread.branch, deadPath).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("worktree recovery could not recreate the worktree", {
                  threadId: thread.id,
                  worktreePath: deadPath,
                  branch: thread.branch,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(false)),
          ),
        );
        // A concurrent recovery may have recreated it first, failing this create.
        if (
          recreated ||
          (yield* fileSystem.exists(deadPath).pipe(Effect.orElseSucceed(() => false)))
        )
          return unchanged;
      }
      const moved = yield* moveToProjectRoot(thread, deadPath, workspaceRoot, options.recoveryId);
      return { moved, thread: (yield* threads.getThreadShell(thread.id)) ?? thread };
    },
    (effect, thread) =>
      // Recovery is best effort: the turn then stops on the missing worktree.
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("worktree recovery could not move thread to project root", {
                threadId: thread.id,
                worktreePath: thread.worktreePath,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as({ moved: false, thread })),
        ),
      ),
  );

  return { workspaceRootOf, activeOnCheckout, recoverRemovedWorktree };
});
