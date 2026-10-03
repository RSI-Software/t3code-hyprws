import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
 *   shares, so they receive neither id: a shared process cannot name one
 *   thread, and naming none beats misattributing work. Codex could still carry
 *   it per thread through `shell_environment_policy.set` in its `thread/start`
 *   config overrides, which would need the project id on its thread inputs.
 * - Cursor runs its SDK agent inside the T3 server process, and the local SDK
 *   takes no environment, so it is not supported.
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
 * The owning project of `threadId`, as an `OpenSessionInput` fragment. A thread
 * the projection cannot read opens without one, which removes any inherited id.
 */
export const providerSessionProjectId = <E>(
  projections: {
    readonly getThreadShell: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly projectId: ProjectId } | null, E>;
  },
  threadId: ThreadId,
): Effect.Effect<{ readonly projectId?: ProjectId }> =>
  projections.getThreadShell(threadId).pipe(
    Effect.map((shell): { readonly projectId?: ProjectId } =>
      shell === null ? {} : { projectId: shell.projectId },
    ),
    Effect.orElseSucceed(() => ({})),
  );
