// Fork-owned seam for the global external-workspace-symlink policy
// (RSI-Software/t3code-hyprws#951, reshaping 565594bd75).
//
// Upstream's read resolver hard-blocks any path whose resolved target leaves
// the workspace root. The fork adds a server-authoritative opt-in: when the
// `followExternalWorkspaceSymlinks` server setting is enabled, reads may cross
// symlinks whose targets are outside the root. The settings service is looked
// up optionally so the seam adds no requirement to `WorkspaceFileSystem.layer`
// — upstream files and test harnesses keep upstream text, and the production
// wiring in `server.ts` provides the service through one marked hook. Without
// the service (or on a settings error) the containment guard stays closed.
import { type ProjectWriteFileInput, projectFileRevision } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSettings from "../serverSettings.ts";
// Cycle-safe: only read when a write runs, after both modules load.
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const blocked = Effect.succeed(false);

export interface ExternalSymlinksFork {
  /**
   * Whether the read may proceed through a symlink whose resolved target sits
   * outside the workspace root. `resolvesOutsideWorkspace` is upstream's own
   * escape computation over the realpath.
   */
  readonly follows: (resolvesOutsideWorkspace: boolean) => Effect.Effect<boolean>;
}

/** @public Fork seam construction, part of the canonical fork module API. */
export const makeExternalSymlinksFork = (): ExternalSymlinksFork => ({
  follows: (resolvesOutsideWorkspace) =>
    resolvesOutsideWorkspace
      ? Effect.serviceOption(ServerSettings.ServerSettingsService).pipe(
          Effect.flatMap((maybeSettings) => {
            if (maybeSettings._tag !== "Some") return blocked;
            return maybeSettings.value.getSettings.pipe(
              Effect.map((settings) => settings.followExternalWorkspaceSymlinks),
              Effect.catchTags({
                ServerSettingsError: (error) => Effect.logWarning(error).pipe(Effect.as(false)),
              }),
            );
          }),
        )
      : blocked,
});

// Stale-write guard (RSI-Software/t3code-hyprws#1761): a save that names the
// disk version its draft started from is refused once the disk moved on, so an
// open editor never silently replaces an agent's or another editor's change.
export class WorkspaceFileChangedError extends Schema.TaggedError<WorkspaceFileChangedError>()(
  "WorkspaceFileChangedError",
  { workspaceRoot: Schema.String, relativePath: Schema.String },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' changed on disk since it was loaded.`;
  }
}

// Matches readFile's cap: the panel only edits files it read whole.
const COMPARED_MAX_BYTES = 1024 * 1024;

// Untraced: assertUnchangedSinceLoad already spans it.
const diskRevision = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  realTargetPath: string,
  input: ProjectWriteFileInput,
) {
  const failed = (operation: "stat" | "read") => (cause: PlatformError.PlatformError) =>
    new WorkspaceFileSystem.WorkspaceFileSystemOperationError({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
      resolvedPath: realTargetPath,
      operationPath: realTargetPath,
      operation,
      cause,
    });
  const stat = yield* fileSystem.stat(realTargetPath).pipe(
    // A file deleted since the load no longer holds the loaded version.
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
    Effect.mapError(failed("stat")),
  );
  // Only a regular file can hold the loaded version; reading a FIFO would block.
  if (Option.isNone(stat) || stat.value.type !== "File" || stat.value.size > COMPARED_MAX_BYTES)
    return null;
  const bytes = yield* fileSystem.readFile(realTargetPath).pipe(Effect.mapError(failed("read")));
  return projectFileRevision(new TextDecoder("utf-8").decode(bytes));
});

/** Refuses the write when the file no longer holds the draft's base version. */
export const assertUnchangedSinceLoad = Effect.fn("WorkspaceFileSystem.assertUnchangedSinceLoad")(
  function* (
    fileSystem: FileSystem.FileSystem,
    realTargetPath: string,
    input: ProjectWriteFileInput,
  ) {
    if (input.expectedRevision === undefined) return;
    if ((yield* diskRevision(fileSystem, realTargetPath, input)) === input.expectedRevision) return;
    return yield* new WorkspaceFileChangedError({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
  },
);

/**
 * Runs one write per file at a time, so two clients saving from the same disk
 * version cannot both pass the comparison before either writes.
 */
export const oneWritePerFile = <E, R>(
  layer: Layer.Layer<WorkspaceFileSystem.WorkspaceFileSystem, E, R>,
) =>
  Layer.effect(
    WorkspaceFileSystem.WorkspaceFileSystem,
    Effect.gen(function* () {
      const service = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const fileSystem = yield* FileSystem.FileSystem;
      const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
      const fileWriteLocks = new Map<
        string,
        { readonly lock: Semaphore.Semaphore; writers: number }
      >();
      return WorkspaceFileSystem.WorkspaceFileSystem.of({
        ...service,
        writeFile: Effect.fn("WorkspaceFileSystem.oneWritePerFile")(function* (input) {
          // Never follow a path upstream refuses, such as a UNC share; let it refuse it.
          const resolved = yield* workspacePaths
            .resolveRelativePathWithinRoot({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
            })
            .pipe(Effect.option);
          if (Option.isNone(resolved)) return yield* service.writeFile(input);
          const target = resolved.value.absolutePath;
          // Device and inode name the file itself, so every hard or symbolic link shares
          // its lock. A missing file has no version to race over, so its path will do.
          const key = yield* fileSystem.stat(target).pipe(
            Effect.map((info) =>
              Option.match(info.ino, {
                onNone: () => target,
                onSome: (ino) => `${info.dev}:${ino}`,
              }),
            ),
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.succeed(target),
            ),
            Effect.mapError(
              (cause) =>
                new WorkspaceFileSystem.WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: target,
                  operationPath: target,
                  operation: "stat",
                  cause,
                }),
            ),
          );
          const entry = fileWriteLocks.get(key) ?? { lock: Semaphore.makeUnsafe(1), writers: 0 };
          fileWriteLocks.set(key, entry);
          entry.writers += 1;
          return yield* entry.lock
            .withPermits(1)(service.writeFile(input))
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  entry.writers -= 1;
                  if (entry.writers === 0) fileWriteLocks.delete(key);
                }),
              ),
            );
        }),
      });
    }),
  ).pipe(Layer.provide(layer), Layer.provide(WorkspacePaths.layer));
