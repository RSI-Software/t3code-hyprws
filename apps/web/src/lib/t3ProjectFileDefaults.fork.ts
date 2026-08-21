import type { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

/**
 * The new-thread path's wait for the project file before using the global default. The
 * query never settles while the environment is unreachable, and a client-side draft must
 * not wait on the network, or a project whose environment is down renders nothing.
 */
const PROJECT_FILE_DEFAULTS_TIMEOUT_MS = 2000;

/** Bounds a query by the timeout; an expired query settles as an interrupt, which reads as no file. */
export const withProjectFileTimeoutFork =
  (
    query: typeof executeAtomQuery,
    timeoutMs = PROJECT_FILE_DEFAULTS_TIMEOUT_MS,
  ): typeof executeAtomQuery =>
  (registry, atom, options, reporter) =>
    query(registry, atom, { ...options, signal: AbortSignal.timeout(timeoutMs) }, reporter);
