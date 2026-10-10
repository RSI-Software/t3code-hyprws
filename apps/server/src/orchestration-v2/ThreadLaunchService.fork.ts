// Fork-owned post-create step for a thread worktree a V2 launch provisions:
// bind the checkout's managed zmux session, then run the project's Worktrunk
// create hooks when the client launched in Worktrunk mode.
//
// Each outcome lands on the worktree setup card's checkout stage, the surface
// that already narrates this launch, and in the server log. The setup card is
// in-memory, so a failure is also persisted as a run-less `system_notice` turn
// item: an upstream item type every client already renders as a warning row,
// which keeps the failure in the thread after a reload. Neither step fails the
// launch: a worktree without its zmux session or hooks is still a working
// thread.
//
// The services are looked up optionally so the seam adds no requirement to
// `ThreadLaunchService.layer` and upstream harnesses keep upstream text. The
// production runtime provides the binder and hook runner through
// `GitWorkflowLayerLive`, and the event sink through `runtimeLayer.ts`.
import { type ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as WorktrunkHookRunner from "../worktrunk/WorktrunkHookRunner.ts";
import * as ZmuxSessionBinder from "../zmux/ZmuxSessionBinder.ts";
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
  const zmux = yield* Effect.serviceOption(ZmuxSessionBinder.ZmuxSessionBinder);
  const worktrunk = yield* Effect.serviceOption(WorktrunkHookRunner.WorktrunkHookRunner);
  const eventSink = yield* Effect.serviceOption(EventSink.EventSinkV2);
  const ids = yield* IdAllocator.IdAllocatorV2;

  /** One notice per launch: a retried launch rewrites it instead of stacking a second. */
  const persistFailures = (threadId: ThreadId, failures: ReadonlyArray<string>) =>
    Effect.gen(function* () {
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
              message: failures.join("; "),
            },
          },
        ],
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Thread worktree integration notice failed to persist", {
          threadId,
          error,
        }),
      ),
    );

  const integrate: ThreadWorktreeIntegrationsFork = Effect.fn(
    "ThreadLaunchService.fork.worktreeIntegrations",
  )(function* (input) {
    const notes: Array<string> = [];
    const failures: Array<string> = [];

    if (Option.isSome(zmux)) {
      const bound = yield* zmux.value.bind(input.worktreePath, { projectPath: input.projectCwd });
      if (bound.status === "failed") {
        failures.push(`${bound.notice.summary}: ${bound.notice.detail}`);
        yield* Effect.logWarning("Thread worktree zmux session failed to bind", {
          threadId: input.threadId,
          worktreePath: input.worktreePath,
          detail: bound.notice.detail,
        });
      } else if (bound.status === "bound") {
        notes.push(`zmux session ${bound.outcome}`);
        yield* Effect.logInfo("Thread worktree zmux session bound", {
          threadId: input.threadId,
          worktreePath: input.worktreePath,
          target: bound.target,
          outcome: bound.outcome,
        });
      }
    }

    if (input.strategy.type === "worktree" && input.strategy.worktrunk === true) {
      if (Option.isNone(worktrunk)) {
        failures.push("Worktrunk hooks unavailable on this server");
      } else {
        const hooks = yield* worktrunk.value.runCreateHooks({
          projectCwd: input.projectCwd,
          worktreePath: input.worktreePath,
        });
        if (hooks.status === "failed") {
          failures.push(`Worktrunk ${hooks.operation} hook failed: ${hooks.detail}`);
        }
      }
    }

    if (notes.length === 0 && failures.length === 0) return;
    yield* tracker.stage(input.threadId, "checkout", {
      ...(failures.length > 0 ? { status: "warning" as const } : {}),
      detail: [...failures, ...notes].join("; "),
    });
    if (failures.length > 0) yield* persistFailures(input.threadId, failures);
  });

  return integrate;
});
