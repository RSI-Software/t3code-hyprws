import type { ProviderSessionStartInput } from "@t3tools/contracts";

/**
 * Environment variables every provider subprocess receives so tooling the
 * agent runs (shells, browser grounders, window resolvers) can name the
 * T3 Code project and thread that own it. A project-scoped desktop window is
 * created with its project id as the window title, so `T3CODE_PROJECT_ID` is
 * the stable key back to the window hosting the agent.
 */
export const PROVIDER_SESSION_IDENTITY_ENV = {
  projectId: "T3CODE_PROJECT_ID",
  threadId: "T3CODE_THREAD_ID",
} as const;

type ProviderSessionIdentity = Pick<ProviderSessionStartInput, "projectId" | "threadId">;

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
