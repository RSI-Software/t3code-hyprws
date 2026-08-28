import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ZmuxSessionBinder from "../zmux/ZmuxSessionBinder.ts";
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

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({})),
    Layer.provide(makeWorktrunkHookRunnerLayer()),
  );
}

describe("GitWorkflowService", () => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
      Layer.provide(Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({})),
      Layer.provide(makeWorktrunkHookRunnerLayer()),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

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
        Layer.provide(Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({})),
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

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("unbinds a worktree session before removing the worktree", () => {
    const calls: string[] = [];
    const removeWorktree = vi.fn(() =>
      Effect.sync(() => {
        calls.push("remove");
      }),
    );
    const resolve = vi.fn(() =>
      Effect.sync(() => {
        calls.push("resolve");
        return {
          status: "resolved" as const,
          target: "repo/feat-test",
          match: "worktree" as const,
        };
      }),
    );
    const unbind = vi.fn((_dir: string) =>
      Effect.sync(() => {
        calls.push("unbind");
        return { status: "unbound" as const, target: "repo/feat-test" };
      }),
    );
    const runPreRemoveHook = vi.fn((_input: WorktrunkHookRunner.WorktrunkPreRemoveHookInput) =>
      Effect.sync(() => {
        calls.push("pre-remove");
        return { status: "completed" as const };
      }),
    );
    const runPostRemoveHook = vi.fn((_input: WorktrunkHookRunner.WorktrunkPostRemoveHookInput) =>
      Effect.sync(() => {
        calls.push("post-remove");
        return { status: "completed" as const };
      }),
    );
    const layer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: resolveGitHandle,
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ removeWorktree })),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provide(Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({ resolve, unbind })),
      Layer.provide(
        makeWorktrunkHookRunnerLayer({
          isWorktrunkWorktree: () => Effect.sync(() => calls.push("marker") > 0),
          runPreRemoveHook,
          runPostRemoveHook,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.removeWorktree({ cwd: "/repo", path: "/repo/wt", force: false });

      assert.deepStrictEqual(calls, [
        "resolve",
        "unbind",
        "marker",
        "pre-remove",
        "remove",
        "post-remove",
      ]);
      assert.deepStrictEqual(unbind.mock.calls[0]?.[0], "/repo/wt");
      assert.deepStrictEqual(runPreRemoveHook.mock.calls[0]?.[0], {
        projectCwd: "/repo",
        worktreePath: "/repo/wt",
      });
      assert.deepStrictEqual(runPostRemoveHook.mock.calls[0]?.[0], {
        projectCwd: "/repo",
        worktreePath: "/repo/wt",
      });
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
      Layer.provide(
        Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({
          resolve: () => Effect.succeed({ status: "disabled" as const }),
        }),
      ),
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

  it.effect("rebinds a worktree session after renaming its branch", () => {
    const calls: string[] = [];
    const renameBranch = vi.fn(() =>
      Effect.sync(() => {
        calls.push("rename");
        return { branch: "t3code/new-name" };
      }),
    );
    const resolve = vi.fn(() =>
      Effect.sync(() => {
        calls.push("resolve");
        return {
          status: "resolved" as const,
          target: "repo/t3code-old-name",
          match: "worktree" as const,
        };
      }),
    );
    const bind = vi.fn((_dir: string) =>
      Effect.sync(() => {
        calls.push("bind");
        return { status: "bound" as const, target: "repo/t3code-new-name" };
      }),
    );
    const layer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: resolveGitHandle,
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ renameBranch })),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provide(Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({ resolve, bind })),
      Layer.provide(makeWorktrunkHookRunnerLayer()),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const renamed = yield* workflow.renameBranch({
        cwd: "/repo/wt",
        oldBranch: "t3code/old-name",
        newBranch: "t3code/new-name",
      });

      assert.equal(renamed.branch, "t3code/new-name");
      assert.deepStrictEqual(calls, ["rename", "resolve", "bind"]);
      assert.deepStrictEqual(bind.mock.calls[0]?.[0], "/repo/wt");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not rebind after a rename outside a bound worktree", () => {
    const renameBranch = vi.fn(() => Effect.succeed({ branch: "feat/renamed" }));
    const bind = vi.fn((_dir: string) =>
      Effect.succeed({ status: "bound" as const, target: "repo/main" }),
    );
    const layer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: resolveGitHandle,
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ renameBranch })),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provide(
        Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({
          resolve: () => Effect.succeed({ status: "not-found" as const }),
          bind,
        }),
      ),
      Layer.provide(makeWorktrunkHookRunnerLayer()),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.renameBranch({
        cwd: "/repo",
        oldBranch: "feat/old",
        newBranch: "feat/renamed",
      });

      assert.equal(bind.mock.calls.length, 0);
      assert.equal(renameBranch.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not unbind a session resolved by a non-worktree match", () => {
    const unbind = vi.fn((_dir: string) =>
      Effect.succeed({ status: "unbound" as const, target: "repo/root" }),
    );
    const removeWorktree = vi.fn(() => Effect.void);
    const layer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: resolveGitHandle,
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ removeWorktree })),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provide(
        Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({
          resolve: () =>
            Effect.succeed({
              status: "resolved" as const,
              target: "repo/root",
              match: "workspace" as const,
            }),
          unbind,
        }),
      ),
      Layer.provide(makeWorktrunkHookRunnerLayer()),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.removeWorktree({ cwd: "/repo", path: "/repo/wt", force: false });

      assert.equal(unbind.mock.calls.length, 0);
      assert.equal(removeWorktree.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  });
});
