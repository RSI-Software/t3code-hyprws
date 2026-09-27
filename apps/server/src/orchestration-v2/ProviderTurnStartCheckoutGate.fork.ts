// Fork-only (zmux-estate): the checkout gate every provider turn start passes,
// whatever started the run: a client, the queue, MCP, a schedule, a wake or a
// continuation. It recovers a removed worktree before the session opens and
// waits out a branch change holding the checkout lease. Wired over the
// upstream turn-start service through `zmux-estate/turn-start-checkout-gate`.
import type { RunId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { CheckoutMutationCoordinator } from "../git/CheckoutMutationCoordinator.ts";
import { makeCheckoutRecoveryFork } from "../git/checkoutRecovery.fork.ts";
import { resolveTurnCheckoutFork } from "../git/turnStartCheckoutLease.fork.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { ProviderTurnStartServiceV2 } from "./ProviderTurnStartService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const providerTurnStartCheckoutGateFork = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const inner = yield* ProviderTurnStartServiceV2;
    // The server provides both; a runtime built without Git (tests, the CLI)
    // starts turns ungated, as upstream does.
    const registry = yield* Effect.serviceOption(VcsDriverRegistry.VcsDriverRegistry);
    const coordinator = yield* Effect.serviceOption(CheckoutMutationCoordinator);
    if (Option.isNone(registry) || Option.isNone(coordinator)) return inner;

    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const recovery = yield* makeCheckoutRecoveryFork.pipe(
      Effect.provideService(VcsDriverRegistry.VcsDriverRegistry, registry.value),
      Effect.provideService(CheckoutMutationCoordinator, coordinator.value),
    );

    /**
     * Recovers the thread when its worktree is gone. A client turn already
     * recovered before dispatch, so this finds the worktree in place.
     */
    const recover = Effect.fn("ProviderTurnStartCheckoutGateFork.recover")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) {
      const worktreePath = (yield* projectionStore.getThread(input.threadId)).worktreePath;
      if (worktreePath === null) return;
      if (yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true))) return;
      const { runs } = yield* projectionStore.getThreadRecords(input.threadId, ["runs"]);
      const run = runs.find((candidate) => candidate.id === input.runId);
      if (run?.status !== "starting") return;
      const thread = yield* threads.getThreadShell(input.threadId);
      if (thread === null) return;
      yield* recovery.recoverRemovedWorktree(thread, {
        recoveryId: `server:worktree-checkout-recovery:${input.runId}`,
        duringRun: true,
      });
    });

    /**
     * Detaches the thread's live sessions whose cwd no longer exists, so the
     * open below starts one in the thread's current checkout. A committed
     * recovery leaves these detaches to the turn start while a run is live,
     * whether this gate or a client committed it; a provider fixing its cwd at
     * open would otherwise reuse the removed directory.
     *
     * A session is stale while the thread's committed recovery moved it out of
     * the session's worktree, even one recreated at the same path before this
     * gate, and it stays healthy once the thread returns there. The disk check
     * covers a recovery whose marker a later queued or failed move replaced.
     * A session shared across threads passes the cwd with every turn, so its
     * own cwd is never stale.
     */
    const detachRecoveredSessions = Effect.fn(
      "ProviderTurnStartCheckoutGateFork.detachRecoveredSessions",
    )(function* (threadId: ThreadId) {
      const { worktreePath, checkoutMove } = yield* projectionStore.getThread(threadId);
      const recoveredFrom =
        checkoutMove?.status === "committed" && checkoutMove.reason === "worktree-recovery"
          ? (checkoutMove.sourceThreadWorktreePath ?? null)
          : null;
      // A recovery's detach event already unbound the sessions from the
      // thread's projection, so the provider threads name them.
      const { providerThreads } = yield* projectionStore.getThreadRecords(threadId, [
        "providerThreads",
      ]);
      const sessionIds = new Set(
        providerThreads.flatMap((thread) =>
          thread.providerSessionId === null ? [] : [thread.providerSessionId],
        ),
      );
      const inside = (parent: string, child: string) => {
        const relative = path.relative(parent, child);
        return !relative.startsWith("..") && !path.isAbsolute(relative);
      };
      yield* Effect.forEach(
        sessionIds,
        (providerSessionId) =>
          Effect.gen(function* () {
            const live = yield* providerSessions.get(providerSessionId);
            if (Option.isNone(live)) return;
            const { cwd, capabilities } = live.value.providerSession;
            if (capabilities.sessions.supportsMultipleProviderThreadsPerSession) return;
            const movedOut =
              recoveredFrom !== null &&
              inside(recoveredFrom, cwd) &&
              (worktreePath === null || !inside(recoveredFrom, worktreePath));
            if (
              !movedOut &&
              (yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => true)))
            ) {
              return;
            }
            yield* providerSessions.detach({
              providerSessionId,
              threadId,
              detail: "Workspace changed.",
            });
          }),
        { concurrency: 1, discard: true },
      );
    });

    /** Waits for a branch change holding the thread's checkout lease to finish. */
    const awaitCheckoutLease = Effect.fn("ProviderTurnStartCheckoutGateFork.awaitCheckoutLease")(
      function* (threadId: ThreadId) {
        const thread = yield* projectionStore.getThread(threadId);
        const cwd = thread.worktreePath ?? (yield* recovery.workspaceRootOf(thread));
        if (cwd === undefined) return;
        const checkout = yield* resolveTurnCheckoutFork(registry.value, cwd);
        yield* coordinator.value.withLease(checkout.repository.rootPath, Effect.void);
      },
    );

    // The gate is best effort: a failure here leaves the turn to upstream.
    const bestEffort = <E>(label: string, effect: Effect.Effect<void, E>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning(label, { cause: Cause.pretty(cause) }),
        ),
      );

    return ProviderTurnStartServiceV2.of({
      start: (input) =>
        bestEffort("turn-start worktree recovery failed", recover(input)).pipe(
          Effect.andThen(
            bestEffort(
              "turn-start recovered session detach failed",
              detachRecoveredSessions(input.threadId),
            ),
          ),
          Effect.andThen(
            bestEffort("turn-start checkout lease wait failed", awaitCheckoutLease(input.threadId)),
          ),
          Effect.andThen(inner.start(input)),
        ),
    });
  }),
);
