import * as NodePath from "@effect/platform-node/NodePath";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ZmuxSessionBinder from "./ZmuxSessionBinder.ts";

const successfulOutput: ProcessRunner.ProcessRunOutput = {
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};

const bindJson = (outcome: "created" | "reused" | "restored" | "renamed" = "created") =>
  JSON.stringify({
    workspace: "t3code",
    session: {
      label: "feat/test",
      qualified: "t3code/feat/test",
      tmuxName: "t3code__feat_test",
      tmuxId: "$42",
    },
    worktree: { path: "/repo/wt", branch: "feat/test" },
    created: outcome === "created",
    reused: outcome === "reused",
    restored: outcome === "restored",
    renamed: outcome === "renamed",
    actions: [],
    errors: [],
  });

const resolveJson = JSON.stringify({
  workspace: "t3code",
  session: "feat/test",
  target: "t3code/feat/test",
  match: "worktree",
  tmuxName: "t3code__feat_test",
  nativeId: "$42",
  serverId: "123:456",
  createdAt: 789,
  state: "live",
  binding: {
    branch: "feat/test",
    worktreePath: "/repo/wt",
  },
});

function makeLayer(
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  settings: Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0] = {
    terminalSessionMode: "zmux",
  },
) {
  return ZmuxSessionBinder.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest(settings)),
    Layer.provide(NodePath.layer),
    Layer.provide(
      Layer.succeed(HostProcessEnvironment, {
        PATH: "/usr/bin",
        KEEP_ME: "yes",
        TMUX: "/tmp/tmux/default",
        TMUX_PANE: "%7",
      }),
    ),
  );
}

