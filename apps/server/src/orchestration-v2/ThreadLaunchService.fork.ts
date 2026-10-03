// Fork-owned post-create step for a thread worktree a V2 launch provisions:
// bind the checkout's managed zmux session, then run the project's Worktrunk
// create hooks when the client launched in Worktrunk mode.
//
// V2 has no thread activity log, so each outcome lands on the worktree setup
// card's checkout stage, the surface that already narrates this launch, and in
// the server log. Neither step fails the launch: a worktree without its zmux
// session or hooks is still a working thread.
//
// The services are looked up optionally so the seam adds no requirement to
// `ThreadLaunchService.layer` and upstream harnesses keep upstream text. The
// production runtime provides both through `GitWorkflowLayerLive`.
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as WorktrunkHookRunner from "../worktrunk/WorktrunkHookRunner.ts";
import * as ZmuxSessionBinder from "../zmux/ZmuxSessionBinder.ts";

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

  const integrate: ThreadWorktreeIntegrationsFork = Effect.fn(
    "ThreadLaunchService.fork.worktreeIntegrations",
  )(function* (input) {
    const notes: Array<string> = [];
    let warning = false;

    if (Option.isSome(zmux)) {
      const bound = yield* zmux.value.bind(input.worktreePath, { projectPath: input.projectCwd });
      if (bound.status === "failed") {
        warning = true;
        notes.push(`${bound.notice.summary}: ${bound.notice.detail}`);
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
        warning = true;
        notes.push("Worktrunk hooks unavailable on this server");
      } else {
        const hooks = yield* worktrunk.value.runCreateHooks({
          projectCwd: input.projectCwd,
          worktreePath: input.worktreePath,
        });
        if (hooks.status === "failed") {
          warning = true;
          notes.push(`Worktrunk ${hooks.operation} hook failed: ${hooks.detail}`);
        }
      }
    }

    if (notes.length === 0) return;
    yield* tracker.stage(input.threadId, "checkout", {
      ...(warning ? { status: "warning" as const } : {}),
      detail: notes.join("; "),
    });
  });

  return integrate;
});
