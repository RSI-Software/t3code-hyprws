import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it, vi } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorktrunkHookRunner from "./WorktrunkHookRunner.ts";

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

const hookEnv = { PATH: "/usr/bin", KEEP_ME: "yes" };

function makeLayer(input: {
  readonly run: ProcessRunner.ProcessRunner["Service"]["run"];
  readonly settingsEnabled?: boolean;
  readonly projectOverride?: boolean;
  readonly configExists?: (path: string) => Effect.Effect<boolean>;
  readonly load?: T3ProjectFileLoader.T3ProjectFileLoader["Service"]["load"];
}) {
  return WorktrunkHookRunner.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run: input.run })),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        worktrunkHooks: input.settingsEnabled ?? true,
      }),
    ),
    Layer.provide(
      Layer.succeed(T3ProjectFileLoader.T3ProjectFileLoader, {
        load:
          input.load ??
          (() =>
            Effect.succeed(
              input.projectOverride === undefined
                ? Option.none()
                : Option.some({ worktrunkHooks: input.projectOverride }),
            )),
      }),
    ),
    Layer.provide(
      FileSystem.layerNoop({
        exists: input.configExists ?? (() => Effect.succeed(true)),
      }),
    ),
    Layer.provide(NodePath.layer),
    Layer.provide(
      Layer.succeed(HostProcessEnvironment, {
        ...hookEnv,
        TMUX: "/tmp/tmux/default",
        TMUX_PANE: "%7",
      }),
    ),
  );
}

function recordingRun(
  calls: ProcessRunner.ProcessRunInput[],
  respond: (input: ProcessRunner.ProcessRunInput) => ProcessRunner.ProcessRunOutput = () =>
    successfulOutput,
) {
  return vi.fn((input: ProcessRunner.ProcessRunInput) =>
    Effect.sync(() => {
      calls.push(input);
      return respond(input);
    }),
  );
}

const hookCalls = (calls: ReadonlyArray<ProcessRunner.ProcessRunInput>) =>
  calls.filter((call) => call.args[0] !== "--version");

const createInput: WorktrunkHookRunner.WorktrunkCreateHooksInput = {
  projectCwd: "/repo",
  worktreePath: "/repo/wt",
};

