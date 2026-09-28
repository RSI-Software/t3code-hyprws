/**
 * One-shot record of which windows were open, written just before an update
 * relaunch and consumed by the next launch.
 *
 * Upstream has a single window, so `quitAndInstall` relaunching into a bare
 * app is correct there. The fork's unit of organization is the project window,
 * so an update that silently collapses a workspace-per-project layout into one
 * hub window destroys the user's arrangement. This manifest is how that
 * arrangement crosses the restart.
 *
 * Manifest v2 keeps one row per window (its WindowId, route, bounds, and
 * Hyprland workspace), so extra all-projects or same-project windows come back
 * too. A v1 manifest, one row per identity, is still read.
 *
 * Deliberately not a general session store. It is written only on the install
 * path, deleted the moment it is read, and ignored once stale, so a normal
 * quit still starts clean and a crashed update never resurrects windows days
 * later.
 */
import {
  EnvironmentId,
  ProjectId,
  type ScopedProjectRef,
  type WindowScopeSeed,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import {
  normalizeMainWindowBounds,
  type DesktopWindowBounds,
} from "../settings/DesktopAppSettings.ts";
import { HyprlandPlacement } from "./HyprlandPlacement.ts";
import type { HyprlandWorkspaceRef } from "./hyprland.ts";
import { NEW_WINDOW_ROUTE } from "./WindowDispatch.fork.ts";
import { isWindowId, type WindowId } from "./WindowId.fork.ts";
import { windowIdentityKey, type WindowIdentity } from "./WindowIdentity.ts";

const { logInfo: logSessionInfo, logWarning: logSessionWarning } =
  makeComponentLogger("desktop.windowSession");

/**
 * A manifest older than this is assumed to belong to an install that never
 * completed, so its windows are not resurrected.
 */
export const WINDOW_SESSION_MAX_AGE_MS = 30 * 60 * 1_000;

/** The only capture reason a launch restores; any other manifest starts clean. */
const WINDOW_SESSION_RESTORE_REASON = "update";

/**
 * One window to reopen. Every window is its own entry, keyed by `windowId`, so
 * two all-projects windows or two windows on one project both come back.
 */
export type WindowRestoreEntry = {
  /**
   * The id the window had before the relaunch, reused so it keeps one id (and
   * the renderer state keyed by it) across the update. Absent for a manifest
   * written before ids existed.
   */
  readonly windowId?: WindowId;
  /** The hash route the window showed; `/` opens the window's home. */
  readonly route: string;
  /** The project the window was opened for, or all projects. */
  readonly seed: WindowScopeSeed;
  readonly bounds: DesktopWindowBounds | null;
  readonly workspace: HyprlandWorkspaceRef | null;
};

/** A live window as the install path captures it. */
export type CapturedWindow = {
  readonly windowId: WindowId;
  readonly identity: WindowIdentity;
  readonly route: string;
  readonly bounds: DesktopWindowBounds | null;
};

const WorkspaceDocument = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
});

const ProjectDocument = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
});

/** Manifest v2: one row per window. */
const WindowDocument = Schema.Struct({
  windowId: Schema.String,
  route: Schema.String,
  project: Schema.optionalKey(ProjectDocument),
  bounds: Schema.optionalKey(Schema.Unknown),
  workspace: Schema.optionalKey(Schema.NullOr(WorkspaceDocument)),
});

/** Manifest v1: one row per identity, read so an update from v1 still restores. */
const LegacyWindowDocument = Schema.Struct({
  windowId: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["hub", "project"]),
  environmentId: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.NullOr(WorkspaceDocument)),
});

// Rows stay unknown until read one at a time, so one bad row drops only itself.
const WindowSessionDocument = Schema.Struct({
  version: Schema.Number,
  reason: Schema.String,
  capturedAtMs: Schema.Number,
  windows: Schema.Array(Schema.Unknown),
});

type WindowSessionDocument = typeof WindowSessionDocument.Type;

const WindowSessionJson = fromLenientJson(WindowSessionDocument);
const decodeWindowSessionJson = Schema.decodeEffect(WindowSessionJson);
const encodeWindowSessionJson = Schema.encodeEffect(WindowSessionJson);
const decodeWindowDocument = Schema.decodeUnknownOption(WindowDocument);
const decodeLegacyWindowDocument = Schema.decodeUnknownOption(LegacyWindowDocument);

const CURRENT_VERSION = 2;
const LEGACY_VERSION = 1;
const MAX_ROUTE_LENGTH = 2_048;

/**
 * Whether `route` is a hash route this app could have shown: an absolute path
 * on the renderer's own origin, never a protocol-relative URL, with no
 * whitespace or control characters.
 */
function isRestorableRoute(route: string): boolean {
  return (
    route.length <= MAX_ROUTE_LENGTH &&
    route.startsWith("/") &&
    !route.startsWith("//") &&
    !/\s/u.test(route) &&
    Array.from(route).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
  );
}

function readProjectRef(environmentId: string | undefined, projectId: string | undefined) {
  const environment = environmentId?.trim() ?? "";
  const project = projectId?.trim() ?? "";
  if (environment.length === 0 || project.length === 0) return null;
  return {
    environmentId: EnvironmentId.make(environment),
    projectId: ProjectId.make(project),
  } satisfies ScopedProjectRef;
}

