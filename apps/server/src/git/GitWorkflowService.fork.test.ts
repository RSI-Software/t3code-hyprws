import { assert, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorktrunkHookRunner from "../worktrunk/WorktrunkHookRunner.ts";
const gitHandle = {
  kind: "git" as const,
  repository: {
    kind: "git" as const,
    rootPath: "/repo",
    metadataPath: null,
    freshness: {
      source: "live-local" as const,
      observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      expiresAt: Option.none(),
    },
  },
  driver: {} as VcsDriver.VcsDriver["Service"],
} satisfies VcsDriverRegistry.VcsDriverHandle;
const resolveGitHandle: VcsDriverRegistry.VcsDriverRegistry["Service"]["resolve"] = () =>
  Effect.succeed(gitHandle);
const makeWorktrunkHookRunnerLayer = (
  overrides: Partial<WorktrunkHookRunner.WorktrunkHookRunner["Service"]> = {},
) =>
  Layer.mock(WorktrunkHookRunner.WorktrunkHookRunner)({
    isWorktrunkWorktree: () => Effect.succeed(false),
    runCreateHooks: () =>
      Effect.succeed({ status: "skipped" as const, reason: "missing-config" as const }),
    runPreRemoveHook: () =>
      Effect.succeed({ status: "skipped" as const, reason: "missing-config" as const }),
    runPostRemoveHook: () =>
      Effect.succeed({ status: "skipped" as const, reason: "missing-config" as const }),
    ...overrides,
  });
it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect("reports the Worktrunk marker on local status", () => {
    const localStatus = {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feat-test",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    };
    const makeLayer = (worktrunk: boolean) =>
      GitWorkflowService.layer.pipe(
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            detect: () => Effect.succeed(gitHandle),
          }),
        ),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(
          Layer.mock(GitManager.GitManager)({
            localStatus: () => Effect.succeed(localStatus),
          }),
        ),
        Layer.provide(
          makeWorktrunkHookRunnerLayer({ isWorktrunkWorktree: () => Effect.succeed(worktrunk) }),
        ),
      );
    return Effect.gen(function* () {
      const marked = yield* Effect.provide(
        Effect.flatMap(GitWorkflowService.GitWorkflowService, (workflow) =>
          workflow.localStatus({ cwd: "/repo/wt" }),
        ),
        makeLayer(true),
      );
      const plain = yield* Effect.provide(
        Effect.flatMap(GitWorkflowService.GitWorkflowService, (workflow) =>
          workflow.localStatus({ cwd: "/repo/wt" }),
        ),
        makeLayer(false),
      );
      assert.deepStrictEqual(marked, { ...localStatus, worktrunk: true });
      assert.deepStrictEqual(plain, localStatus);
    });
  });
  it.effect("keeps the worktree when the Worktrunk pre-remove hook fails", () => {
    const removeWorktree = vi.fn(() => Effect.void);
    const layer = GitWorkflowService.layer.pipe(
      Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({ resolve: resolveGitHandle })),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ removeWorktree })),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provide(
        makeWorktrunkHookRunnerLayer({
          isWorktrunkWorktree: () => Effect.succeed(true),
          runPreRemoveHook: () =>
            Effect.succeed({
              status: "failed" as const,
              operation: "pre-remove" as const,
              detail: "hook refused removal",
              exitCode: 1,
              timedOut: false,
            }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const failure = yield* workflow
        .removeWorktree({ cwd: "/repo", path: "/repo/wt", force: false })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "GitCommandError");
      assert.equal(failure.command, "wt hook pre-remove");
      assert.equal(failure.detail, "hook refused removal");
      expect(removeWorktree).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });
  it.effect("removes a plain worktree without running Worktrunk hooks", () => {
    const removeWorktree = vi.fn(() => Effect.void);
    const runPreRemoveHook = vi.fn(() => Effect.succeed({ status: "completed" as const }));
    const runPostRemoveHook = vi.fn(() => Effect.succeed({ status: "completed" as const }));
    const layer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: resolveGitHandle,
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ removeWorktree })),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provide(makeWorktrunkHookRunnerLayer({ runPreRemoveHook, runPostRemoveHook })),
    );
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.removeWorktree({ cwd: "/repo", path: "/repo/wt", force: false });
      expect(removeWorktree).toHaveBeenCalledOnce();
      expect(runPreRemoveHook).not.toHaveBeenCalled();
      expect(runPostRemoveHook).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });
});
