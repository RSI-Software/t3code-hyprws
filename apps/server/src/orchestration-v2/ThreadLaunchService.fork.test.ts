import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as WorktrunkHookRunner from "../worktrunk/WorktrunkHookRunner.ts";
import * as ZmuxSessionBinder from "../zmux/ZmuxSessionBinder.ts";
import { makeThreadWorktreeIntegrationsFork } from "./ThreadLaunchService.fork.ts";

const threadId = ThreadId.make("thread-worktree-integrations");
const projectCwd = "/repo/project";
const worktreePath = "/repo/worktrees/feature";

interface Calls {
  readonly bind: Array<{ readonly path: string; readonly projectPath: string | undefined }>;
  readonly createHooks: Array<WorktrunkHookRunner.WorktrunkCreateHooksInput>;
}

const integrationLayers = (options: {
  readonly bind: ZmuxSessionBinder.ZmuxBindResult;
  readonly createHooks: WorktrunkHookRunner.WorktrunkHookResult;
  readonly calls: Calls;
}) =>
  Layer.mergeAll(
    Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({
      bind: (path, bindOptions) =>
        Effect.sync(() => {
          options.calls.bind.push({ path, projectPath: bindOptions?.projectPath });
          return options.bind;
        }),
    }),
    Layer.mock(WorktrunkHookRunner.WorktrunkHookRunner)({
      runCreateHooks: (input) =>
        Effect.sync(() => {
          options.calls.createHooks.push(input);
          return options.createHooks;
        }),
    }),
    WorktreeSetupTracker.layer,
  );

/** Runs the post-create step for a launch already tracking its checkout stage. */
const integrate = (strategy: { readonly type: string; readonly worktrunk?: boolean }) =>
  Effect.gen(function* () {
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
    yield* run({ threadId, projectCwd, worktreePath, strategy });
    const snapshot = yield* tracker.get(threadId);
    return snapshot?.stages.find((stage) => stage.id === "checkout");
  });

describe("thread launch worktree integrations (fork)", () => {
  it.effect("binds the zmux session and runs Worktrunk create hooks for a Worktrunk launch", () => {
    const calls: Calls = { bind: [], createHooks: [] };
    return integrate({ type: "worktree", worktrunk: true }).pipe(
      Effect.map((checkout) => {
        assert.deepStrictEqual(calls.bind, [{ path: worktreePath, projectPath: projectCwd }]);
        assert.deepStrictEqual(calls.createHooks, [{ projectCwd, worktreePath }]);
        assert.strictEqual(checkout?.status, "done");
        assert.strictEqual(checkout?.detail, "zmux session created");
      }),
      Effect.provide(
        integrationLayers({
          bind: { status: "bound", target: "project/feature", outcome: "created" },
          createHooks: { status: "completed" },
          calls,
        }),
      ),
    );
  });

  it.effect("records a bind failure and a hook failure as a checkout warning", () => {
    const calls: Calls = { bind: [], createHooks: [] };
    return integrate({ type: "worktree", worktrunk: true }).pipe(
      Effect.map((checkout) => {
        assert.strictEqual(checkout?.status, "warning");
        assert.strictEqual(
          checkout?.detail,
          "zmux session failed to bind: branch_conflict; Worktrunk pre-start hook failed: exit 1",
        );
      }),
      Effect.provide(
        integrationLayers({
          bind: {
            status: "failed",
            notice: { summary: "zmux session failed to bind", detail: "branch_conflict" },
          },
          createHooks: {
            status: "failed",
            operation: "pre-start",
            detail: "exit 1",
            exitCode: 1,
            timedOut: false,
          },
          calls,
        }),
      ),
    );
  });

  it.effect("leaves Worktrunk hooks alone for a plain worktree launch", () => {
    const calls: Calls = { bind: [], createHooks: [] };
    return integrate({ type: "worktree" }).pipe(
      Effect.map((checkout) => {
        assert.strictEqual(calls.bind.length, 1);
        assert.deepStrictEqual(calls.createHooks, []);
        assert.strictEqual(checkout?.status, "done");
        assert.strictEqual(checkout?.detail, null);
      }),
      Effect.provide(
        integrationLayers({
          bind: { status: "disabled" },
          createHooks: { status: "completed" },
          calls,
        }),
      ),
    );
  });

  it.effect("warns when a Worktrunk launch reaches a server without the hook runner", () =>
    integrate({ type: "worktree", worktrunk: true }).pipe(
      Effect.map((checkout) => {
        assert.strictEqual(checkout?.status, "warning");
        assert.strictEqual(checkout?.detail, "Worktrunk hooks unavailable on this server");
      }),
      Effect.provide(WorktreeSetupTracker.layer),
    ),
  );
});
