import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { forkAppImageUrl } from "./forkRuntimeRelease.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  type PinnedRuntimePaths,
} from "./pinnedRuntime.ts";

// The fork publishes no npm package and no per-platform release archives, so a
// fork version installs the release AppImage the desktop already downloads:
// the installer downloads `T3-Code-x86_64.AppImage`, runs
// `--appimage-extract` in the staging directory (which unpacks to a fixed
// `squashfs-root`), and writes a `t3` shim that runs the extracted server
// entry through the AppImage's own Electron-as-Node runtime. Everything else
// stays upstream's.
const appImageBytes = new TextEncoder().encode("not really an AppImage");

interface ExtractCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
}

type ExtractBehavior = "succeed" | "fail" | "die";

const install = (options: {
  readonly version: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly downloadStatus?: number;
  readonly extractBehavior?: ExtractBehavior;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-fork-appimage-" });
    const requests: string[] = [];
    const extractCalls: ExtractCall[] = [];
    const validated: Array<PinnedRuntimePaths> = [];
    const platform = options.platform ?? "linux";
    const arch = options.arch ?? "x64";
    const downloadStatus = options.downloadStatus ?? 200;
    const extractBehavior = options.extractBehavior ?? "succeed";

    const exit = yield* ensurePinnedRuntimeInstalled({
      baseDir,
      version: options.version,
      fs,
      path,
      platform,
      arch,
      httpClient: HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(appImageBytes, { status: downloadStatus }),
          ),
        );
      }),
      runner: ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            extractCalls.push({ command: input.command, args: input.args, cwd: input.cwd });
            if (extractBehavior === "die") {
              return yield* Effect.die("extract crashed");
            }
            const code = extractBehavior === "fail" ? 1 : 0;
            if (code === 0 && input.cwd !== undefined) {
              // --appimage-extract always unpacks to `<cwd>/squashfs-root`.
              const bin = path.join(
                input.cwd,
                "squashfs-root",
                "resources",
                "app.asar",
                "apps",
                "server",
                "dist",
                "bin.mjs",
              );
              yield* fs.makeDirectory(path.dirname(bin), { recursive: true }).pipe(Effect.orDie);
              yield* fs.writeFileString(bin, "#!/usr/bin/env node\n").pipe(Effect.orDie);
              yield* fs
                .writeFileString(path.join(input.cwd, "squashfs-root", "t3code"), "#!/bin/sh\n", {
                  mode: 0o755,
                })
                .pipe(Effect.orDie);
            }
            return {
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(code),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
      validate: (paths) =>
        Effect.sync(() => {
          validated.push(paths);
        }),
    }).pipe(Effect.exit);

    // Directory assertions live inside the scope: the staged base directory is
    // removed when the scope closes, before the it.effect body asserts.
    const entry = pinnedRuntimePaths(path, baseDir, options.version, "linux").entryPath;
    const versionDir = path.dirname(entry);
    const published = {
      versionDirExists: yield* fs.exists(versionDir),
      entryExists: yield* fs.exists(entry),
      entryContent: Option.isSome(yield* fs.readFileString(entry).pipe(Effect.option))
        ? yield* fs.readFileString(entry)
        : null,
      binExists: yield* fs.exists(
        path.join(
          versionDir,
          "squashfs-root",
          "resources",
          "app.asar",
          "apps",
          "server",
          "dist",
          "bin.mjs",
        ),
      ),
      sentinel: Option.isSome(
        yield* fs.readFileString(path.join(versionDir, ".install-complete")).pipe(Effect.option),
      )
        ? yield* fs.readFileString(path.join(versionDir, ".install-complete"))
        : null,
    };
    return { exit, requests, extractCalls, validated, published };
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled (fork AppImage)", (it) => {
  it.effect("installs a fork version by extracting the release AppImage", () =>
    Effect.gen(function* () {
      const version = "0.0.41-hyprws-nightly.20260910.406";
      const { exit, requests, extractCalls, validated, published } = yield* install({ version });
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepEqual(requests, [forkAppImageUrl(version)]);
      assert.equal(extractCalls.length, 1);
      assert.isTrue(extractCalls[0]?.command.endsWith("T3-Code-x86_64.AppImage"));
      assert.deepEqual(extractCalls[0]?.args, ["--appimage-extract"]);
      assert.isDefined(extractCalls[0]?.cwd);
      assert.lengthOf(validated, 1);
      assert.isTrue(published.versionDirExists);
      assert.isTrue(published.entryExists);
      assert.isTrue(published.binExists);
      assert.include(published.entryContent ?? "", "ELECTRON_RUN_AS_NODE=1");
      assert.include(published.entryContent ?? "", "squashfs-root/t3code");
      assert.include(published.entryContent ?? "", '"$@"');
      assert.equal(published.sentinel, `${version}\n`);
    }),
  );

  it.effect("refuses a non-Linux or non-x64 host before downloading anything", () =>
    Effect.gen(function* () {
      const version = "0.0.41-hyprws.1";
      const { exit, requests, extractCalls, published } = yield* install({
        version,
        platform: "darwin",
        arch: "arm64",
      });
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(requests, []);
      assert.equal(extractCalls.length, 0);
      assert.isFalse(published.versionDirExists);
    }),
  );

  it.effect("leaves no sentinel when the AppImage download fails", () =>
    Effect.gen(function* () {
      const version = "0.0.41-hyprws.1";
      const { exit, extractCalls, published } = yield* install({
        version,
        downloadStatus: 404,
      });
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(extractCalls.length, 0);
      assert.isFalse(published.versionDirExists);
      assert.isNull(published.sentinel);
    }),
  );

  it.effect("leaves no sentinel when the extract step exits non-zero", () =>
    Effect.gen(function* () {
      const version = "0.0.41-hyprws.1";
      const { exit, extractCalls, published } = yield* install({
        version,
        extractBehavior: "fail",
      });
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(extractCalls.length, 1);
      assert.isFalse(published.versionDirExists);
      assert.isNull(published.sentinel);
    }),
  );
});
