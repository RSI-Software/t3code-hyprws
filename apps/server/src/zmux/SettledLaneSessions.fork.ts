// Settling or deleting a worktree thread tears down its checkout's whole
// managed session. The base checkout and main session remain separate.
import { type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ZmuxSessionBinder from "./ZmuxSessionBinder.ts";
import { withCheckoutSessionCleanupFork } from "./CheckoutSessionStateLease.fork.ts";

export interface SettledLaneReactor {
  readonly reconcile: (threadId: ThreadId) => Effect.Effect<void>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export const makeSettledLaneReactor = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const terminals = yield* TerminalManager.TerminalManager;
  const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const checkoutRootOf = (cwd: string) =>
    registry.resolve({ cwd }).pipe(
      Effect.flatMap((handle) => fileSystem.realPath(handle.repository.rootPath)),
      Effect.option,
    );
  const permits = yield* Semaphore.make(1);

  const sameCheckout = (left: string | null, right: string) =>
    left !== null && path.resolve(left) === path.resolve(right);

  const reconcile = (threadId: ThreadId) =>
    permits.withPermits(1)(
      Effect.gen(function* () {
        const thread = yield* projections.getThread(threadId);
        const lane = thread.worktreePath;
        if (lane === null) return;
        if (thread.settledOverride !== "settled" && thread.deletedAt === null) return;
        const project = yield* projects.getShell(thread.projectId);
        // Missing ownership information is never permission to remove a session.
        if (Option.isNone(project)) return;
        const root = project.value.workspaceRoot;
        const laneIdentity = yield* checkoutRootOf(lane);
        const rootIdentity = yield* checkoutRootOf(root);
        if (
          Option.isNone(laneIdentity) ||
          Option.isNone(rootIdentity) ||
          laneIdentity.value === rootIdentity.value
        )
          return;

        // Detach local viewers first, but a missing exit acknowledgement must
        // not leave the session's tabs and background processes running.
        yield* terminals.releaseSettledManagedAttachments({ threadId });
        const prepared = yield* binder.prepareUnbind(lane);
        if (prepared.status !== "prepared") {
          if (prepared.status === "failed") {
            yield* Effect.logWarning("could not prepare settled checkout cleanup", {
              threadId,
              detail: prepared.notice.detail,
            });
          }
          return;
        }
        // prepareUnbind accepts only worktree matches; defend against a malformed
        // binding pointing at root/main as well.
        if (prepared.identity.target.endsWith("/main")) return;
        const rootSession = yield* binder.resolve(root);
        if (rootSession.status === "failed" || rootSession.status === "unavailable") return;
        if (rootSession.status === "resolved" && rootSession.target === prepared.identity.target)
          return;

        // Lookup and PTY release can yield. Recheck immediately before destructive
        // cleanup; later transitions are serialized and reconcile the latest state.
        yield* withCheckoutSessionCleanupFork(
          Effect.gen(function* () {
            const latest = yield* projections.getThread(threadId);
            if (
              (latest.settledOverride !== "settled" && latest.deletedAt === null) ||
              !sameCheckout(latest.worktreePath, lane)
            )
              return;
            const latestProject = yield* projects.getShell(latest.projectId);
            if (Option.isNone(latestProject)) return;
            const latestLaneIdentity = yield* checkoutRootOf(lane);
            const latestRootIdentity = yield* checkoutRootOf(latestProject.value.workspaceRoot);
            if (
              Option.isNone(latestLaneIdentity) ||
              Option.isNone(latestRootIdentity) ||
              latestLaneIdentity.value !== laneIdentity.value ||
              latestLaneIdentity.value === latestRootIdentity.value
            )
              return;
            const latestRoot = yield* binder.resolve(latestProject.value.workspaceRoot);
            if (
              latestRoot.status === "failed" ||
              latestRoot.status === "unavailable" ||
              (latestRoot.status === "resolved" && latestRoot.target === prepared.identity.target)
            )
              return;
            const removed = yield* binder.unbind(prepared.identity);
            if (removed.status === "failed") {
              yield* Effect.logWarning("settled checkout session preserved after cleanup refusal", {
                threadId,
                detail: removed.notice.detail,
                retry: ZmuxSessionBinder.protectedCleanupCommand(prepared.identity),
              });
            }
          }),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("checkout settlement reconcile failed", {
            threadId,
            detail: error.message,
          }),
        ),
      ),
    );

  return {
    reconcile,
    start: () =>
      forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          event.type === "thread.settled" || event.type === "thread.deleted"
            ? reconcile(event.threadId)
            : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("checkout settlement stream failed", { cause }),
          ),
        ),
      ),
  } satisfies SettledLaneReactor;
});

export const settledLaneSessionReactorLiveFork = Layer.effectDiscard(
  Effect.flatMap(makeSettledLaneReactor, (reactor) => reactor.start()),
).pipe(Layer.provide(ProjectionStore.layer));
