import { stripInheritedTmuxEnv } from "@t3tools/shared/env";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

const ZMUX_OPERATION_TIMEOUT = "30 seconds";
const ZMUX_MAX_OUTPUT_BYTES = 64 * 1024;

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
  workspace: Schema.String,
  session: Schema.String,
  target: Schema.String,
  match: Schema.String,
  tmuxName: Schema.NullOr(Schema.String),
  nativeId: Schema.NullOr(Schema.String),
  serverId: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(Schema.NullOr(Schema.Number)),
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

export type ZmuxEnsureResult =
  | { readonly status: "disabled" | "unavailable" }
  | {
      readonly status: "ensured";
      readonly target: string;
      readonly workspace: string;
      readonly session: string;
    }
  | { readonly status: "failed"; readonly notice: ZmuxSessionNotice };

export type ZmuxResolveResult =
  | { readonly status: "disabled" | "unavailable" | "not-found" }
  | {
      readonly status: "resolved";
      readonly workspace?: string;
      readonly session?: string;
      readonly target: string;
      readonly match: string;
      readonly tmuxName?: string | null;
      readonly nativeId?: string | null;
      readonly serverId?: string | null;
      readonly createdAt?: number | null;
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

export interface ZmuxUnbindIdentity {
  readonly target: string;
  readonly nativeId: string;
  readonly serverId: string;
  readonly createdAt: number;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function protectedCleanupCommand(identity: ZmuxUnbindIdentity): string {
  return [
    "zmux session kill",
    shellQuote(identity.target),
    "--if-session-id",
    shellQuote(identity.nativeId),
    "--if-server-id",
    shellQuote(identity.serverId),
    "--if-created-at",
    shellQuote(String(identity.createdAt)),
    "--json",
  ].join(" ");
}

export type ZmuxPrepareUnbindResult =
  | { readonly status: "disabled" | "unavailable" | "not-found" | "not-worktree" }
  | { readonly status: "prepared"; readonly identity: ZmuxUnbindIdentity }
  | { readonly status: "failed"; readonly notice: ZmuxSessionNotice };

export class ZmuxSessionBinder extends Context.Service<
  ZmuxSessionBinder,
  {
    readonly bind: (
      worktreePath: string,
      options?: { readonly projectPath?: string },
    ) => Effect.Effect<ZmuxBindResult>;
    readonly ensure: (
      checkoutPath: string,
      options?: { readonly projectPath?: string },
    ) => Effect.Effect<ZmuxEnsureResult>;
    readonly resolve: (dir: string) => Effect.Effect<ZmuxResolveResult>;
    readonly prepareUnbind: (dir: string) => Effect.Effect<ZmuxPrepareUnbindResult>;
    readonly unbind: (identity: ZmuxUnbindIdentity) => Effect.Effect<ZmuxUnbindResult>;
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

function verificationFailure(detail: string): {
  readonly status: "failed";
  readonly notice: ZmuxSessionNotice;
} {
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
  const ensureSemaphore = yield* Semaphore.make(1);

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
          timeout: ZMUX_OPERATION_TIMEOUT,
          maxOutputBytes: ZMUX_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        }),
      ),
    );

  const runGit = (args: ReadonlyArray<string>) =>
    processRunner.run({
      command: "git",
      args,
      env,
      extendEnv: false,
      timeout: ZMUX_OPERATION_TIMEOUT,
      maxOutputBytes: ZMUX_MAX_OUTPUT_BYTES,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    });

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
    if (output.timedOut) {
      return {
        status: "failed",
        notice: {
          summary: "zmux session lookup timed out",
          detail: `zmux did not resolve ${dir} within ${ZMUX_OPERATION_TIMEOUT}`,
        },
      } as const;
    }
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
      workspace: decoded.success.workspace,
      session: decoded.success.session,
      target: decoded.success.target,
      match: decoded.success.match,
      tmuxName: decoded.success.tmuxName,
      nativeId: decoded.success.nativeId,
      ...(decoded.success.serverId === undefined ? {} : { serverId: decoded.success.serverId }),
      ...(decoded.success.createdAt === undefined ? {} : { createdAt: decoded.success.createdAt }),
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
    if (repairResult.success.timedOut) {
      return {
        status: "failed",
        notice: workspaceRepairNotice(
          `zmux workspace root repair timed out after ${ZMUX_OPERATION_TIMEOUT}`,
          workspace,
          projectPath,
        ),
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
    if (createResult._tag === "Success" && createResult.success.timedOut) {
      return {
        status: "failed",
        notice: {
          summary: "zmux workspace creation timed out",
          detail: `zmux did not create ${workspace} within ${ZMUX_OPERATION_TIMEOUT}`,
        },
      } as const;
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

  const checkoutFailure = (detail: string): ZmuxEnsureResult => ({
    status: "failed",
    notice: {
      summary: "Git checkout could not be verified",
      detail,
    },
  });

  const inspectCheckout = Effect.fn("ZmuxSessionBinder.inspectCheckout")(function* (
    checkoutPath: string,
  ) {
    const normalizedCheckout = path.normalize(path.resolve(checkoutPath));
    const identity = yield* runGit(["-C", normalizedCheckout, "rev-parse", "--show-toplevel"]).pipe(
      Effect.result,
    );
    if (identity._tag === "Failure") {
      return checkoutFailure(`Cannot inspect ${normalizedCheckout}: ${identity.failure.message}`);
    }
    if (identity.success.timedOut) {
      return checkoutFailure(`Git checkout inspection timed out for ${normalizedCheckout}`);
    }
    if (identity.success.code !== 0) {
      return checkoutFailure(
        `No Git checkout exists at ${normalizedCheckout}: ${fallbackDetail(identity.success)}`,
      );
    }
    const topLevel = identity.success.stdout.trim();
    if (!topLevel) {
      return checkoutFailure(`Git did not return a checkout root for ${normalizedCheckout}`);
    }
    const normalizedTopLevel = path.normalize(path.resolve(topLevel));
    const worktrees = yield* runGit([
      "-C",
      normalizedTopLevel,
      "worktree",
      "list",
      "--porcelain",
    ]).pipe(Effect.result);
    if (
      worktrees._tag === "Failure" ||
      worktrees.success.timedOut ||
      worktrees.success.code !== 0
    ) {
      return checkoutFailure(`Cannot inspect Git worktrees for ${normalizedTopLevel}`);
    }
    const canonicalWorktree = worktrees.success.stdout
      .split("\n")
      .find((line) => line.startsWith("worktree "))
      ?.slice("worktree ".length)
      .trim();
    if (!canonicalWorktree) {
      return checkoutFailure(`Git did not return a canonical worktree for ${normalizedTopLevel}`);
    }
    const head = yield* runGit(["-C", normalizedTopLevel, "symbolic-ref", "--quiet", "HEAD"]).pipe(
      Effect.result,
    );
    return {
      status: "verified",
      checkoutPath: normalizedTopLevel,
      projectPath: path.normalize(path.resolve(canonicalWorktree)),
      detachedHead: head._tag === "Failure" || head.success.timedOut || head.success.code !== 0,
    } as const;
  });

  const restoreExistingSession = Effect.fn("ZmuxSessionBinder.restoreExistingSession")(function* (
    checkoutPath: string,
    existing: Extract<ZmuxResolveResult, { readonly status: "resolved" }>,
  ): Effect.fn.Return<ZmuxEnsureResult> {
    if (!existing.workspace || !existing.session) {
      return verificationFailure(`zmux omitted the explicit identity for ${existing.target}`);
    }
    const restoreResult = yield* run(["open", existing.workspace, existing.session]).pipe(
      Effect.result,
    );
    if (restoreResult._tag === "Failure" && isMissingZmux(restoreResult.failure)) {
      yield* unavailable("bind", checkoutPath);
      return { status: "unavailable" } as const;
    }
    if (restoreResult._tag === "Success" && restoreResult.success.timedOut) {
      return {
        status: "failed",
        notice: {
          summary: "zmux session restoration timed out",
          detail: `zmux did not restore ${existing.target} within ${ZMUX_OPERATION_TIMEOUT}`,
        },
      } as const;
    }
    const restored = yield* resolveEnabled(checkoutPath);
    if (
      restored.status !== "resolved" ||
      restored.target !== existing.target ||
      restored.match !== existing.match ||
      restored.state !== "live" ||
      restored.tmuxName == null ||
      restored.nativeId == null
    ) {
      return verificationFailure(
        `expected ${existing.target} to resolve as the same live exact session after restoration`,
      );
    }
    if (!restored.workspace || !restored.session) {
      return verificationFailure(`zmux omitted the explicit identity for ${restored.target}`);
    }
    return {
      status: "ensured",
      target: restored.target,
      workspace: restored.workspace,
      session: restored.session,
    } as const;
  });

  const bindEnabled = Effect.fn("ZmuxSessionBinder.bindEnabled")(function* (
    worktreePath: string,
    options?: { readonly projectPath?: string },
  ): Effect.fn.Return<ZmuxBindResult> {
    let projectWorkspace: string | null = null;
    if (options?.projectPath) {
      const workspace = yield* ensureProjectWorkspace(options.projectPath);
      if (workspace.status !== "resolved") {
        return workspace;
      }
      const separator = workspace.target.lastIndexOf("/");
      projectWorkspace = separator === -1 ? workspace.target : workspace.target.slice(0, separator);
    }

    const adoptArgs = [
      "wt",
      "--adopt",
      worktreePath,
      ...(projectWorkspace && options?.projectPath
        ? ["--workspace", projectWorkspace, "--root", options.projectPath]
        : []),
      "--yes",
      "--json",
      "--no-switch",
    ];
    const runResult = yield* run(adoptArgs).pipe(Effect.result);
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
    if (output.timedOut) {
      return {
        status: "failed",
        notice: {
          summary: "zmux session adoption timed out",
          detail: `zmux did not adopt ${worktreePath} within ${ZMUX_OPERATION_TIMEOUT}`,
        },
      } as const;
    }
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
  });

  const bind: ZmuxSessionBinder["Service"]["bind"] = Effect.fn("ZmuxSessionBinder.bind")(
    function* (worktreePath, options) {
      if (!(yield* enabled)) return { status: "disabled" } as const;
      return yield* ensureSemaphore.withPermits(1)(bindEnabled(worktreePath, options));
    },
  );

  const ensure: ZmuxSessionBinder["Service"]["ensure"] = Effect.fn("ZmuxSessionBinder.ensure")(
    function* (checkoutPath, options) {
      if (!(yield* enabled)) return { status: "disabled" } as const;
      return yield* ensureSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const inspected = yield* inspectCheckout(checkoutPath);
          if (inspected.status !== "verified") return inspected;
          const normalizedCheckout = inspected.checkoutPath;
          const normalizedProject = options?.projectPath
            ? path.normalize(path.resolve(options.projectPath))
            : inspected.projectPath;
          if (normalizedProject !== inspected.projectPath) {
            return checkoutFailure(
              `${normalizedCheckout} belongs to ${inspected.projectPath}, not ${normalizedProject}`,
            );
          }
          const expectedMatch =
            normalizedCheckout === normalizedProject ? "workspace-main" : "worktree";
          const existing = yield* resolveEnabled(normalizedCheckout);
          if (existing.status === "resolved") {
            if (existing.match !== expectedMatch) {
              return verificationFailure(
                `expected ${normalizedCheckout} to resolve by ${expectedMatch}, got ${existing.match}`,
              );
            }
            if (
              expectedMatch === "worktree" &&
              (!existing.binding?.worktreePath ||
                path.normalize(path.resolve(existing.binding.worktreePath)) !== normalizedCheckout)
            ) {
              return verificationFailure(
                `managed target ${existing.target} is not bound to exact checkout ${normalizedCheckout}`,
              );
            }
            if (existing.state === "restorable") {
              return yield* restoreExistingSession(normalizedCheckout, existing);
            }
            if (
              existing.state === "live" &&
              existing.tmuxName != null &&
              existing.nativeId != null &&
              existing.workspace &&
              existing.session
            ) {
              return {
                status: "ensured",
                target: existing.target,
                workspace: existing.workspace,
                session: existing.session,
              } as const;
            }
            return verificationFailure(
              `expected ${existing.target} to be live or restorable, got ${existing.state ?? "unknown"}`,
            );
          }
          if (existing.status !== "not-found") return existing;
          if (inspected.detachedHead) {
            return checkoutFailure(
              `${normalizedCheckout} has a detached HEAD and cannot be adopted until a branch is checked out`,
            );
          }
          if (normalizedCheckout === normalizedProject) {
            const result = yield* ensureProjectWorkspace(normalizedProject);
            if (result.status !== "resolved") return result;
            if (!result.target.endsWith("/main") || result.match !== "workspace-main") {
              return verificationFailure(
                `expected the canonical checkout ${normalizedProject} to resolve a literal main session, got ${result.target}`,
              );
            }
            if (result.state === "restorable") {
              return yield* restoreExistingSession(normalizedProject, result);
            }
            if (
              result.state !== "live" ||
              result.tmuxName == null ||
              result.nativeId == null ||
              !result.workspace ||
              !result.session
            ) {
              return verificationFailure(
                `expected ${result.target} to be a live exact workspace-main session after ensure`,
              );
            }
            return {
              status: "ensured",
              target: result.target,
              workspace: result.workspace,
              session: result.session,
            } as const;
          }

          const result = yield* bindEnabled(normalizedCheckout, {
            projectPath: normalizedProject,
          });
          switch (result.status) {
            case "bound":
              const resolved = yield* resolveEnabled(normalizedCheckout);
              if (resolved.status !== "resolved" || resolved.target !== result.target) {
                return verificationFailure(
                  `expected ${result.target} to retain its exact resolver identity after adoption`,
                );
              }
              if (!resolved.workspace || !resolved.session) {
                return verificationFailure(
                  `zmux omitted the explicit identity for ${resolved.target}`,
                );
              }
              return {
                status: "ensured",
                target: resolved.target,
                workspace: resolved.workspace,
                session: resolved.session,
              } as const;
            case "disabled":
              return { status: "disabled" } as const;
            case "unavailable":
              return { status: "unavailable" } as const;
            case "failed":
              return { status: "failed", notice: result.notice } as const;
          }
        }),
      );
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

  const prepareUnbind: ZmuxSessionBinder["Service"]["prepareUnbind"] = Effect.fn(
    "ZmuxSessionBinder.prepareUnbind",
  )(function* (dir) {
    const resolved = yield* resolve(dir);
    if (resolved.status !== "resolved") {
      return resolved;
    }
    if (resolved.match !== "worktree") {
      return { status: "not-worktree" } as const;
    }

    if (
      resolved.state !== "live" ||
      !resolved.nativeId ||
      !resolved.serverId ||
      !Number.isSafeInteger(resolved.createdAt) ||
      (resolved.createdAt ?? 0) <= 0
    ) {
      return {
        status: "failed",
        notice: {
          summary: "zmux session cleanup identity could not be prepared",
          detail: `Session ${resolved.target} did not provide an exact cleanup identity. Its processes and durable record will be preserved; inspect the surviving logical target with \`zmux tabs ${shellQuote(resolved.target)}\` before any manual cleanup.`,
        },
      } as const;
    }

    return {
      status: "prepared",
      identity: {
        target: resolved.target,
        nativeId: resolved.nativeId,
        serverId: resolved.serverId,
        createdAt: resolved.createdAt!,
      },
    } as const;
  });

  const unbind: ZmuxSessionBinder["Service"]["unbind"] = Effect.fn("ZmuxSessionBinder.unbind")(
    function* (identity) {
      const runResult = yield* run([
        "session",
        "kill",
        identity.target,
        "--if-session-id",
        identity.nativeId,
        "--if-server-id",
        identity.serverId,
        "--if-created-at",
        String(identity.createdAt),
        "--json",
      ]).pipe(Effect.result);
      if (runResult._tag === "Failure") {
        if (isMissingZmux(runResult.failure)) {
          yield* unavailable("unbind", identity.target);
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
      return { status: "unbound", target: identity.target } as const;
    },
  );

  return ZmuxSessionBinder.of({ bind, ensure, resolve, prepareUnbind, unbind });
});

export const layer = Layer.effect(ZmuxSessionBinder, make);
