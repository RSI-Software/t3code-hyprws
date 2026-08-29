import type { ThreadEnvMode, WireThreadEnvMode } from "@t3tools/contracts";

/**
 * Canonical priority order for a project's default thread env mode:
 * per-project setting > checked-in t3.json > global server setting.
 *
 * An explicit composer pick outranks all of these; callers apply it before
 * consulting the defaults. Web resolves the sources imperatively at draft
 * creation, mobile reactively — both must route through this function so the
 * platforms cannot disagree on the order.
 */
export function resolveDefaultThreadEnvMode(sources: {
  readonly projectSetting: ThreadEnvMode | null | undefined;
  readonly projectFile: ThreadEnvMode | null | undefined;
  readonly globalDefault: ThreadEnvMode;
}): ThreadEnvMode {
  return sources.projectSetting ?? sources.projectFile ?? sources.globalDefault;
}

/**
 * True once the resolved default can no longer change: an explicit pick or a
 * source that outranks t3.json decided, or the file read settled. While
 * false, nothing may persist the provisional default (for example into a
 * draft's workspace selection) — it could differ from the final value.
 */
export function isDefaultThreadEnvModeSettled(sources: {
  readonly explicitMode: ThreadEnvMode | undefined;
  readonly projectSetting: ThreadEnvMode | null | undefined;
  readonly projectFilePending: boolean;
}): boolean {
  return (
    sources.explicitMode !== undefined ||
    sources.projectSetting != null ||
    !sources.projectFilePending
  );
}

/**
 * True for every mode that gives the thread its own git worktree. `worktrunk`
 * is a `worktree` that also runs the repository's Worktrunk hooks, so code
 * deciding on worktree-shaped behaviour (branch pickers, base selection,
 * checkout mismatch) treats the two alike.
 */
export function isWorktreeEnvMode(mode: ThreadEnvMode): boolean {
  return mode !== "local";
}

/**
 * Fork: the wire stand-in for a stored thread mode. A released client only
 * decodes `local` and `worktree`, so `worktrunk` travels as the `worktree` it
 * behaves like and the `...Fork` sibling carries the exact value alongside.
 */
export function toWireThreadEnvMode(mode: ThreadEnvMode): WireThreadEnvMode {
  return mode === "worktrunk" ? "worktree" : mode;
}

/**
 * Fork: the field pair a `defaultThreadEnvMode` wire slot carries. The sibling
 * is omitted whenever the wire value is already exact, so the common case adds
 * no websocket bytes.
 */
export function toWireThreadEnvModeFields(mode: ThreadEnvMode): {
  readonly defaultThreadEnvMode: WireThreadEnvMode;
  readonly defaultThreadEnvModeFork?: ThreadEnvMode;
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
export function toWireThreadEnvModeOverrideFields(mode: ThreadEnvMode | null): {
  readonly defaultThreadEnvMode: WireThreadEnvMode | null;
  readonly defaultThreadEnvModeFork?: ThreadEnvMode;
} {
  return mode === null ? { defaultThreadEnvMode: null } : toWireThreadEnvModeFields(mode);
}

/**
 * Fork: the stored mode behind a wire field pair. The sibling wins when a fork
 * server sent one; otherwise the wire value is already the whole truth, which
 * is also what an older server that predates the sibling sends.
 */
export function fromWireThreadEnvModeFields(fields: {
  readonly defaultThreadEnvMode: WireThreadEnvMode;
  readonly defaultThreadEnvModeFork?: ThreadEnvMode | undefined;
}): ThreadEnvMode;
export function fromWireThreadEnvModeFields(fields: {
  readonly defaultThreadEnvMode?: WireThreadEnvMode | null | undefined;
  readonly defaultThreadEnvModeFork?: ThreadEnvMode | undefined;
}): ThreadEnvMode | null | undefined;
export function fromWireThreadEnvModeFields(fields: {
  readonly defaultThreadEnvMode?: WireThreadEnvMode | null | undefined;
  readonly defaultThreadEnvModeFork?: ThreadEnvMode | undefined;
}): ThreadEnvMode | null | undefined {
  return fields.defaultThreadEnvModeFork ?? fields.defaultThreadEnvMode;
}
