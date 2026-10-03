import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ZmuxSessionBinder from "../zmux/ZmuxSessionBinder.ts";
import { makeThreadWorktreeIntegrationsFork } from "./ThreadLaunchService.fork.ts";

const threadId = ThreadId.make("thread-worktree-integrations");
const projectCwd = "/repo/project";
const worktreePath = "/repo/worktrees/feature";

interface Calls {
  readonly bind: Array<{ readonly path: string; readonly projectPath: string | undefined }>;
}

const zmuxLayer = (bind: ZmuxSessionBinder.ZmuxBindResult, calls: Calls) =>
  Layer.merge(
    Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({
      bind: (path, bindOptions) =>
        Effect.sync(() => {
          calls.bind.push({ path, projectPath: bindOptions?.projectPath });
          return bind;
        }),
    }),
    WorktreeSetupTracker.layer,
  );

/** Runs the post-create step for a launch already tracking its checkout stage. */
const integrate = Effect.gen(function* () {
  const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  yield* tracker.begin({
    threadId,
    branch: "feature",
    baseRef: "main",
    stages: ["fetch", "checkout", "setup-script", "agent"],
    fiber: null,
  });
  yield* tracker.stageStatus(threadId, "checkout", "done");
  const run = yield* makeThreadWorktreeIntegrationsFork;
  yield* run({ threadId, projectCwd, worktreePath });
  const snapshot = yield* tracker.get(threadId);
  return snapshot?.stages.find((stage) => stage.id === "checkout");
});

describe("thread launch worktree integrations (fork)", () => {
  it.effect("binds the new worktree's zmux session against its project", () => {
    const calls: Calls = { bind: [] };
    return integrate.pipe(
      Effect.map((checkout) => {
        assert.deepStrictEqual(calls.bind, [{ path: worktreePath, projectPath: projectCwd }]);
        assert.strictEqual(checkout?.status, "done");
        assert.strictEqual(checkout?.detail, "zmux session created");
      }),
      Effect.provide(
        zmuxLayer({ status: "bound", target: "project/feature", outcome: "created" }, calls),
      ),
    );
  });

  it.effect("records a bind failure as a checkout warning without failing the launch", () =>
    integrate.pipe(
      Effect.map((checkout) => {
        assert.strictEqual(checkout?.status, "warning");
        assert.strictEqual(checkout?.detail, "zmux session failed to bind: branch_conflict");
      }),
      Effect.provide(
        zmuxLayer(
          {
            status: "failed",
            notice: { summary: "zmux session failed to bind", detail: "branch_conflict" },
          },
          { bind: [] },
        ),
      ),
    ),
  );

  it.effect("leaves the checkout stage alone when zmux is disabled", () =>
    integrate.pipe(
      Effect.map((checkout) => {
        assert.strictEqual(checkout?.status, "done");
        assert.strictEqual(checkout?.detail, null);
      }),
      Effect.provide(zmuxLayer({ status: "disabled" }, { bind: [] })),
    ),
  );
});
