import { stripInheritedTmuxEnv } from "@t3tools/shared/env";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

const ZmuxBindOutput = Schema.Struct({
  session: Schema.Struct({
    qualified: Schema.String,
    tmuxName: Schema.String,
    tmuxId: Schema.String,
  }),
  worktree: Schema.Struct({
    path: Schema.String,
    branch: Schema.String,
  }),
  created: Schema.Boolean,
  reused: Schema.Boolean,
  restored: Schema.Boolean,
  renamed: Schema.Boolean,
});

const ZmuxResolveOutput = Schema.Struct({
  target: Schema.String,
  match: Schema.String,
  tmuxName: Schema.NullOr(Schema.String),
  nativeId: Schema.NullOr(Schema.String),
  state: Schema.String,
  binding: Schema.Struct({
    branch: Schema.NullOr(Schema.String),
    worktreePath: Schema.NullOr(Schema.String),
  }),
});

const ZmuxFailureOutput = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      message: Schema.optionalKey(Schema.String),
      detail: Schema.optionalKey(Schema.String),
    }),
  ),
});

const decodeBindOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(ZmuxBindOutput));
const decodeResolveOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(ZmuxResolveOutput));
const decodeFailureOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(ZmuxFailureOutput));

export interface ZmuxSessionNotice {
  readonly summary: string;
  readonly detail: string;
}

export type ZmuxBindOutcome = "created" | "reused" | "restored" | "renamed";

export type ZmuxBindResult =
  | { readonly status: "disabled" | "unavailable" }
  | {
      readonly status: "bound";
      readonly target: string;
      readonly outcome: ZmuxBindOutcome;
    }
  | { readonly status: "failed"; readonly notice: ZmuxSessionNotice };

export type ZmuxResolveResult =
  | { readonly status: "disabled" | "unavailable" | "not-found" }
  | {
      readonly status: "resolved";
      readonly target: string;
      readonly match: string;
      readonly tmuxName?: string | null;
      readonly nativeId?: string | null;
      readonly state?: string;
      readonly binding?: {
        readonly branch: string | null;
        readonly worktreePath: string | null;
      };
    }
  | { readonly status: "failed"; readonly notice: ZmuxSessionNotice };

export type ZmuxUnbindResult =
  | { readonly status: "disabled" | "unavailable" | "not-found" | "not-worktree" }
  | { readonly status: "unbound"; readonly target: string }
  | { readonly status: "failed"; readonly notice: ZmuxSessionNotice };

export class ZmuxSessionBinder extends Context.Service<
  ZmuxSessionBinder,
  {
    readonly bind: (
      worktreePath: string,
      options?: { readonly projectPath?: string },
    ) => Effect.Effect<ZmuxBindResult>;
    readonly resolve: (dir: string) => Effect.Effect<ZmuxResolveResult>;
    readonly unbind: (dir: string) => Effect.Effect<ZmuxUnbindResult>;
  }
>()("t3/zmux/ZmuxSessionBinder") {}

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

function isMissingZmux(error: ProcessRunner.ProcessRunError): boolean {
  return error._tag === "ProcessSpawnError" && hasMissingBinaryCause(error.cause);
}

function fallbackDetail(output: ProcessRunner.ProcessRunOutput): string {
  const detail = output.stderr.trim() || output.stdout.trim();
  return detail || `zmux exited with code ${output.code ?? "unknown"}`;
}

function bindOutcome(output: typeof ZmuxBindOutput.Type): ZmuxBindOutcome | null {
  const outcomes = [
    output.created ? "created" : null,
    output.reused ? "reused" : null,
    output.restored ? "restored" : null,
    output.renamed ? "renamed" : null,
  ].filter((outcome): outcome is ZmuxBindOutcome => outcome !== null);
  return outcomes.length === 1 ? outcomes[0]! : null;
}

function verificationFailure(detail: string): ZmuxBindResult {
  return {
    status: "failed",
    notice: {
      summary: "zmux session binding could not be verified",
      detail,
    },
  };
}

