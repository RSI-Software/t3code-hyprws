// Fork-owned post-create step for a V2 launch's thread worktree: run Worktrunk create hooks for a
// Worktrunk-mode launch. It never fails the launch: a failure lands on the setup card and persists
// as a run-less `system_notice` turn item so it survives a reload. Services are looked up
// optionally so upstream harnesses need none.
import { type ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as WorktrunkHookRunner from "../worktrunk/WorktrunkHookRunner.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

interface ThreadWorktreeCreatedFork {
  readonly threadId: ThreadId;
  readonly projectCwd: string;
  readonly worktreePath: string;
  /** A `worktree` strategy with `worktrunk` set is a Worktrunk worktree: run its create hooks. */
  readonly strategy: { readonly type: string; readonly worktrunk?: boolean | undefined };
}

type ThreadWorktreeIntegrationsFork = (input: ThreadWorktreeCreatedFork) => Effect.Effect<void>;

/** Builds the post-create step from whichever integration services are present. */
export const makeThreadWorktreeIntegrationsFork = Effect.gen(function* () {
  const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const worktrunk = yield* Effect.serviceOption(WorktrunkHookRunner.WorktrunkHookRunner);
  const eventSink = yield* Effect.serviceOption(EventSink.EventSinkV2);
  const ids = yield* IdAllocator.IdAllocatorV2;

  /** One notice per launch: a retried launch rewrites it instead of stacking a second. */
  const persistFailure = Effect.fn("ThreadLaunchService.persistFailures")(
    function* (threadId: ThreadId, failure: string) {
      if (Option.isNone(eventSink)) return;
      const now = yield* DateTime.now;
      yield* eventSink.value.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`fork:worktree-integrations:${threadId}`),
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              // The event sink assigns the real position on write.
              ordinal: 0,
              status: "completed",
              title: "Worktree setup",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "system_notice",
              message: failure,
            },
          },
        ],
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Thread worktree integration notice failed to persist", {
            threadId,
            error,
          }),
        ),
      ),
  );

  const integrate: ThreadWorktreeIntegrationsFork = Effect.fn(
    "ThreadLaunchService.fork.worktreeIntegrations",
  )(function* (input) {
    if (input.strategy.type !== "worktree" || input.strategy.worktrunk !== true) return;
    let failure: string | undefined;
    if (Option.isNone(worktrunk)) {
      failure = "Worktrunk hooks unavailable on this server";
    } else {
      const hooks = yield* worktrunk.value.runCreateHooks({
        projectCwd: input.projectCwd,
        worktreePath: input.worktreePath,
      });
      if (hooks.status === "failed") {
        failure = `Worktrunk ${hooks.operation} hook failed: ${hooks.detail}`;
      }
    }
    if (failure === undefined) return;
    yield* tracker.stage(input.threadId, "checkout", { status: "warning", detail: failure });
    yield* persistFailure(input.threadId, failure);
  });

  return integrate;
});
