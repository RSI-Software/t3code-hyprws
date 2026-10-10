import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";

/**
 * Environment variables every provider subprocess receives so tooling the agent runs can name
 * the owning T3 Code project and thread. Only a process serving exactly one app thread carries
 * them: shared processes (Codex, OpenCode 2.x) get neither id, Codex sets them per thread through
 * `codexThreadIdentityConfig`, and in-process Cursor is unsupported.
 */
const PROVIDER_SESSION_IDENTITY_ENV = {
  projectId: "T3CODE_PROJECT_ID",
  threadId: "T3CODE_THREAD_ID",
} as const;

export interface ProviderSessionIdentity {
  readonly projectId?: string | undefined;
  readonly threadId?: string | undefined;
}

/**
 * Returns `baseEnv` (or the server's own env) with the session identity
 * applied. Ids the session does not know are removed rather than left alone:
 * a server launched from inside another T3-hosted agent would otherwise leak
 * that agent's identity into every child it spawns.
 */
export function withProviderSessionIdentity(
  baseEnv: NodeJS.ProcessEnv | undefined,
  identity: ProviderSessionIdentity,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(baseEnv ?? process.env) };
  const apply = (name: string, value: string | undefined) => {
    if (value) env[name] = value;
    else delete env[name];
  };
  apply(PROVIDER_SESSION_IDENTITY_ENV.projectId, identity.projectId);
  apply(PROVIDER_SESSION_IDENTITY_ENV.threadId, identity.threadId);
  return env;
}

/**
 * Removes the session identity the server inherited from whatever launched it,
 * such as a shell inside another T3-hosted agent. Run once at server start:
 * in-process providers (the Cursor SDK) and terminals spawn from the server's
 * own environment, and would otherwise name that other thread as theirs.
 */
export const stripInheritedProviderSessionIdentity = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  delete environment[PROVIDER_SESSION_IDENTITY_ENV.projectId];
  delete environment[PROVIDER_SESSION_IDENTITY_ENV.threadId];
});

/** Environment for a process every thread of an instance shares. */
export function withoutProviderSessionIdentity(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return withProviderSessionIdentity(baseEnv, {});
}

/** The identity fields of a session input, so a spawner never holds the rest of it. */
export function providerSessionIdentity(input: ProviderSessionIdentity): ProviderSessionIdentity {
  return { projectId: input.projectId, threadId: input.threadId };
}

/**
 * Applies `identity` when the spawn belongs to a session. Spawns without one,
 * such as probes and text generation, keep their environment as built.
 */
export function withSessionIdentityWhenKnown(
  env: NodeJS.ProcessEnv,
  identity: ProviderSessionIdentity | undefined,
): NodeJS.ProcessEnv {
  return identity === undefined ? env : withProviderSessionIdentity(env, identity);
}

/**
 * Codex thread config overrides that give the thread's shell commands its
 * identity. Codex deep-merges them over `config.toml`, so a user's own
 * `shell_environment_policy` keeps its other keys. A thread without a known
 * project carries only its thread id, as every other adapter's env does.
 */
export function codexThreadIdentityConfig(identity: ProviderSessionIdentity): {
  readonly shell_environment_policy?: { readonly set: Readonly<Record<string, string>> };
} {
  const set: Record<string, string> = {};
  if (identity.projectId) set[PROVIDER_SESSION_IDENTITY_ENV.projectId] = identity.projectId;
  if (identity.threadId) set[PROVIDER_SESSION_IDENTITY_ENV.threadId] = identity.threadId;
  return Object.keys(set).length === 0 ? {} : { shell_environment_policy: { set } };
}

type ThreadShellProjections<E> = {
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<{ readonly projectId: ProjectId } | null, E>;
};

/**
 * The owning project of `threadId`, as an `OpenSessionInput` fragment. A thread
 * the projection cannot read opens without one, which removes any inherited id.
 */
export const providerSessionProjectId = <E>(
  projections: ThreadShellProjections<E>,
  threadId: ThreadId,
): Effect.Effect<{ readonly projectId?: ProjectId }> =>
  projections.getThreadShell(threadId).pipe(
    Effect.map((shell): { readonly projectId?: ProjectId } =>
      shell === null ? {} : { projectId: shell.projectId },
    ),
    Effect.orElseSucceed(() => ({})),
  );

type ThreadProjectRuntime = Pick<
  ProviderAdapterV2SessionRuntime,
  "ensureThread" | "resumeThread" | "forkThread" | "rollbackThread"
>;

/**
 * `runtime` with each thread call given its app thread's project id. A shared
 * runtime serves threads of many projects, so the id the session opened with
 * cannot stand in for the thread being started, resumed, forked, or reloaded.
 */
export const withThreadProjects = <R extends ThreadProjectRuntime, E>(
  projections: ThreadShellProjections<E>,
  runtime: R,
): R => {
  const projectOf = (threadId: ThreadId | null | undefined) =>
    threadId == null ? Effect.succeed({}) : providerSessionProjectId(projections, threadId);
  return {
    ...runtime,
    ensureThread: (input) =>
      projectOf(input.threadId).pipe(
        Effect.flatMap((project) => runtime.ensureThread({ ...input, ...project })),
      ),
    resumeThread: (input) =>
      projectOf(input.threadId ?? input.providerThread.appThreadId).pipe(
        Effect.flatMap((project) => runtime.resumeThread({ ...input, ...project })),
      ),
    forkThread: (input) =>
      projectOf(input.targetThreadId).pipe(
        Effect.flatMap((project) => runtime.forkThread({ ...input, ...project })),
      ),
    rollbackThread: (input) =>
      projectOf(input.providerThread.appThreadId).pipe(
        Effect.flatMap((project) => runtime.rollbackThread({ ...input, ...project })),
      ),
  };
};
