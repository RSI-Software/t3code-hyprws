import { type ProjectScript, ProjectId } from "@t3tools/contracts";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
}

export const GENERATED_SETUP_COMMAND = "vp run setup:worktree";

const LEGACY_GENERATED_SETUP_COMMANDS = new Map<string, ReadonlySet<string>>([
  [
    "Setup Worktree",
    new Set([
      "vp i && ln -sf $T3CODE_PROJECT_ROOT/.env .env && " +
        "ln -sf $T3CODE_PROJECT_ROOT/infra/relay/.env infra/relay/.env && " +
        "node apps/web/scripts/warm-dep-cache.ts",
      "vp i --frozen-lockfile && ln -sf $T3CODE_PROJECT_ROOT/.env .env && " +
        "ln -sf $T3CODE_PROJECT_ROOT/infra/relay/.env infra/relay/.env && " +
        "node apps/web/scripts/warm-dep-cache.ts",
      GENERATED_SETUP_COMMAND,
    ]),
  ],
  [
    "Setup Worktree (Windows)",
    new Set([
      'vp i && New-Item -ItemType SymbolicLink -Path .env -Target "$env:T3CODE_PROJECT_ROOT\\.env" -Force && ' +
        'New-Item -ItemType SymbolicLink -Path "infra\\relay\\.env" -Target "$env:T3CODE_PROJECT_ROOT\\infra\\relay\\.env" -Force && ' +
        "node apps\\web\\scripts\\warm-dep-cache.ts",
      'vp i --frozen-lockfile && New-Item -ItemType SymbolicLink -Path .env -Target "$env:T3CODE_PROJECT_ROOT\\.env" -Force && ' +
        'New-Item -ItemType SymbolicLink -Path "infra\\relay\\.env" -Target "$env:T3CODE_PROJECT_ROOT\\infra\\relay\\.env" -Force && ' +
        "node apps\\web\\scripts\\warm-dep-cache.ts",
    ]),
  ],
]);

function isGeneratedSetupScript(script: ProjectScript): boolean {
  const generatedCommands = LEGACY_GENERATED_SETUP_COMMANDS.get(script.name);
  return (
    generatedCommands?.has(script.command) === true &&
    script.icon === "configure" &&
    script.runOnWorktreeCreate &&
    script.previewUrl === undefined &&
    script.autoOpenPreview === undefined
  );
}

/** Refresh only exact generated setup commands; user-customized scripts remain untouched. */
export function refreshPersistedSetupScript(script: ProjectScript): ProjectScript {
  if (!isGeneratedSetupScript(script)) {
    return script;
  }
  if (script.name === "Setup Worktree" && script.command === GENERATED_SETUP_COMMAND) return script;

  return {
    ...script,
    name: "Setup Worktree",
    command: GENERATED_SETUP_COMMAND,
  };
}

export function refreshPersistedSetupScripts(
  scripts: ReadonlyArray<ProjectScript>,
): ReadonlyArray<ProjectScript> {
  let changed = false;
  let foundGeneratedSetup = false;
  const refreshed: ProjectScript[] = [];
  for (const script of scripts) {
    if (isGeneratedSetupScript(script)) {
      if (foundGeneratedSetup) {
        changed = true;
        continue;
      }
      foundGeneratedSetup = true;
    }
    const next = refreshPersistedSetupScript(script);
    changed ||= next !== script;
    refreshed.push(next);
  }
  return changed ? refreshed : scripts;
}

export class ProjectSetupScriptOperationError extends Schema.TaggedErrorClass<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "openTerminal", "writeCommand"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new ProjectSetupScriptOperationError({
                ...errorContext,
                operation: "resolveProject",
                cause,
              }),
          ),
        )
      : null;
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const persistedScript = setupProjectScript(project.scripts);
    if (!persistedScript) {
      return {
        status: "no-script",
      } as const;
    }

    const script = refreshPersistedSetupScript(persistedScript);
    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "openTerminal",
              cause,
            }),
        ),
      );
    yield* terminalManager
      .write({
        threadId: input.threadId,
        terminalId,
        data: `${script.command} && echo '[t3] setup script completed' || echo '[t3] setup script FAILED'\r`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "writeCommand",
              cause,
            }),
        ),
      );

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      terminalId,
      cwd,
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
