import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import type { ProviderAdapterV2SessionRuntime } from "../orchestration-v2/ProviderAdapter.ts";

/**
 * Environment variables every provider subprocess receives so tooling the
 * agent runs (shells, browser grounders, window resolvers) can name the
 * T3 Code project and thread that own it. The ids name the work, not a
 * window: any desktop window may show that thread.
 *
 * Only a process that serves exactly one app thread can carry the identity.
 * Orchestrator V2 adapters, by how each one runs its provider:
 *
 * - Claude, Pi, and the ACP agents (Grok, registry agents, Antigravity) spawn
 *   one process per session and receive the identity.
 * - OpenCode 1.x spawns one server per session and receives it; a configured
 *   external `serverUrl` is a server T3 never spawns.
 * - Codex and OpenCode 2.x run one process per instance that every thread
 *   shares, so that process receives neither id: a shared process cannot name
 *   one thread, and naming none beats misattributing work.
 * - Codex carries the identity per thread instead, through
 *   `shell_environment_policy.set` in the config overrides of `thread/start`,
 *   `thread/resume` and `thread/fork` (see `codexThreadIdentityConfig`). In
 *   codex-rs 0.159.3 that policy reaches the agent's exec/shell tool commands
 *   (`core/src/unified_exec/process_manager.rs`) and user `!` commands
 *   (`core/src/tasks/user_shell.rs`). It does not reach hooks, which replay the
 *   app-server's own environment (`hooks/src/registry.rs`), MCP stdio servers,
 *   which start from a fixed allowlist of it (`rmcp-client/src/utils.rs`), or a
 *   thread already running when the overrides arrive, which Codex ignores.
 * - Cursor runs its SDK agent inside the T3 server process, and the local SDK
 *   takes no environment, so it is not supported.
 */
const PROVIDER_SESSION_IDENTITY_ENV = {
  projectId: "T3CODE_PROJECT_ID",
  threadId: "T3CODE_THREAD_ID",
} as const;

/**
 * Boolean marker naming T3 Code as the host of a provider process, set to `1`
 * on every provider spawn, shared or per session. It says only that T3 Code
 * started the process, never which thread: a shared Codex or OpenCode 2
 * server still serves many threads, and each thread's own id comes from its
 * turn context. Hooks and plugins that run inside the provider process, which
 * the per-thread ids cannot reach, read this to tell T3 Code from a terminal.
 * Not `T3CODE_HOST`: that is the server's bind interface, and a T3 server an
 * agent starts must not inherit a bogus one.
 */
const T3CODE_PROVIDER_PROCESS_ENV = "T3CODE_PROVIDER_PROCESS";

export interface ProviderSessionIdentity {
  readonly projectId?: string | undefined;
  readonly threadId?: string | undefined;
}

/**
 * Returns `baseEnv` (or the server's own env) with the session identity
 * applied. Ids the session does not know are removed rather than left alone:
 * a server launched from inside another T3-hosted agent would otherwise leak
 * that agent's identity into every child it spawns. The host marker is set
 * whatever the identity, so a shared process carries it too.
 */
export function withProviderSessionIdentity(
  baseEnv: NodeJS.ProcessEnv | undefined,
  identity: ProviderSessionIdentity,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(baseEnv ?? process.env),
    [T3CODE_PROVIDER_PROCESS_ENV]: "1",
  };
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
 * own environment, and would otherwise name that other thread as theirs. The
 * host marker goes too: a user terminal is not a provider process.
 */
export const stripInheritedProviderSessionIdentity = Effect.gen(function* () {
  const environment = yield* HostProcessEnvironment;
  delete environment[PROVIDER_SESSION_IDENTITY_ENV.projectId];
  delete environment[PROVIDER_SESSION_IDENTITY_ENV.threadId];
  delete environment[T3CODE_PROVIDER_PROCESS_ENV];
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