const failureDetail = Effect.fn("ZmuxSessionBinder.failureDetail")(function* (
  output: ProcessRunner.ProcessRunOutput,
) {
  const decoded = yield* decodeFailureOutput(output.stdout).pipe(
    Effect.map((value) => value.errors),
    Effect.orElseSucceed(() => []),
  );
  if (decoded.length === 0) {
    return fallbackDetail(output);
  }
  return decoded
    .map((error) => {
      const detail = error.message ?? error.detail;
      return detail ? `${error.code}: ${detail}` : error.code;
    })
    .join("; ");
});

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const hostEnvironment = yield* HostProcessEnvironment;
  const path = yield* Path.Path;
  const env = stripInheritedTmuxEnv(hostEnvironment);

  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.terminalSessionMode === "zmux"),
    Effect.catch((error) =>
      Effect.logDebug("zmux session binding disabled because settings could not be read", {
        detail: error.message,
      }).pipe(Effect.as(false)),
    ),
  );

  const run = (args: ReadonlyArray<string>, cwd?: string) =>
    Effect.logDebug("invoking zmux managed session command", {
      command: "zmux",
      args,
      ...(cwd ? { cwd } : {}),
    }).pipe(
      Effect.andThen(
        processRunner.run({
          command: "zmux",
          args,
          ...(cwd ? { cwd } : {}),
          env,
          extendEnv: false,
        }),
      ),
    );

  const unavailable = (operation: "bind" | "resolve" | "unbind", dir: string) =>
    Effect.logDebug("zmux is unavailable; skipping managed worktree session operation", {
      operation,
      dir,
    });

  const resolveEnabled = Effect.fn("ZmuxSessionBinder.resolveEnabled")(function* (dir: string) {
    const runResult = yield* run(["session", "resolve", "--cwd", dir, "--json"]).pipe(
      Effect.result,
    );
    if (runResult._tag === "Failure") {
      if (isMissingZmux(runResult.failure)) {
        yield* unavailable("resolve", dir);
        return { status: "unavailable" } as const;
      }
      return {
        status: "failed",
        notice: {
          summary: "zmux session lookup failed",
          detail: runResult.failure.message,
        },
      } as const;
    }

    const output = runResult.success;
    if (output.code !== 0) {
      return { status: "not-found" } as const;
    }

    const decoded = yield* decodeResolveOutput(output.stdout).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      return {
        status: "failed",
        notice: {
          summary: "zmux session lookup failed",
          detail: "zmux returned an invalid session resolution response",
        },
      } as const;
    }
    return {
      status: "resolved",
      target: decoded.success.target,
      match: decoded.success.match,
      tmuxName: decoded.success.tmuxName,
      nativeId: decoded.success.nativeId,
      state: decoded.success.state,
      binding: decoded.success.binding,
    } as const;
  });

  const workspaceRepairNotice = (
    detail: string,
    workspace: string,
    projectPath: string,
  ): ZmuxSessionNotice => ({
    summary: "zmux workspace root needs attention",
    detail: `${detail}. Inspect workspace ${workspace} with \`zmux ls ${workspace}\`, resolve its conflicting bindings, then run \`zmux workspace set-root ${workspace} <project-root>\` for ${projectPath}.`,
  });

  const unexpectedProjectMatchNotice = (
    workspace: string,
    projectPath: string,
    match: string,
  ): ZmuxSessionNotice => ({
    summary: "zmux workspace root needs attention",
    detail: `Project checkout ${projectPath} resolves as ${match}, not as the canonical workspace root. Inspect ${workspace} with \`zmux ls ${workspace}\` and resolve its conflicting bindings before retrying.`,
  });

  const repairProjectWorkspace = Effect.fn("ZmuxSessionBinder.repairProjectWorkspace")(function* (
    workspace: string,
    projectPath: string,
  ) {
    const repairResult = yield* run(["workspace", "set-root", workspace, projectPath]).pipe(
      Effect.result,
    );
    if (repairResult._tag === "Failure") {
      if (isMissingZmux(repairResult.failure)) {
        yield* unavailable("bind", projectPath);
        return { status: "unavailable" } as const;
      }
      return {
        status: "failed",
        notice: workspaceRepairNotice(repairResult.failure.message, workspace, projectPath),
      } as const;
    }
    if (repairResult.success.code !== 0) {
      return {
        status: "failed",
        notice: workspaceRepairNotice(
          yield* failureDetail(repairResult.success),
          workspace,
          projectPath,
        ),
      } as const;
    }

    const repaired = yield* resolveEnabled(projectPath);
    if (repaired.status === "resolved" && repaired.match === "workspace-main") {
      return repaired;
    }
    if (repaired.status === "resolved") {
      return {
        status: "failed",
        notice: unexpectedProjectMatchNotice(workspace, projectPath, repaired.match),
      } as const;
    }
    if (repaired.status !== "not-found") return repaired;
    return {
      status: "failed",
      notice: workspaceRepairNotice(
        "zmux accepted the workspace root update, but the project checkout still does not resolve",
        workspace,
        projectPath,
      ),
    } as const;
  });

  const ensureProjectWorkspace = Effect.fn("ZmuxSessionBinder.ensureProjectWorkspace")(function* (
    projectPath: string,
  ) {
    const existing = yield* resolveEnabled(projectPath);
    if (existing.status === "resolved") {
      if (existing.match === "workspace-main") return existing;
      const separator = existing.target.lastIndexOf("/");
      const workspace = separator === -1 ? existing.target : existing.target.slice(0, separator);
      return {
        status: "failed",
        notice: unexpectedProjectMatchNotice(workspace, projectPath, existing.match),
      } as const;
    }
    if (existing.status !== "not-found") {
      return existing;
    }

    const canonicalProjectPath = path.normalize(path.resolve(projectPath));
    const workspace = path.basename(canonicalProjectPath);
    const createResult = yield* run(["new", workspace], canonicalProjectPath).pipe(Effect.result);
    if (createResult._tag === "Failure" && isMissingZmux(createResult.failure)) {
      yield* unavailable("bind", canonicalProjectPath);
      return { status: "unavailable" } as const;
    }

    // `zmux new` owns an interactive attach after creating the workspace. A
    // server-side caller has no terminal, so resolution is the authoritative
    // success signal whether that attach returned zero or not.
    const created = yield* resolveEnabled(canonicalProjectPath);
    if (created.status === "resolved" && created.match === "workspace-main") {
      return created;
    }
    if (created.status === "unavailable") return created;
    if (created.status === "failed") return created;

    return yield* repairProjectWorkspace(workspace, canonicalProjectPath);
  });

  const bind: ZmuxSessionBinder["Service"]["bind"] = Effect.fn("ZmuxSessionBinder.bind")(
    function* (worktreePath, options) {
      if (!(yield* enabled)) {
        return { status: "disabled" } as const;
      }

      if (options?.projectPath) {
        const workspace = yield* ensureProjectWorkspace(options.projectPath);
        if (workspace.status !== "resolved") {
          return workspace;
        }
      }

      const runResult = yield* run([
        "wt",
        "--adopt",
        worktreePath,
        "--yes",
        "--json",
        "--no-switch",
      ]).pipe(Effect.result);
      if (runResult._tag === "Failure") {
        if (isMissingZmux(runResult.failure)) {
          yield* unavailable("bind", worktreePath);
          return { status: "unavailable" } as const;
        }
        return {
          status: "failed",
          notice: {
            summary: "zmux session failed to bind",
            detail: runResult.failure.message,
          },
        } as const;
      }

      const output = runResult.success;
      if (output.code !== 0) {
        return {
          status: "failed",
          notice: {
            summary: "zmux session failed to bind",
            detail: yield* failureDetail(output),
          },
        } as const;
      }

      const decoded = yield* decodeBindOutput(output.stdout).pipe(Effect.result);
      if (decoded._tag === "Failure") {
        return {
          status: "failed",
          notice: {
            summary: "zmux session failed to bind",
            detail: "zmux returned an invalid bind response",
          },
        } as const;
      }

      const outcome = bindOutcome(decoded.success);
      if (outcome === null) {
        return verificationFailure("zmux returned an invalid adoption outcome");
      }

      const resolved = yield* resolve(worktreePath);
      if (resolved.status === "unavailable") {
        return { status: "unavailable" } as const;
      }
      if (resolved.status === "disabled") {
        return { status: "disabled" } as const;
      }
      if (resolved.status !== "resolved") {
        const detail =
          resolved.status === "failed"
            ? resolved.notice.detail
            : `zmux session resolve did not return the adopted session for ${worktreePath}`;
        return verificationFailure(detail);
      }

      const expectedTarget = decoded.success.session.qualified;
      if (resolved.match !== "worktree") {
        return verificationFailure(
          `expected ${worktreePath} to resolve by worktree, got ${resolved.match}`,
        );
      }
      if (resolved.target !== expectedTarget) {
        return verificationFailure(
          `expected ${worktreePath} to resolve ${expectedTarget}, got ${resolved.target}`,
        );
      }
      if (resolved.state !== "live") {
        return verificationFailure(
          `expected ${expectedTarget} to be live after adoption, got ${resolved.state}`,
        );
      }
      if (resolved.tmuxName !== decoded.success.session.tmuxName) {
        return verificationFailure(
          `expected ${expectedTarget} native target ${decoded.success.session.tmuxName}, got ${resolved.tmuxName ?? "none"}`,
        );
      }
      if (resolved.nativeId !== decoded.success.session.tmuxId) {
        return verificationFailure(
          `expected ${expectedTarget} native identity ${decoded.success.session.tmuxId}, got ${resolved.nativeId ?? "none"}`,
        );
      }
      if (resolved.binding?.worktreePath !== decoded.success.worktree.path) {
        return verificationFailure(
          `expected ${expectedTarget} to bind ${decoded.success.worktree.path}, got ${resolved.binding?.worktreePath ?? "none"}`,
        );
      }
      if (resolved.binding?.branch !== decoded.success.worktree.branch) {
        return verificationFailure(
          `expected ${expectedTarget} to bind branch ${decoded.success.worktree.branch}, got ${resolved.binding?.branch ?? "none"}`,
        );
      }

      return { status: "bound", target: expectedTarget, outcome } as const;
    },
  );

  const resolve: ZmuxSessionBinder["Service"]["resolve"] = Effect.fn("ZmuxSessionBinder.resolve")(
    function* (dir) {
      if (!(yield* enabled)) {
        return { status: "disabled" } as const;
      }
      return yield* resolveEnabled(dir);
    },
  );

  const unbind: ZmuxSessionBinder["Service"]["unbind"] = Effect.fn("ZmuxSessionBinder.unbind")(
    function* (dir) {
      const resolved = yield* resolve(dir);
      if (resolved.status !== "resolved") {
        return resolved;
      }
      if (resolved.match !== "worktree") {
        return { status: "not-worktree" } as const;
      }

      const runResult = yield* run(["session", "kill", resolved.target]).pipe(Effect.result);
      if (runResult._tag === "Failure") {
        if (isMissingZmux(runResult.failure)) {
          yield* unavailable("unbind", dir);
          return { status: "unavailable" } as const;
        }
        return {
          status: "failed",
          notice: {
            summary: "zmux session failed to unbind",
            detail: runResult.failure.message,
          },
        } as const;
      }

      const output = runResult.success;
      if (output.code !== 0) {
        return {
          status: "failed",
          notice: {
            summary: "zmux session failed to unbind",
            detail: yield* failureDetail(output),
          },
        } as const;
      }
      return { status: "unbound", target: resolved.target } as const;
    },
  );

  return ZmuxSessionBinder.of({ bind, resolve, unbind });
});

export const layer = Layer.effect(ZmuxSessionBinder, make);