describe("WorktrunkHookRunner", () => {
  it.effect("applies a t3.json true override after the disabled server setting", () => {
    const order: string[] = [];
    const run = vi.fn(() =>
      Effect.sync(() => {
        order.push("binary");
        return successfulOutput;
      }),
    );

    return Effect.gen(function* () {
      const runner = yield* WorktrunkHookRunner.WorktrunkHookRunner;
      const result = yield* runner.runCreateHooks(createInput);

      expect(result).toEqual({ status: "completed" });
      expect(order).toEqual(["load", "config", "binary", "binary", "binary"]);
    }).pipe(
      Effect.provide(
        makeLayer({
          run,
          settingsEnabled: false,
          load: () =>
            Effect.sync(() => {
              order.push("load");
              return Option.some({ worktrunkHooks: true });
            }),
          configExists: () =>
            Effect.sync(() => {
              order.push("config");
              return true;
            }),
        }),
      ),
    );
  });

  it.effect("applies a t3.json false override before filesystem and binary gates", () => {
    const run = vi.fn(() => Effect.succeed(successfulOutput));
    const exists = vi.fn(() => Effect.succeed(true));

    return Effect.gen(function* () {
      const runner = yield* WorktrunkHookRunner.WorktrunkHookRunner;
      const result = yield* runner.runCreateHooks(createInput);

      expect(result).toEqual({ status: "skipped", reason: "disabled" });
      expect(exists).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        makeLayer({ run, configExists: exists, settingsEnabled: true, projectOverride: false }),
      ),
    );
  });

  it.effect("skips before binary resolution when .config/wt.toml is missing", () => {
    const run = vi.fn(() => Effect.succeed(successfulOutput));

    return Effect.gen(function* () {
      const runner = yield* WorktrunkHookRunner.WorktrunkHookRunner;
      const result = yield* runner.runCreateHooks(createInput);

      expect(result).toEqual({ status: "skipped", reason: "missing-config" });
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeLayer({ run, configExists: () => Effect.succeed(false) })));
  });

  it.effect("silently skips when wt is missing", () => {
    const run = vi.fn(() =>
      Effect.fail(
        new ProcessRunner.ProcessSpawnError({
          command: "wt",
          argumentCount: 1,
          cause: { code: "ENOENT" },
        }),
      ),
    );

    return Effect.gen(function* () {
      const runner = yield* WorktrunkHookRunner.WorktrunkHookRunner;
      const result = yield* runner.runCreateHooks(createInput);

      expect(result).toEqual({ status: "skipped", reason: "missing-binary" });
      expect(run).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(makeLayer({ run })));
  });

  it.effect("runs pre-start then post-start in the worktree with the project as base", () => {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const run = recordingRun(calls);

    return Effect.gen(function* () {
      const runner = yield* WorktrunkHookRunner.WorktrunkHookRunner;
      const result = yield* runner.runCreateHooks(createInput);

      expect(result).toEqual({ status: "completed" });
      expect(calls[0]).toEqual({
        command: "wt",
        args: ["--version"],
        env: hookEnv,
        extendEnv: false,
      });
      expect(hookCalls(calls)).toEqual([
        {
          command: "wt",
          args: ["hook", "pre-start", "--yes", "--base_worktree_path=/repo"],
          cwd: "/repo/wt",
          timeout: "5 minutes",
          timeoutBehavior: "timedOutResult",
          env: hookEnv,
          extendEnv: false,
        },
        {
          command: "wt",
          args: ["hook", "post-start", "--yes", "--base_worktree_path=/repo"],
          cwd: "/repo/wt",
          timeout: "5 minutes",
          timeoutBehavior: "timedOutResult",
          env: hookEnv,
          extendEnv: false,
        },
      ]);
    }).pipe(Effect.provide(makeLayer({ run })));
  });

  it.effect("stops at a failed pre-start hook without running post-start", () => {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const run = recordingRun(calls, (input) =>
      input.args[1] === "pre-start"
        ? { ...successfulOutput, code: ChildProcessSpawner.ExitCode(3), stderr: "seed failed" }
        : successfulOutput,
    );

    return Effect.gen(function* () {
      const runner = yield* WorktrunkHookRunner.WorktrunkHookRunner;
      const result = yield* runner.runCreateHooks(createInput);

      expect(result).toEqual({
        status: "failed",
        operation: "pre-start",
        detail: "seed failed",
        exitCode: 3,
        timedOut: false,
      });
      expect(hookCalls(calls).map((call) => call.args[1])).toEqual(["pre-start"]);
    }).pipe(Effect.provide(makeLayer({ run })));
  });

  it.effect("returns failures from both blocking remove hooks without failing the caller", () => {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const run = recordingRun(calls, (input) =>
      input.args[0] === "--version"
        ? successfulOutput
        : {
            ...successfulOutput,
            code: ChildProcessSpawner.ExitCode(7),
            stderr: `${input.args[1]} rejected`,
          },
    );

    return Effect.gen(function* () {
      const runner = yield* WorktrunkHookRunner.WorktrunkHookRunner;
      const pre = yield* runner.runPreRemoveHook({
        projectCwd: "/repo",
        worktreePath: "/repo/wt",
      });
      const post = yield* runner.runPostRemoveHook({
        projectCwd: "/repo",
        worktreePath: "/repo/wt",
        branch: "feature/test",
      });

      expect(pre).toEqual({
        status: "failed",
        operation: "pre-remove",
        detail: "pre-remove rejected",
        exitCode: 7,
        timedOut: false,
      });
      expect(post).toEqual({
        status: "failed",
        operation: "post-remove",
        detail: "post-remove rejected",
        exitCode: 7,
        timedOut: false,
      });
      expect(hookCalls(calls)).toEqual([
        {
          command: "wt",
          args: ["hook", "pre-remove", "--yes"],
          cwd: "/repo/wt",
          timeout: "5 minutes",
          timeoutBehavior: "timedOutResult",
          env: hookEnv,
          extendEnv: false,
        },
        {
          command: "wt",
          args: [
            "hook",
            "post-remove",
            "--yes",
            "--foreground",
            "--worktree_path=/repo/wt",
            "--branch=feature/test",
          ],
          cwd: "/repo",
          timeout: "5 minutes",
          timeoutBehavior: "timedOutResult",
          env: hookEnv,
          extendEnv: false,
        },
      ]);
    }).pipe(Effect.provide(makeLayer({ run })));
  });
});
