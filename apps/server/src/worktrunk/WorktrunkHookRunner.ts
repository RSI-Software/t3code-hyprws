import { stripInheritedTmuxEnv } from "@t3tools/shared/env";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";

import * as ProcessRunner from "../processRunner.ts";

const HOOK_TIMEOUT = "5 minutes";

/**
 * Marker file T3 Code drops beside git's own `locked` marker in a linked
 * worktree's gitdir (`.git/worktrees/<name>/`) when it creates the worktree in
 * Worktrunk mode. Its presence is what makes the remove hooks run later, and
 * `git worktree remove` deletes the directory with it.
 */
export const WORKTRUNK_MARKER_FILE = "t3-worktrunk";

export type WorktrunkHookOperation = "pre-start" | "post-start" | "pre-remove" | "post-remove";

export type WorktrunkHookSkipReason = "missing-config" | "missing-binary";

export interface WorktrunkHookSkippedResult {
  readonly status: "skipped";
  readonly reason: WorktrunkHookSkipReason;
}

export interface WorktrunkHookCompletedResult {
  readonly status: "completed";
}

export interface WorktrunkHookFailedResult {
  readonly status: "failed";
  readonly operation: WorktrunkHookOperation;
  readonly detail: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export type WorktrunkHookResult =
  | WorktrunkHookSkippedResult
  | WorktrunkHookCompletedResult
  | WorktrunkHookFailedResult;

export interface WorktrunkCreateHooksInput {
  readonly projectCwd: string;
  readonly worktreePath: string;
}

export interface WorktrunkPreRemoveHookInput {
  readonly projectCwd: string;
  readonly worktreePath: string;
}

export interface WorktrunkPostRemoveHookInput {
  readonly projectCwd: string;
  readonly worktreePath: string;
  readonly branch?: string;
}

/**
 * Runs the project's Worktrunk lifecycle hooks around a worktree T3 Code
 * created in Worktrunk mode, so the worktree matches one made with
 * `wt switch --create`. `runCreateHooks` marks the worktree first, and
 * `isWorktrunkWorktree` reads that marker so removal runs the matching hooks
 * only for a worktree that started this way. Every hook runs headless through
 * `wt hook <type> --yes`; `pre-*` hooks block and `post-start` returns once
 * `wt` has detached its hooks, exactly as the `wt` commands do. `.config/wt.toml`
 * and the `wt` binary gate every call; a skipped hook leaves upstream
 * behaviour untouched.
 */
export class WorktrunkHookRunner extends Context.Service<
  WorktrunkHookRunner,
  {
    readonly isWorktrunkWorktree: (worktreePath: string) => Effect.Effect<boolean>;
    readonly runCreateHooks: (
      input: WorktrunkCreateHooksInput,
    ) => Effect.Effect<WorktrunkHookResult>;
    readonly runPreRemoveHook: (
      input: WorktrunkPreRemoveHookInput,
    ) => Effect.Effect<WorktrunkHookResult>;
    readonly runPostRemoveHook: (
      input: WorktrunkPostRemoveHookInput,
    ) => Effect.Effect<WorktrunkHookResult>;
  }
>()("t3/worktrunk/WorktrunkHookRunner") {}

function hasMissingBinaryCause(value: unknown, seen = new Set<object>()): boolean {
  if (!Predicate.isObject(value) || seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (
    ("code" in value && value.code === "ENOENT") ||
    ("reason" in value && value.reason === "NotFound")
  ) {
    return true;
  }
  if ("cause" in value) {
    return hasMissingBinaryCause(value.cause, seen);
  }
  return false;
}

function isMissingWorktrunk(error: ProcessRunner.ProcessRunError): boolean {
  return error._tag === "ProcessSpawnError" && hasMissingBinaryCause(error.cause);
}

function failureDetail(output: ProcessRunner.ProcessRunOutput): string {
  const detail = output.stderr.trim() || output.stdout.trim();
  if (detail) return detail;
  if (output.timedOut) return "Worktrunk hook timed out";
  return `wt exited with code ${output.code ?? "unknown"}`;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostEnvironment = yield* HostProcessEnvironment;
  const env = stripInheritedTmuxEnv(hostEnvironment);

  const skipped = (reason: WorktrunkHookSkipReason, projectCwd: string) =>
    Effect.logDebug("skipping Worktrunk lifecycle hooks", { reason, projectCwd }).pipe(
      Effect.as({ status: "skipped", reason } as const),
    );

  // A linked worktree's `.git` is a file naming its gitdir under the main
  // repository; that directory holds per-worktree state such as git's own
  // `locked` marker, and it is where the Worktrunk marker lives.
  const resolveMarkerPath = Effect.fn("WorktrunkHookRunner.resolveMarkerPath")(function* (
    worktreePath: string,
  ) {
    const contents = yield* fileSystem
      .readFileString(path.join(worktreePath, ".git"))
      .pipe(Effect.option);
    if (Option.isNone(contents)) return null;
    const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(contents.value);
    if (!match?.[1]) return null;
    return path.join(path.resolve(worktreePath, match[1]), WORKTRUNK_MARKER_FILE);
  });

  const isWorktrunkWorktree: WorktrunkHookRunner["Service"]["isWorktrunkWorktree"] = Effect.fn(
    "WorktrunkHookRunner.isWorktrunkWorktree",
  )(function* (worktreePath) {
    const marker = yield* resolveMarkerPath(worktreePath);
    if (marker === null) return false;
    return yield* fileSystem.exists(marker).pipe(Effect.orElseSucceed(() => false));
  });

  const markWorktrunk = Effect.fn("WorktrunkHookRunner.markWorktrunk")(function* (
    worktreePath: string,
  ) {
    const marker = yield* resolveMarkerPath(worktreePath);
    const warn = (detail?: string) =>
      Effect.logWarning("Worktrunk worktree could not be marked; remove hooks will not run", {
        worktreePath,
        ...(detail ? { detail } : {}),
      });
    if (marker === null) return yield* warn();
    yield* fileSystem
      .writeFileString(marker, "")
      .pipe(Effect.catch((error) => warn(error.message)));
  });

  const gate = Effect.fn("WorktrunkHookRunner.gate")(function* (
    projectCwd: string,
  ): Effect.fn.Return<WorktrunkHookSkippedResult | null> {
    const configPath = path.join(projectCwd, ".config", "wt.toml");
    const hasConfig = yield* fileSystem.exists(configPath).pipe(Effect.orElseSucceed(() => false));
    if (!hasConfig) {
      return yield* skipped("missing-config", projectCwd);
    }

    const probe = yield* processRunner
      .run({
        command: "wt",
        args: ["--version"],
        env,
        extendEnv: false,
      })
      .pipe(Effect.result);
    if (probe._tag === "Failure") {
      if (!isMissingWorktrunk(probe.failure)) {
        yield* Effect.logDebug("Worktrunk binary probe failed", {
          projectCwd,
          detail: probe.failure.message,
        });
      }
      return yield* skipped("missing-binary", projectCwd);
    }
    if (probe.success.code !== 0 || probe.success.timedOut) {
      return yield* skipped("missing-binary", projectCwd);
    }
    return null;
  });

  const runHook = Effect.fn("WorktrunkHookRunner.runHook")(function* (input: {
    readonly operation: WorktrunkHookOperation;
    readonly projectCwd: string;
    readonly worktreePath: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
  }): Effect.fn.Return<WorktrunkHookCompletedResult | WorktrunkHookFailedResult> {
    const runResult = yield* processRunner
      .run({
        command: "wt",
        args: ["hook", input.operation, "--yes", ...input.args],
        cwd: input.cwd,
        timeout: HOOK_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        env,
        extendEnv: false,
      })
      .pipe(Effect.result);

    if (runResult._tag === "Failure") {
      const detail = runResult.failure.message;
      yield* Effect.logWarning(`Worktrunk ${input.operation} hook failed`, {
        projectCwd: input.projectCwd,
        worktreePath: input.worktreePath,
        detail,
      });
      return {
        status: "failed",
        operation: input.operation,
        detail,
        exitCode: null,
        timedOut: runResult.failure._tag === "ProcessTimeoutError",
      } as const;
    }

    const output = runResult.success;
    if (output.code !== 0 || output.timedOut) {
      const detail = failureDetail(output);
      yield* Effect.logWarning(`Worktrunk ${input.operation} hook failed`, {
        projectCwd: input.projectCwd,
        worktreePath: input.worktreePath,
        exitCode: output.code,
        timedOut: output.timedOut,
        stderr: output.stderr,
        detail,
      });
      return {
        status: "failed",
        operation: input.operation,
        detail,
        exitCode: output.code,
        timedOut: output.timedOut,
      } as const;
    }

    yield* Effect.logInfo(`Worktrunk ${input.operation} hooks ran`, {
      projectCwd: input.projectCwd,
      worktreePath: input.worktreePath,
      stdout: output.stdout.trim(),
    });
    return { status: "completed" } as const;
  });

  const runCreateHooks: WorktrunkHookRunner["Service"]["runCreateHooks"] = Effect.fn(
    "WorktrunkHookRunner.runCreateHooks",
  )(function* (input) {
    // Mark before gating so a later removal still runs its hooks once `wt`
    // or the config shows up, as it would for a worktree `wt` created itself.
    yield* markWorktrunk(input.worktreePath);
    const gateResult = yield* gate(input.projectCwd);
    if (gateResult) return gateResult;

    // `wt` derives the base worktree from its own switch; a worktree git
    // created has none, so name the project checkout as the base path that
    // `{{ base_worktree_path }}` hooks copy from.
    const baseArgs = [`--base_worktree_path=${input.projectCwd}`];
    const preStart = yield* runHook({
      operation: "pre-start",
      projectCwd: input.projectCwd,
      worktreePath: input.worktreePath,
      cwd: input.worktreePath,
      args: baseArgs,
    });
    if (preStart.status === "failed") return preStart;

    return yield* runHook({
      operation: "post-start",
      projectCwd: input.projectCwd,
      worktreePath: input.worktreePath,
      cwd: input.worktreePath,
      args: baseArgs,
    });
  });

  const runPreRemoveHook: WorktrunkHookRunner["Service"]["runPreRemoveHook"] = Effect.fn(
    "WorktrunkHookRunner.runPreRemoveHook",
  )(function* (input) {
    const gateResult = yield* gate(input.projectCwd);
    if (gateResult) return gateResult;
    return yield* runHook({
      operation: "pre-remove",
      projectCwd: input.projectCwd,
      worktreePath: input.worktreePath,
      cwd: input.worktreePath,
      args: [],
    });
  });

  const runPostRemoveHook: WorktrunkHookRunner["Service"]["runPostRemoveHook"] = Effect.fn(
    "WorktrunkHookRunner.runPostRemoveHook",
  )(function* (input) {
    const gateResult = yield* gate(input.projectCwd);
    if (gateResult) return gateResult;
    return yield* runHook({
      operation: "post-remove",
      projectCwd: input.projectCwd,
      worktreePath: input.worktreePath,
      cwd: input.projectCwd,
      // The worktree is gone, so `wt` cannot infer it; pass the removed
      // path (and branch) as template variables for `{{ worktree_path }}`.
      args: [
        "--foreground",
        `--worktree_path=${input.worktreePath}`,
        ...(input.branch === undefined ? [] : [`--branch=${input.branch}`]),
      ],
    });
  });

  return WorktrunkHookRunner.of({
    isWorktrunkWorktree,
    runCreateHooks,
    runPreRemoveHook,
    runPostRemoveHook,
  });
});

export const layer = Layer.effect(WorktrunkHookRunner, make);
