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
 * Deliberately not a general session store. It is written only on the install
 * path, deleted the moment it is read, and ignored once stale, so a normal
 * quit still starts clean and a crashed update never resurrects windows days
 * later.
 */
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
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
import { HyprlandPlacement } from "./HyprlandPlacement.ts";
import type { HyprlandWorkspaceRef } from "./hyprland.ts";
import {
  HUB_WINDOW_IDENTITY,
  projectWindowIdentity,
  windowIdentityKey,
  type WindowIdentity,
} from "./WindowIdentity.ts";

const { logInfo: logSessionInfo, logWarning: logSessionWarning } =
  makeComponentLogger("desktop.windowSession");

/**
 * A manifest older than this is assumed to belong to an install that never
 * completed, so its windows are not resurrected.
 */
export const WINDOW_SESSION_MAX_AGE_MS = 30 * 60 * 1_000;

export type WindowRestoreEntry = {
  readonly identity: WindowIdentity;
  readonly workspace: HyprlandWorkspaceRef | null;
};

const WorkspaceDocument = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
});

const WindowDocument = Schema.Struct({
  kind: Schema.Literals(["hub", "project"]),
  environmentId: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.NullOr(WorkspaceDocument)),
});

const WindowSessionDocument = Schema.Struct({
  version: Schema.Number,
  reason: Schema.String,
  capturedAtMs: Schema.Number,
  windows: Schema.Array(WindowDocument),
});

type WindowSessionDocument = typeof WindowSessionDocument.Type;

const WindowSessionJson = fromLenientJson(WindowSessionDocument);
const decodeWindowSessionJson = Schema.decodeEffect(WindowSessionJson);
const encodeWindowSessionJson = Schema.encodeEffect(WindowSessionJson);

const CURRENT_VERSION = 1;

export function toWindowDocument(entry: WindowRestoreEntry): typeof WindowDocument.Type {
  const workspace = entry.workspace;
  return entry.identity.kind === "hub"
    ? { kind: "hub", workspace }
    : {
        kind: "project",
        environmentId: entry.identity.ref.environmentId,
        projectId: entry.identity.ref.projectId,
        workspace,
      };
}

export function fromWindowDocument(
  document: typeof WindowDocument.Type,
): WindowRestoreEntry | null {
  const workspace = document.workspace ?? null;
  if (document.kind === "hub") {
    return { identity: HUB_WINDOW_IDENTITY, workspace };
  }
  const environmentId = document.environmentId?.trim() ?? "";
  const projectId = document.projectId?.trim() ?? "";
  if (environmentId.length === 0 || projectId.length === 0) return null;
  return {
    identity: projectWindowIdentity(EnvironmentId.make(environmentId), ProjectId.make(projectId)),
    workspace,
  };
}

/** Drops stale manifests and any window row that no longer decodes. */
export function readRestoreEntries(
  document: WindowSessionDocument,
  nowMs: number,
  maxAgeMs: number = WINDOW_SESSION_MAX_AGE_MS,
): readonly WindowRestoreEntry[] {
  if (document.version !== CURRENT_VERSION) return [];
  const age = nowMs - document.capturedAtMs;
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return [];

  const entries: WindowRestoreEntry[] = [];
  const seen = new Set<string>();
  for (const window of document.windows) {
    const entry = fromWindowDocument(window);
    if (entry === null) continue;
    const key = windowIdentityKey(entry.identity);
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
    readonly capture: (
      identities: readonly WindowIdentity[],
      reason: string,
    ) => Effect.Effect<void>;
    /** Reads and deletes the manifest. Returns nothing when there is none. */
    readonly consume: Effect.Effect<readonly WindowRestoreEntry[]>;
  }
>()("@t3tools/desktop/window/DesktopWindowSession") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const placement = yield* HyprlandPlacement;
  const sessionPath = environment.windowSessionPath;

  const remove = fileSystem.remove(sessionPath).pipe(Effect.ignore);

  const capture = (identities: readonly WindowIdentity[], reason: string) =>
    Effect.gen(function* () {
      if (identities.length === 0) {
        yield* remove;
        return;
      }
      const entries: WindowRestoreEntry[] = [];
      for (const identity of identities) {
        const workspace = yield* placement.workspaceOf(windowIdentityKey(identity));
        entries.push({ identity, workspace: Option.getOrNull(workspace) });
      }
      const capturedAtMs = yield* Clock.currentTimeMillis;
      const payload = yield* encodeWindowSessionJson({
        version: CURRENT_VERSION,
        reason,
        capturedAtMs,
        windows: entries.map(toWindowDocument),
      });
      yield* fileSystem
        .makeDirectory(environment.stateDir, { recursive: true })
        .pipe(Effect.ignore);
      yield* fileSystem.writeFileString(sessionPath, payload);
      yield* logSessionInfo("window session captured", {
        reason,
        windows: entries.length,
        placed: entries.filter((entry) => entry.workspace !== null).length,
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