function toWindowDocument(
  window: CapturedWindow,
  workspace: HyprlandWorkspaceRef | null,
): typeof WindowDocument.Type {
  return {
    windowId: window.windowId,
    route: window.route,
    ...(window.identity.kind === "project"
      ? {
          project: {
            environmentId: window.identity.ref.environmentId,
            projectId: window.identity.ref.projectId,
          },
        }
      : {}),
    ...(window.bounds === null ? {} : { bounds: window.bounds }),
    workspace,
  };
}

function fromWindowDocument(row: unknown): WindowRestoreEntry | null {
  const document = Option.getOrNull(decodeWindowDocument(row));
  if (document === null || !isWindowId(document.windowId)) return null;
  const project =
    document.project === undefined
      ? undefined
      : readProjectRef(document.project.environmentId, document.project.projectId);
  if (project === null) return null;
  return {
    windowId: document.windowId,
    route: isRestorableRoute(document.route) ? document.route : NEW_WINDOW_ROUTE,
    seed: project ?? "all-projects",
    bounds: normalizeMainWindowBounds(document.bounds),
    workspace: document.workspace ?? null,
  };
}

function fromLegacyWindowDocument(row: unknown): WindowRestoreEntry | null {
  const document = Option.getOrNull(decodeLegacyWindowDocument(row));
  if (document === null) return null;
  const seed =
    document.kind === "hub"
      ? "all-projects"
      : readProjectRef(document.environmentId, document.projectId);
  if (seed === null) return null;
  return {
    ...(isWindowId(document.windowId) ? { windowId: document.windowId } : {}),
    route: NEW_WINDOW_ROUTE,
    seed,
    bounds: null,
    workspace: document.workspace ?? null,
  };
}

// v1 rows without an id keep v1's one-window-per-identity rule.
const legacyIdentityKey = (seed: WindowScopeSeed) =>
  windowIdentityKey(seed === "all-projects" ? { kind: "hub" } : { kind: "project", ref: seed });

/** Drops stale or non-update manifests and any window row that no longer decodes. */
export function readRestoreEntries(
  document: WindowSessionDocument,
  nowMs: number,
  maxAgeMs: number = WINDOW_SESSION_MAX_AGE_MS,
): readonly WindowRestoreEntry[] {
  if (document.reason !== WINDOW_SESSION_RESTORE_REASON) return [];
  const read =
    document.version === CURRENT_VERSION
      ? fromWindowDocument
      : document.version === LEGACY_VERSION
        ? fromLegacyWindowDocument
        : null;
  if (read === null) return [];
  const age = nowMs - document.capturedAtMs;
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return [];

  const entries: WindowRestoreEntry[] = [];
  const seen = new Set<string>();
  for (const row of document.windows) {
    const entry = read(row);
    if (entry === null) continue;
    const key = entry.windowId ?? legacyIdentityKey(entry.seed);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

export class DesktopWindowSession extends Context.Service<
  DesktopWindowSession,
  {
    /**
     * Records the open windows and the workspace each one occupies. Called on
     * the install path only, while the windows are still alive.
     */
    readonly capture: (windows: readonly CapturedWindow[], reason: string) => Effect.Effect<void>;
    /** Reads and deletes the manifest. Returns nothing when there is none. */
    readonly consume: Effect.Effect<readonly WindowRestoreEntry[]>;
  }
>()("@t3tools/desktop/window/DesktopWindowSession") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const placement = yield* HyprlandPlacement;
  const sessionPath = environment.windowSessionPath;

  const remove = fileSystem.remove(sessionPath).pipe(Effect.ignore);

  const capture = (windows: readonly CapturedWindow[], reason: string) =>
    Effect.gen(function* () {
      if (windows.length === 0) {
        yield* remove;
        return;
      }
      const entries: Array<typeof WindowDocument.Type> = [];
      for (const window of windows) {
        const workspace = yield* placement.workspaceOf(window.windowId);
        entries.push(toWindowDocument(window, Option.getOrNull(workspace)));
      }
      const capturedAtMs = yield* Clock.currentTimeMillis;
      const payload = yield* encodeWindowSessionJson({
        version: CURRENT_VERSION,
        reason,
        capturedAtMs,
        windows: entries,
      });
      yield* fileSystem
        .makeDirectory(environment.stateDir, { recursive: true })
        .pipe(Effect.ignore);
      yield* fileSystem.writeFileString(sessionPath, payload);
      yield* logSessionInfo("window session captured", {
        reason,
        windows: entries.length,
        placed: entries.filter((entry) => entry.workspace != null).length,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        logSessionWarning("failed to capture window session", { cause: String(cause) }),
      ),
      Effect.withSpan("desktop.windowSession.capture"),
    );

  const consume = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(sessionPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [];
    const contents = yield* fileSystem.readFileString(sessionPath);
    yield* remove;
    const document = yield* decodeWindowSessionJson(contents);
    const nowMs = yield* Clock.currentTimeMillis;
    const entries = readRestoreEntries(document, nowMs);
    yield* logSessionInfo("window session restored", {
      reason: document.reason,
      windows: entries.length,
    });
    return entries;
  }).pipe(
    Effect.catchCause((cause) =>
      logSessionWarning("failed to read window session; starting fresh", {
        cause: String(cause),
      }).pipe(Effect.andThen(remove), Effect.as([] as readonly WindowRestoreEntry[])),
    ),
    Effect.withSpan("desktop.windowSession.consume"),
  );

  return DesktopWindowSession.of({ capture, consume });
});

export const layer = Layer.effect(DesktopWindowSession, make);
