import type { ForkThreadEnvMode, ThreadEnvMode } from "@t3tools/contracts";

/**
 * Fork: the stored thread env mode — the wire type plus the fork-only
 * "worktrunk". Storage, the projection database, and t3.json speak this form;
 * it must never reach a wire field directly.
 */
export type StoredThreadEnvMode = ForkThreadEnvMode;

/**
 * True for every mode that gives the thread its own git worktree. `worktrunk`
 * is a `worktree` that also runs the repository's Worktrunk hooks, so code
 * deciding on worktree-shaped behaviour (branch pickers, base selection,
 * checkout mismatch) treats the two alike.
 */
export function isWorktreeEnvMode(mode: StoredThreadEnvMode): boolean {
  return mode !== "local";
}

/**
 * Fork: the same priority order as upstream's `resolveDefaultThreadEnvMode`
 * in `threadEnvMode.ts`, keeping the exact stored mode including "worktrunk".
 * Only fork-aware surfaces may consume this — pair the result through
 * {@link toWireThreadEnvModeFields} before it touches a wire field.
 */
export function resolveDefaultStoredThreadEnvMode(sources: {
  readonly projectSetting: StoredThreadEnvMode | null | undefined;
  readonly projectFile: StoredThreadEnvMode | null | undefined;
  readonly globalDefault: StoredThreadEnvMode;
}): StoredThreadEnvMode {
  return sources.projectSetting ?? sources.projectFile ?? sources.globalDefault;
}

/**
 * Fork: the wire stand-in for a stored thread mode. A released client only
 * decodes `local` and `worktree`, so `worktrunk` travels as the `worktree` it
 * behaves like and the `...Fork` sibling carries the exact value alongside.
 */
function toWireThreadEnvMode(mode: StoredThreadEnvMode): ThreadEnvMode {
  return mode === "worktrunk" ? "worktree" : mode;
}

/**
 * Fork: the field pair a `defaultThreadEnvMode` wire slot carries. The sibling
 * is omitted whenever the wire value is already exact, so the common case adds
 * no websocket bytes.
 */
export function toWireThreadEnvModeFields(mode: StoredThreadEnvMode): {
  readonly defaultThreadEnvMode: ThreadEnvMode;
  readonly defaultThreadEnvModeFork?: StoredThreadEnvMode;
} {
  const wire = toWireThreadEnvMode(mode);
  return wire === mode
    ? { defaultThreadEnvMode: wire }
    : { defaultThreadEnvMode: wire, defaultThreadEnvModeFork: mode };
}

/**
 * Fork: the same pair for a nullable override, where null means "no override"
 * and must survive the round trip as null rather than as a mode.
 */
export function toWireThreadEnvModeOverrideFields(mode: StoredThreadEnvMode | null): {
  readonly defaultThreadEnvMode: ThreadEnvMode | null;
  readonly defaultThreadEnvModeFork?: StoredThreadEnvMode;
} {
  return mode === null ? { defaultThreadEnvMode: null } : toWireThreadEnvModeFields(mode);
}

/**
 * Fork: the stored mode behind a wire field pair. The sibling wins when a fork
 * server sent one; otherwise the wire value is already the whole truth, which
 * is also what an older server that predates the sibling sends.
 */
export function fromWireThreadEnvModeFields(fields: {
  readonly defaultThreadEnvMode: ThreadEnvMode;
  readonly defaultThreadEnvModeFork?: StoredThreadEnvMode | undefined;
}): StoredThreadEnvMode;
export function fromWireThreadEnvModeFields(fields: {
  readonly defaultThreadEnvMode?: ThreadEnvMode | null | undefined;
  readonly defaultThreadEnvModeFork?: StoredThreadEnvMode | undefined;
}): StoredThreadEnvMode | null | undefined;
export function fromWireThreadEnvModeFields(fields: {
  readonly defaultThreadEnvMode?: ThreadEnvMode | null | undefined;
  readonly defaultThreadEnvModeFork?: StoredThreadEnvMode | undefined;
}): StoredThreadEnvMode | null | undefined {
  return fields.defaultThreadEnvModeFork ?? fields.defaultThreadEnvMode;
}
