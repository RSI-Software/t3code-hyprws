import { stripInheritedTmuxEnv } from "@t3tools/shared/env";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";

const HOOK_TIMEOUT = "5 minutes";

export type WorktrunkHookOperation = "pre-start" | "post-start" | "pre-remove" | "post-remove";

export type WorktrunkHookSkipReason = "disabled" | "missing-config" | "missing-binary";

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
 * created itself, so the worktree matches one made with `wt switch --create`.
 * Every hook runs headless through `wt hook <type> --yes`; `pre-*` hooks block
 * and `post-start` returns once `wt` has detached its hooks, exactly as the
 * `wt` commands do. The project record, `t3.json`, settings, `.config/wt.toml`,
 * and the `wt` binary gate every call, in that order; a skipped hook leaves
 * upstream behaviour untouched.
 */
export class WorktrunkHookRunner extends Context.Service<
  WorktrunkHookRunner,
  {
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
  const projectFileLoader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const projectRepository = yield* ProjectionProjectRepository;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const hostEnvironment = yield* HostProcessEnvironment;
  const env = stripInheritedTmuxEnv(hostEnvironment);

  const skipped = (reason: WorktrunkHookSkipReason, projectCwd: string) =>
    Effect.logDebug("skipping Worktrunk lifecycle hooks", { reason, projectCwd }).pipe(
      Effect.as({ status: "skipped", reason } as const),
    );

  // The project record's override wins over t3.json and settings. Hooks run
  // against the project checkout, so the record is the one whose workspace
  // root is that checkout; a group of checkouts each carries its own row.
  const projectOverride = Effect.fn("WorktrunkHookRunner.projectOverride")(function* (
    projectCwd: string,
  ) {
    const projects = yield* projectRepository.listAll().pipe(
      Effect.catch((error) =>
        Effect.logDebug(
          "Worktrunk hooks ignored the project override; projects could not be read",
          {
            projectCwd,
            detail: error.message,
          },
        ).pipe(
          Effect.as(
            [] as ReadonlyArray<{
              readonly workspaceRoot: string;
              readonly deletedAt: string | null;
              readonly worktrunkHooks?: boolean | null;
            }>,
          ),
        ),
      ),
    );
    const target = path.resolve(projectCwd);
    for (const project of projects) {
      if (project.deletedAt !== null || path.resolve(project.workspaceRoot) !== target) continue;
      if (project.worktrunkHooks != null) return project.worktrunkHooks;
    }
    return undefined;
  });

  const checkEnabled = Effect.fn("WorktrunkHookRunner.checkEnabled")(function* (
    projectCwd: string,
  ) {
    const override = yield* projectOverride(projectCwd);
    if (override !== undefined) return override;
    const settingsEnabled = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.worktrunkHooks),
      Effect.catch((error) =>
        Effect.logDebug("Worktrunk hooks disabled because settings could not be read", {
          projectCwd,
          detail: error.message,
        }).pipe(Effect.as(false)),
      ),
    );
    const projectFile = yield* projectFileLoader.load(projectCwd);
    return Option.getOrUndefined(projectFile)?.worktrunkHooks ?? settingsEnabled;
  });

  const gate = Effect.fn("WorktrunkHookRunner.gate")(function* (
    projectCwd: string,
  ): Effect.fn.Return<WorktrunkHookSkippedResult | null> {
    if (!(yield* checkEnabled(projectCwd))) {
      return yield* skipped("disabled", projectCwd);
    }

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

  return WorktrunkHookRunner.of({ runCreateHooks, runPreRemoveHook, runPostRemoveHook });
});

export const layer = Layer.effect(WorktrunkHookRunner, make);
