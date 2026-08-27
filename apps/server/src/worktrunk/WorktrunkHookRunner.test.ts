import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it, vi } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
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

const configPath = "/repo/.config/wt.toml";
const dotGitPath = "/repo/wt/.git";
const markerPath = "/repo/.git/worktrees/wt/t3-worktrunk";
const linkedWorktreeFiles = {
  [configPath]: "",
  [dotGitPath]: "gitdir: /repo/.git/worktrees/wt\n",
};

const missingFile = (path: string) =>
  Effect.fail(
    PlatformError.systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "readFileString",
      pathOrDescriptor: path,
    }),
  );

/**
 * A fake filesystem of at most three files: the Worktrunk config, the linked
 * worktree's `.git` file, and the marker. `writes` records marker writes.
 */
function makeLayer(input: {
  readonly run: ProcessRunner.ProcessRunner["Service"]["run"];
  readonly files?: Partial<Record<string, string>>;
  readonly writes?: string[];
}) {
  const files: Partial<Record<string, string>> = { ...(input.files ?? linkedWorktreeFiles) };
  return WorktrunkHookRunner.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run: input.run })),
    Layer.provide(
      FileSystem.layerNoop({
        exists: (path) => Effect.succeed(files[path] !== undefined),
        readFileString: (path) => {
          const contents = files[path];
          return contents === undefined ? missingFile(path) : Effect.succeed(contents);
        },
        writeFileString: (path, contents) =>
          Effect.sync(() => {
            files[path] = contents;
            input.writes?.push(path);
          }),
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
  it.effect("marks the worktree gitdir before running the create hooks", () => {
    const writes: string[] = [];
    const run = vi.fn(() => Effect.succeed(successfulOutput));

    return Effect.gen(function* () {
      const runner = yield* WorktrunkHookRunner.WorktrunkHookRunner;
      expect(yield* runner.isWorktrunkWorktree("/repo/wt")).toBe(false);

      const result = yield* runner.runCreateHooks(createInput);

      expect(result).toEqual({ status: "completed" });
      expect(writes).toEqual([markerPath]);
      expect(yield* runner.isWorktrunkWorktree("/repo/wt")).toBe(true);
    }).pipe(Effect.provide(makeLayer({ run, writes })));
  });

  it.effect("marks the worktree even when the hooks are skipped", () => {
    const writes: string[] = [];
    const run = vi.fn(() => Effect.succeed(successfulOutput));

    return Effect.gen(function* () {
      const runner = yield* WorktrunkHookRunner.WorktrunkHookRunner;
      const result = yield* runner.runCreateHooks(createInput);

      expect(result).toEqual({ status: "skipped", reason: "missing-config" });
      expect(writes).toEqual([markerPath]);
      expect(run).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        makeLayer({ run, writes, files: { [dotGitPath]: linkedWorktreeFiles[dotGitPath] } }),
      ),
    );
  });

  it.effect("treats a checkout without a gitdir file as a plain worktree", () => {
    const writes: string[] = [];
    const run = vi.fn(() => Effect.succeed(successfulOutput));

    return Effect.gen(function* () {
      const runner = yield* WorktrunkHookRunner.WorktrunkHookRunner;
      expect(yield* runner.isWorktrunkWorktree("/repo")).toBe(false);

      const result = yield* runner.runCreateHooks({ projectCwd: "/repo", worktreePath: "/repo" });

      expect(result).toEqual({ status: "completed" });
      expect(writes).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ run, writes, files: { [configPath]: "" } })));
  });

  it.effect("skips before binary resolution when .config/wt.toml is missing", () => {
    const run = vi.fn(() => Effect.succeed(successfulOutput));

    return Effect.gen(function* () {
      const runner = yield* WorktrunkHookRunner.WorktrunkHookRunner;
      const result = yield* runner.runCreateHooks(createInput);

      expect(result).toEqual({ status: "skipped", reason: "missing-config" });
      expect(run).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeLayer({ run, files: {} })));
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