describe("ZmuxSessionBinder", () => {
  it.effect("binds an existing worktree with tmux routing variables stripped", () => {
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed({
        ...successfulOutput,
        stdout: input.args[0] === "wt" ? bindJson() : resolveJson,
      }),
    );

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const result = yield* binder.bind("/repo/wt");

      assert.deepStrictEqual(result, {
        status: "bound",
        target: "t3code/feat/test",
        outcome: "created",
      });
      assert.deepStrictEqual(run.mock.calls[0]?.[0], {
        command: "zmux",
        args: ["wt", "--adopt", "/repo/wt", "--yes", "--json", "--no-switch"],
        env: {
          PATH: "/usr/bin",
          KEEP_ME: "yes",
        },
        extendEnv: false,
        timeout: "30 seconds",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      });
      assert.deepStrictEqual(run.mock.calls[1]?.[0], {
        command: "zmux",
        args: ["session", "resolve", "--cwd", "/repo/wt", "--json"],
        env: {
          PATH: "/usr/bin",
          KEEP_ME: "yes",
        },
        extendEnv: false,
        timeout: "30 seconds",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      });
    }).pipe(Effect.provide(makeLayer(run)));
  });

  for (const outcome of ["reused", "restored", "renamed"] as const) {
    it.effect(`reports a verified ${outcome} adoption without creating another session`, () => {
      const run = vi.fn((input: ProcessRunner.ProcessRunInput) =>
        Effect.succeed({
          ...successfulOutput,
          stdout: input.args[0] === "wt" ? bindJson(outcome) : resolveJson,
        }),
      );

      return Effect.gen(function* () {
        const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
        const result = yield* binder.bind("/repo/wt");

        assert.deepStrictEqual(result, {
          status: "bound",
          target: "t3code/feat/test",
          outcome,
        });
        assert.deepStrictEqual(
          run.mock.calls.map(([input]) => input.args),
          [
            ["wt", "--adopt", "/repo/wt", "--yes", "--json", "--no-switch"],
            ["session", "resolve", "--cwd", "/repo/wt", "--json"],
          ],
        );
      }).pipe(Effect.provide(makeLayer(run)));
    });
  }

  it.effect("refuses an adoption whose readback points at a different native target", () => {
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed({
        ...successfulOutput,
        stdout:
          input.args[0] === "wt"
            ? bindJson()
            : JSON.stringify({
                ...JSON.parse(resolveJson),
                tmuxName: "t3code__stale",
                nativeId: "$7",
              }),
      }),
    );

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const result = yield* binder.bind("/repo/wt");

      assert.deepStrictEqual(result, {
        status: "failed",
        notice: {
          summary: "zmux session binding could not be verified",
          detail: "expected t3code/feat/test native target t3code__feat_test, got t3code__stale",
        },
      });
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("resolves and kills only the worktree-matched managed session", () => {
    const run = vi.fn((input: ProcessRunner.ProcessRunInput) => {
      if (input.args[1] === "resolve") {
        return Effect.succeed({ ...successfulOutput, stdout: resolveJson });
      }
      return Effect.succeed(successfulOutput);
    });

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const resolved = yield* binder.resolve("/repo/wt");
      const prepared = yield* binder.prepareUnbind("/repo/wt");
      assert.equal(prepared.status, "prepared");
      if (prepared.status !== "prepared") return;
      const unbound = yield* binder.unbind(prepared.identity);

      assert.deepStrictEqual(resolved, {
        status: "resolved",
        workspace: "t3code",
        session: "feat/test",
        target: "t3code/feat/test",
        match: "worktree",
        tmuxName: "t3code__feat_test",
        nativeId: "$42",
        serverId: "123:456",
        createdAt: 789,
        state: "live",
        binding: {
          branch: "feat/test",
          worktreePath: "/repo/wt",
        },
      });
      assert.deepStrictEqual(unbound, {
        status: "unbound",
        target: "t3code/feat/test",
      });
      assert.deepStrictEqual(
        run.mock.calls.map(([input]) => input.args),
        [
          ["session", "resolve", "--cwd", "/repo/wt", "--json"],
          ["session", "resolve", "--cwd", "/repo/wt", "--json"],
          [
            "session",
            "kill",
            "t3code/feat/test",
            "--if-session-id",
            "$42",
            "--if-server-id",
            "123:456",
            "--if-created-at",
            "789",
            "--json",
          ],
        ],
      );
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("refuses cleanup preparation without the complete native generation", () => {
    const run = vi.fn(() =>
      Effect.succeed({
        ...successfulOutput,
        stdout: JSON.stringify({ ...JSON.parse(resolveJson), serverId: undefined }),
      }),
    );

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const prepared = yield* binder.prepareUnbind("/repo/wt");

      assert.equal(prepared.status, "failed");
      assert.equal(run.mock.calls.length, 1);
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("accepts a restorable resolve DTO and preserves its durable record", () => {
    const run = vi.fn(() =>
      Effect.succeed({
        ...successfulOutput,
        stdout: JSON.stringify({
          ...JSON.parse(resolveJson),
          tmuxName: null,
          nativeId: null,
          serverId: null,
          createdAt: null,
          state: "restorable",
        }),
      }),
    );

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const resolved = yield* binder.resolve("/repo/wt");
      const prepared = yield* binder.prepareUnbind("/repo/wt");

      assert.equal(resolved.status, "resolved");
      assert.equal(prepared.status, "failed");
      if (prepared.status !== "failed") return;
      assert.match(prepared.notice.detail, /processes and durable record will be preserved/);
      assert.match(prepared.notice.detail, /zmux tabs 't3code\/feat\/test'/);
      assert.equal(prepared.notice.detail.includes("session kill"), false);
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("returns the zmux refusal without duplicating recovery guidance", () => {
    const run = vi.fn(() =>
      Effect.succeed({
        ...successfulOutput,
        code: ChildProcessSpawner.ExitCode(1),
        stdout: JSON.stringify({
          errors: [{ code: "shared_view", message: "session has shared viewers" }],
        }),
      }),
    );

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const result = yield* binder.unbind({
        target: "t3code/feat'test",
        nativeId: "$42",
        serverId: "123:456",
        createdAt: 789,
      });

      assert.equal(result.status, "failed");
      if (result.status !== "failed") return;
      assert.equal(result.notice.detail, "shared_view: session has shared viewers");
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("does not block worktree creation when zmux is missing", () => {
    const run = () =>
      Effect.fail(
        new ProcessRunner.ProcessSpawnError({
          command: "zmux",
          argumentCount: 7,
          cause: { code: "ENOENT" },
        }),
      );

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const result = yield* binder.bind("/repo/wt");

      assert.deepStrictEqual(result, { status: "unavailable" });
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("returns a user-notice payload for a non-zero bind exit", () => {
    const run = () =>
      Effect.succeed({
        ...successfulOutput,
        code: ChildProcessSpawner.ExitCode(1),
        stdout: JSON.stringify({
          errors: [{ code: "branch_conflict", message: "branch is already bound" }],
        }),
      });

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const result = yield* binder.bind("/repo/wt");

      assert.deepStrictEqual(result, {
        status: "failed",
        notice: {
          summary: "zmux session failed to bind",
          detail: "branch_conflict: branch is already bound",
        },
      });
    }).pipe(Effect.provide(makeLayer(run)));
  });

  it.effect("does nothing while managed zmux sessions are disabled", () => {
    const run = vi.fn(() => Effect.succeed(successfulOutput));

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const result = yield* binder.bind("/repo/wt");

      assert.deepStrictEqual(result, { status: "disabled" });
      assert.equal(run.mock.calls.length, 0);
    }).pipe(Effect.provide(makeLayer(run, { terminalSessionMode: "shell" })));
  });
});
