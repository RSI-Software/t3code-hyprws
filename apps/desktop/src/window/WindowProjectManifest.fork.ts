/**
 * Which projects each claimed Hyprland client shows, for tools outside the app.
 *
 * A provider process knows its project and checkout, never its window. A tool
 * that must act on "the window this work lives in" (CDP targeting, placing a
 * browser beside it) joins this file by compositor address instead of guessing
 * from titles, which carry user-editable display names and truncate at three.
 *
 * One file per app process, `$XDG_RUNTIME_DIR/t3code/windows-<pid>.json`,
 * replaced atomically on every change and removed on a clean quit, best-effort.
 * A crashed or interrupted process leaves its file behind; readers only consult the file for a pid that still
 * owns a live client, so a stale one is never joined.
 */
import { DesktopWindowProjectScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { WindowId } from "./WindowId.fork.ts";

const WINDOW_PROJECT_MANIFEST_VERSION = 1;

export const WindowProjectManifest = Schema.Struct({
  version: Schema.Literal(WINDOW_PROJECT_MANIFEST_VERSION),
  pid: Schema.Int,
  windows: Schema.Array(
    Schema.Struct({
      windowId: Schema.String,
      /** The Hyprland client address, `0x…`; null until the window is claimed. */
      address: Schema.NullOr(Schema.String),
      /** Null until the renderer publishes its filter. */
      scope: Schema.NullOr(DesktopWindowProjectScope),
    }),
  ),
});
export type WindowProjectManifest = typeof WindowProjectManifest.Type;

export const decodeWindowProjectManifestJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WindowProjectManifest),
);
const encodeWindowProjectManifestJson = Schema.encodeEffect(
  Schema.fromJsonString(WindowProjectManifest),
);

export function windowProjectManifestPath(
  runtimeDirectory: string | undefined,
  pid: number,
): string | null {
  const root = runtimeDirectory?.trim().replace(/\/+$/u, "") ?? "";
  return root.length === 0 ? null : `${root}/t3code/windows-${pid}.json`;
}

/** One entry per window that has an address or a scope, in window-id order. */
export function buildWindowProjectManifest(input: {
  readonly pid: number;
  readonly addresses: ReadonlyMap<WindowId, string>;
  readonly scopes: ReadonlyMap<WindowId, DesktopWindowProjectScope>;
}): WindowProjectManifest {
  const windowIds = [...new Set([...input.addresses.keys(), ...input.scopes.keys()])].toSorted();
  return {
    version: WINDOW_PROJECT_MANIFEST_VERSION,
    pid: input.pid,
    windows: windowIds.map((windowId) => ({
      windowId,
      address: input.addresses.get(windowId) ?? null,
      scope: input.scopes.get(windowId) ?? null,
    })),
  };
}

const stagingPath = (path: string) => `${path}.tmp`;

/** Write-then-rename, so a reader never sees a partial file. */
export const writeWindowProjectManifest = Effect.fn("desktop.windowProjectManifest.write")(
  function* (path: string, manifest: WindowProjectManifest) {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const directory = pathService.dirname(path);
    yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
    // The mode only applies on creation; an existing directory is narrowed too.
    yield* fileSystem.chmod(directory, 0o700);
    const staging = stagingPath(path);
    const payload = yield* encodeWindowProjectManifestJson(manifest);
    yield* fileSystem.writeFileString(staging, `${payload}\n`, { mode: 0o600 });
    yield* fileSystem.rename(staging, path);
  },
);

export const removeWindowProjectManifest = Effect.fn("desktop.windowProjectManifest.remove")(
  function* (path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.remove(path, { force: true });
    // A write that failed between write and rename leaves its staging file.
    yield* fileSystem.remove(stagingPath(path), { force: true });
  },
);
