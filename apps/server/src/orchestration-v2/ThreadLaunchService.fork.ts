// Fork-owned post-create step for a thread worktree a V2 launch provisions:
// bind the checkout's managed zmux session.
//
// V2 has no thread activity log, so the outcome lands on the worktree setup
// card's checkout stage, the surface that already narrates this launch, and in
// the server log. It never fails the launch: a worktree without its zmux
// session is still a working thread.
//
// The binder is looked up optionally so the seam adds no requirement to
// `ThreadLaunchService.layer` and upstream harnesses keep upstream text. The
// production runtime provides it through `GitWorkflowLayerLive`.
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ZmuxSessionBinder from "../zmux/ZmuxSessionBinder.ts";

interface ThreadWorktreeCreatedFork {
  readonly threadId: ThreadId;
  readonly projectCwd: string;
  readonly worktreePath: string;
}

type ThreadWorktreeIntegrationsFork = (input: ThreadWorktreeCreatedFork) => Effect.Effect<void>;

/** Builds the post-create step from whichever integration services are present. */
export const makeThreadWorktreeIntegrationsFork = Effect.gen(function* () {
  const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const zmux = yield* Effect.serviceOption(ZmuxSessionBinder.ZmuxSessionBinder);

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

    if (notes.length === 0) return;
    yield* tracker.stage(input.threadId, "checkout", {
      ...(warning ? { status: "warning" as const } : {}),
      detail: notes.join("; "),
    });
  });

  return integrate;
});
