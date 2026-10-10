import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { pinnedRuntimePaths, pinnedRuntimeVersionsDir } from "./pinnedRuntime.ts";

/**
 * Directories an install script may have put the `t3` launcher in: its
 * `T3CODE_INSTALL_BIN_DIR` override, every PATH entry, and its `~/.local/bin`
 * default. The service's PATH is not the user's shell PATH, so the default is
 * checked even when PATH omits it.
 */
const launcherCandidates = Effect.gen(function* () {
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const directories = [
    environment["T3CODE_INSTALL_BIN_DIR"],
    ...(environment["PATH"] ?? "").split(":"),
    environment["HOME"] ? path.join(environment["HOME"], ".local", "bin") : undefined,
  ].filter((entry): entry is string => entry !== undefined && entry.trim().length > 0);
  return [...new Set(directories.map((directory) => path.join(path.resolve(directory), "t3")))];
});

/**
 * Points every `install.sh` launcher owned by this home at the runtime a
 * client update just handed to the service launcher, as `t3 update` does for
 * the launcher it was started through. A launcher for another home, a plain
 * copy, or a failed write is left alone: the server update itself must not
 * fail over the PATH convenience link.
 */
const repointLaunchers = Effect.fn("cloud.server_self_update.repoint_launchers")(function* (
  baseDir: string,
  targetVersion: string,
) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  // The boot service, and with it client updates, exists only on Linux and macOS.
  if (platform === "win32") return [];
  const versionsDir = pinnedRuntimeVersionsDir(path, baseDir);
  const { entryPath } = pinnedRuntimePaths(path, baseDir, targetVersion, platform);
  // Loaded lazily: `cli/update.ts` reaches back to this module's importer
  // through `serverRuntimeState.ts` and `ServerEnvironment.ts`.
  const { repointLauncher } = yield* Effect.promise(() => import("../cli/update.ts"));
  const repointed: Array<string> = [];
  for (const candidate of yield* launcherCandidates) {
    const result = yield* repointLauncher({
      launchedAs: candidate,
      versionsDir,
      targetEntryPath: entryPath,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not repoint a t3 launcher.", {
          candidate,
          reason: error.reason,
        }).pipe(Effect.as(Option.none<string>())),
      ),
    );
    if (Option.isSome(result)) repointed.push(result.value);
  }
  if (repointed.length > 0) {
    yield* Effect.logInfo("Repointed t3 launchers to the updated runtime.", {
      launchers: repointed,
      targetVersion,
    });
  }
  return repointed;
});

export const repointLaunchersFork = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  baseDir: string,
  targetVersion: string,
) =>
  repointLaunchers(baseDir, targetVersion).pipe(
    // The launcher has already accepted the update, so nothing here may fail it.
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not repoint t3 launchers.", { cause }).pipe(Effect.as([])),
    ),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );
