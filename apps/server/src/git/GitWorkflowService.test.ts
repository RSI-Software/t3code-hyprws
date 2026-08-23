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
    const layer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: resolveGitHandle,
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ removeWorktree })),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
      Layer.provide(Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({ resolve, unbind })),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.removeWorktree({ cwd: "/repo", path: "/repo/wt", force: false });

      assert.deepStrictEqual(calls, ["resolve", "unbind", "remove"]);
      assert.deepStrictEqual(unbind.mock.calls[0]?.[0], "/repo/wt");
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
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.removeWorktree({ cwd: "/repo", path: "/repo/wt", force: false });

      assert.equal(unbind.mock.calls.length, 0);
      assert.equal(removeWorktree.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  });
});
