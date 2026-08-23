import { stripInheritedTmuxEnv } from "@t3tools/shared/env";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

const ZmuxBindOutput = Schema.Struct({
  session: Schema.Struct({
    qualified: Schema.String,
  }),
});

const ZmuxResolveOutput = Schema.Struct({
  target: Schema.String,
  match: Schema.String,
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

export type ZmuxBindResult =
  | { readonly status: "disabled" | "unavailable" }
  | { readonly status: "bound"; readonly target: string }
  | { readonly status: "failed"; readonly notice: ZmuxSessionNotice };

export type ZmuxResolveResult =
  | { readonly status: "disabled" | "unavailable" | "not-found" }
  | {
      readonly status: "resolved";
      readonly target: string;
      readonly match: string;
    }
  | { readonly status: "failed"; readonly notice: ZmuxSessionNotice };

export type ZmuxUnbindResult =
  | { readonly status: "disabled" | "unavailable" | "not-found" | "not-worktree" }
  | { readonly status: "unbound"; readonly target: string }
  | { readonly status: "failed"; readonly notice: ZmuxSessionNotice };

export class ZmuxSessionBinder extends Context.Service<
  ZmuxSessionBinder,
  {
    readonly bind: (worktreePath: string) => Effect.Effect<ZmuxBindResult>;
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
  const env = stripInheritedTmuxEnv(hostEnvironment);

  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.terminalSessionMode === "zmux"),
    Effect.catch((error) =>
      Effect.logDebug("zmux session binding disabled because settings could not be read", {
        detail: error.message,
      }).pipe(Effect.as(false)),
    ),
  );

  const run = (args: ReadonlyArray<string>) =>
    Effect.logDebug("invoking zmux managed session command", {
      command: "zmux",
      args,
    }).pipe(
      Effect.andThen(
        processRunner.run({
          command: "zmux",
          args,
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

  const bind: ZmuxSessionBinder["Service"]["bind"] = Effect.fn("ZmuxSessionBinder.bind")(
    function* (worktreePath) {
      if (!(yield* enabled)) {
        return { status: "disabled" } as const;
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
      return { status: "bound", target: decoded.success.session.qualified } as const;
    },
  );

  const resolve: ZmuxSessionBinder["Service"]["resolve"] = Effect.fn("ZmuxSessionBinder.resolve")(
    function* (dir) {
      if (!(yield* enabled)) {
        return { status: "disabled" } as const;
      }

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
      } as const;
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
