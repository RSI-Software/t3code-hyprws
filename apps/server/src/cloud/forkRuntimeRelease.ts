import { isForkServiceVersion } from "@t3tools/shared/forkVersion";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type * as ProcessRunner from "../processRunner.ts";
import { PinnedRuntimeInstallError } from "./pinnedRuntime.ts";

/**
 * The tgz helpers below stay only for the release workflow and the interim
 * `pinnedRuntimeInstallSpec`, pending their removal in a follow-up.
 * `installForkAppImage` further down is the actual pinned-runtime install path.
 */
const FORK_RELEASE_REPOSITORY = "RSI-Software/t3code-hyprws";

/** The release asset name `vp pm pack` writes for a server version. */
export const forkServerTarballName = (version: string): string => `t3-${version}.tgz`;

export const forkServerTarballUrl = (version: string): string =>
  `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/download/v${version}/${forkServerTarballName(version)}`;

/** The npm install spec for a pinned runtime: a fork release asset, else the registry. */
export const pinnedRuntimeInstallSpec = (version: string): string =>
  isForkServiceVersion(version) ? forkServerTarballUrl(version) : `t3@${version}`;

/**
 * The release AppImage `hyprws-release.yml` publishes for a version. It is
 * the fork runtime source `pinnedRuntime.ts` extracts a version's
 * `<versionDir>/t3` shim from: a self-contained Electron bundle that already
 * carries a working Node runtime, unlike the release tgz.
 */
export const forkAppImageUrl = (version: string): string =>
  `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/download/v${version}/T3-Code-x86_64.AppImage`;

const FORK_APPIMAGE_FILE = "T3-Code-x86_64.AppImage";
const FORK_APPIMAGE_INSTALL_TIMEOUT = Duration.minutes(10);

/**
 * The `t3` shim a fork install writes: `squashfs-root/t3code` is Electron's
 * own binary, so running it directly launches the desktop app. Passing
 * `ELECTRON_RUN_AS_NODE=1` makes it behave as a plain Node binary instead,
 * which is what lets it run the extracted server entry at
 * `resources/app.asar/apps/server/dist/bin.mjs` the same way the launcher
 * runs any other pinned runtime's `t3`, forwarding every argument.
 */
const forkAppImageShimScript = (): string =>
  [
    "#!/bin/sh",
    'here="$(cd "$(dirname "$0")" && pwd)"',
    'ELECTRON_RUN_AS_NODE=1 exec "$here/squashfs-root/t3code" "$here/squashfs-root/resources/app.asar/apps/server/dist/bin.mjs" "$@"',
    "",
  ].join("\n");

interface InstallForkAppImageInput {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/**
 * A fork version installs the release AppImage the desktop already downloads
 * (the fork ships no npm package and no per-platform server archives):
 * download `T3-Code-x86_64.AppImage`, extract it with `--appimage-extract`
 * into the staging directory, and write a `t3` shim that runs the extracted
 * server entry through the AppImage's own Electron-as-Node runtime.
 *
 * The AppImage format only runs on Linux x64, so every other host fails here
 * with a clear error before any network request.
 */
export const installForkAppImage = Effect.fn("cloud.pinned_runtime.install_fork_appimage")(
  function* (input: InstallForkAppImageInput, stagingDir: string) {
    const { fs, path } = input;
    if (input.platform !== "linux" || input.arch !== "x64") {
      return yield* new PinnedRuntimeInstallError({
        step: `installing the fork release AppImage on ${input.platform}-${input.arch} (Linux x64 only)`,
      });
    }
    const appImage = yield* input.httpClient
      .execute(HttpClientRequest.get(forkAppImageUrl(input.version)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) =>
          Effect.map(response.arrayBuffer, (buffer) => new Uint8Array(buffer)),
        ),
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "downloading the fork release AppImage", cause }),
        ),
        Effect.timeoutOrElse({
          duration: FORK_APPIMAGE_INSTALL_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new PinnedRuntimeInstallError({
                step: "downloading the fork release AppImage (timed out)",
              }),
            ),
        }),
      );
    const appImagePath = path.join(stagingDir, FORK_APPIMAGE_FILE);
    yield* fs
      .writeFile(appImagePath, appImage, { mode: 0o755 })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "writing the fork release AppImage", cause }),
        ),
      );
    const extractStep = "extracting the fork release AppImage";
    // --appimage-extract always unpacks to a fixed `squashfs-root` directory
    // under its cwd, so the cwd is the staging directory itself.
    yield* input.runner
      .run({
        command: appImagePath,
        args: ["--appimage-extract"],
        cwd: stagingDir,
        timeout: FORK_APPIMAGE_INSTALL_TIMEOUT,
      })
      .pipe(
        Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: extractStep, cause })),
        Effect.filterOrFail(
          (result) => result.code === 0,
          (result) =>
            new PinnedRuntimeInstallError({
              step: extractStep,
              exitCode: Number(result.code),
              stdoutLength: result.stdout.length,
              stderrLength: result.stderr.length,
            }),
        ),
      );
    yield* fs.remove(appImagePath, { force: true }).pipe(Effect.ignore);
    yield* fs
      .writeFileString(path.join(stagingDir, "t3"), forkAppImageShimScript(), { mode: 0o755 })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "writing the fork server entry shim", cause }),
        ),
      );
  },
);
