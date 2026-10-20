import type { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

/**
 * How long the new-thread path waits for the project file before falling back
 * to the global default. The query never settles while the environment is
 * unreachable, and a draft is client-side state that must not wait on the
 * network: without this bound, opening a project whose environment is down
 * leaves the route stuck with nothing rendered.
 */
export const PROJECT_FILE_DEFAULTS_TIMEOUT_MS = 2000;

/** Bounds a query by the timeout; an expired query settles as an interrupt, which reads as no file. */
export const withProjectFileTimeoutFork =
  (
    query: typeof executeAtomQuery,
    timeoutMs = PROJECT_FILE_DEFAULTS_TIMEOUT_MS,
  ): typeof executeAtomQuery =>
  (registry, atom, options, reporter) =>
    query(registry, atom, { ...options, signal: AbortSignal.timeout(timeoutMs) }, reporter);
