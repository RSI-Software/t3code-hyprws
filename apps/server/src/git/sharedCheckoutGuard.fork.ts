import {
  GitCommandError,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { CheckoutMutationCoordinator } from "./CheckoutMutationCoordinator.ts";
import * as GitWorkflow from "./GitWorkflowService.ts";
import { resolveTurnCheckoutFork } from "./turnStartCheckoutLease.fork.ts";

/**
 * A thread is busy on its checkout from the moment its run is queued until the
 * run settles; a run waiting on a runtime request still owns the checkout.
 */
export const isThreadBusyOnCheckoutFork = (
  thread: Pick<OrchestrationV2ThreadShell, "activeRunId" | "activityRunStatus" | "status">,
) =>
  thread.activeRunId !== null ||
  (thread.activityRunStatus ?? null) !== null ||
  thread.status === "queued";

const guardError = (cwd: string, detail: string, cause?: unknown) =>
  new GitCommandError({
    operation: "vcs.branch.change",
    command: "shared-checkout-guard",
    cwd,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const makeSharedCheckout = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const coordinator = yield* CheckoutMutationCoordinator;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const threadCwd = (thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  }) =>
    thread.worktreePath !== null
      ? Effect.succeed<string | undefined>(thread.worktreePath)
      : projects
          .getShell(thread.projectId)
          .pipe(Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot));

  const sharesCheckout = (thread: OrchestrationV2ThreadShell, rootPath: string) =>
    threadCwd(thread).pipe(
      Effect.flatMap((cwd) =>
        cwd === undefined
          ? Effect.succeed(false)
          : registry
              .resolve({ cwd })
              .pipe(Effect.map((candidate) => candidate.repository.rootPath === rootPath)),
      ),
      Effect.orElseSucceed(() => false),
    );

  return { registry, coordinator, threadCwd, sharesCheckout };
});

/**
 * Wraps branch creation and switching so they refuse while any thread sharing
 * the checkout is busy. The check runs again under the checkout lease, which
 * client turn starts also take, so no turn can start between the check and the
 * Git operation.
 */
const makeSharedCheckoutBranchGuardFork = Effect.gen(function* () {
  const { registry, coordinator, sharesCheckout } = yield* makeSharedCheckout;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const guard = Effect.fn("SharedCheckoutFork.guardBranchMutation")(function* (cwd: string) {
    const checkout = yield* registry
      .resolve({ cwd })
      .pipe(
        Effect.mapError((cause) => guardError(cwd, "Could not identify this Git checkout.", cause)),
      );
    const rootPath = checkout.repository.rootPath;
    const shell = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(
        Effect.mapError((cause) =>
          guardError(cwd, "Could not verify whether this checkout is idle.", cause),
        ),
      );
    const busy = yield* Effect.filter(
      shell.threads.filter(isThreadBusyOnCheckoutFork),
      (thread) => sharesCheckout(thread, rootPath),
      { concurrency: "unbounded" },
    );
    if (busy.length > 0) {
      return yield* guardError(
        cwd,
        "Wait for active turns sharing this checkout to finish before changing branch.",
      );
    }
    return rootPath;
  });

  return <A, R>(cwd: string, mutation: Effect.Effect<A, GitCommandError, R>) =>
    guard(cwd).pipe(
      Effect.flatMap((rootPath) =>
        coordinator.withLease(rootPath, guard(cwd).pipe(Effect.andThen(mutation))),
      ),
    );
});

/**
 * Wraps a client message dispatch in the lease of the checkout its thread runs
 * in, so a turn start and a branch change on the same checkout never overlap.
 * A thread with a checkout move in flight refuses new turns.
 */
const makeTurnStartCheckoutLeaseFork = Effect.gen(function* () {
  const { registry, coordinator, threadCwd } = yield* makeSharedCheckout;

  return <A, R>(
    threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
    command: OrchestrationV2ServerCommand,
    dispatch: Effect.Effect<A, Orchestrator.OrchestratorV2Error, R>,
  ) => {
    if (command.type !== "message.dispatch") return dispatch;
    const reject = (cause: unknown) =>
      new Orchestrator.OrchestratorCommandRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      });
    return Effect.gen(function* () {
      const thread = yield* threads.getThreadShell(command.threadId);
      if (thread === null) return yield* dispatch;
      // A move waits for the thread to go idle; a new turn would starve it.
      if (thread.checkoutMove?.status === "queued" || thread.checkoutMove?.status === "preparing") {
        return yield* reject(`Thread ${thread.id} has a checkout move in progress.`);
      }
      const cwd = yield* threadCwd(thread).pipe(Effect.mapError(reject));
      if (cwd === undefined) return yield* dispatch;
      const checkout = yield* resolveTurnCheckoutFork(registry, cwd).pipe(Effect.mapError(reject));
      return yield* coordinator.withLease(checkout.repository.rootPath, dispatch);
    });
  };
});

/**
 * Supplies the WebSocket handlers with lease-aware thread dispatch and Git
 * branch mutations, and refuses client-forged checkout move state. Only the
 * client transport is wrapped, as before the Orchestrator V2 port.
 */
export const sharedCheckoutWsLayerFork = Layer.mergeAll(
  Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const inner = yield* ThreadManagement.ThreadManagementService;
      const withTurnStartLease = yield* makeTurnStartCheckoutLeaseFork;
      return ThreadManagement.ThreadManagementService.of({
        ...inner,
        dispatch: (command) =>
          // Move state is server-resolved; a client may only request a move.
          command.type === "thread.metadata.update" && command.checkoutMove !== undefined
            ? Effect.fail(
                new Orchestrator.OrchestratorCommandRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "Checkout moves are requested through thread.checkoutMove.request.",
                }),
              )
            : withTurnStartLease(inner, command, inner.dispatch(command)),
      });
    }),
  ),
  Layer.effect(
    GitWorkflow.GitWorkflowService,
    Effect.gen(function* () {
      const inner = yield* GitWorkflow.GitWorkflowService;
      const withBranchGuard = yield* makeSharedCheckoutBranchGuardFork;
      return GitWorkflow.GitWorkflowService.of({
        ...inner,
        createRef: (input) =>
          input.switchRef === true
            ? withBranchGuard(input.cwd, inner.createRef(input))
            : inner.createRef(input),
        switchRef: (input) => withBranchGuard(input.cwd, inner.switchRef(input)),
      });
    }),
  ),
);
