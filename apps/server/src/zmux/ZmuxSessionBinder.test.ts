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

const bindJson = JSON.stringify({
  workspace: "t3code",
  session: {
    label: "feat/test",
    qualified: "t3code/feat/test",
    tmuxName: "t3code__feat_test",
    tmuxId: "$42",
  },
  worktree: { path: "/repo/wt", branch: "feat/test" },
  created: true,
  actions: [],
  errors: [],
});

const resolveJson = JSON.stringify({
  target: "t3code/feat/test",
  match: "worktree",
});

function makeLayer(
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  settings: Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0] = {
    zmuxSessions: true,
  },
) {
  return ZmuxSessionBinder.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
    Layer.provide(ServerSettings.ServerSettingsService.layerTest(settings)),
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
    const run = vi.fn((_input: ProcessRunner.ProcessRunInput) =>
      Effect.succeed({ ...successfulOutput, stdout: bindJson }),
    );

    return Effect.gen(function* () {
      const binder = yield* ZmuxSessionBinder.ZmuxSessionBinder;
      const result = yield* binder.bind("/repo/wt");

      assert.deepStrictEqual(result, {
        status: "bound",
        target: "t3code/feat/test",
      });
      assert.deepStrictEqual(run.mock.calls[0]?.[0], {
        command: "zmux",
        args: ["wt", "--adopt", "/repo/wt", "--yes", "--json", "--no-switch"],
        env: {
          PATH: "/usr/bin",
          KEEP_ME: "yes",
        },
        extendEnv: false,
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
      const unbound = yield* binder.unbind("/repo/wt");

      assert.deepStrictEqual(resolved, {
        status: "resolved",
        target: "t3code/feat/test",
        match: "worktree",
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
          ["session", "kill", "t3code/feat/test"],
        ],
      );
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
    }).pipe(Effect.provide(makeLayer(run, { zmuxSessions: false })));
  });
});
