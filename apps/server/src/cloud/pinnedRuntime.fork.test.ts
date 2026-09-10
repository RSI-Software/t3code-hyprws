import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { forkServerTarballUrl } from "./forkRuntimeRelease.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  type PinnedRuntimePaths,
} from "./pinnedRuntime.ts";

// The fork publishes no npm package and no per-platform release archives, so a
// fork version installs the `npm pack`-shaped tarball its release publishes:
// the installer downloads `t3-<version>.tgz`, extracts the `package/` layout
// into the staging directory, and links the package bin to the `t3` entry the
// upstream archive layout guarantees. Everything else stays upstream's.
const tarBytes = new TextEncoder().encode("not really a tarball");

const install = (version: string, releaseBaseUrl?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-fork-" });
    const requests: string[] = [];
    const commands: Array<ProcessRunner.ProcessRunInput> = [];
    const validated: Array<PinnedRuntimePaths> = [];
    const archiveName = `t3-${version}-linux-x64.tar.gz`;
    const archiveHex = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", tarBytes)).pipe(
      Effect.map((digest) =>
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    );
    yield* ensurePinnedRuntimeInstalled({
      baseDir,
      version,
      fs,
      path,
      platform: "linux",
      arch: "x64",
      httpClient: HttpClient.make((request) => {
        requests.push(request.url);
        const body = request.url.endsWith("/SHA256SUMS")
          ? `${archiveHex}  ${archiveName}\n`
          : tarBytes;
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
      }),
      ...(releaseBaseUrl === undefined ? {} : { releaseBaseUrl }),
      runner: ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            commands.push(input);
            const targetIndex = input.args.indexOf("-C");
            const stagingDir = input.args[targetIndex + 1];
            if (input.command !== "tar" || stagingDir === undefined) {
              return yield* Effect.die(`unexpected command ${input.command}`);
            }
            if (input.args.includes("--strip-components=1") === false) {
              return yield* Effect.die("expected --strip-components=1");
            }
            // A fork tarball unpacks the npm-pack `package/` layout; an
            // upstream archive carries the executable at its stem's root.
            const entry =
              version === "1.2.3"
                ? path.join(stagingDir, "t3")
                : path.join(stagingDir, "dist", "bin.mjs");
            yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
            yield* fs.writeFileString(entry, "#!/bin/sh\n").pipe(Effect.orDie);
            return {
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
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
    });
    // Directory assertions live inside the scope: the staged base directory is
    // removed when the scope closes, before the it.effect body asserts.
    const entry = pinnedRuntimePaths(path, baseDir, version, "linux").entryPath;
    const published = {
      entryLink: Option.isSome(yield* fs.readLink(entry).pipe(Effect.option))
        ? yield* fs.readLink(entry)
        : null,
      entryExists: yield* fs.exists(entry),
      binExists: yield* fs.exists(path.join(path.dirname(entry), "dist", "bin.mjs")),
      sentinel: Option.isSome(
        yield* fs
          .readFileString(path.join(path.dirname(entry), ".install-complete"))
          .pipe(Effect.option),
      )
        ? yield* fs.readFileString(path.join(path.dirname(entry), ".install-complete"))
        : null,
    };
    return { requests, commands, validated, published };
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled (fork)", (it) => {
  it.effect("installs a fork version from its release tarball", () =>
    Effect.gen(function* () {
      const version = "0.0.41-hyprws-nightly.20260910.406";
      const { requests, commands, validated, published } = yield* install(version);
      assert.deepEqual(requests, [forkServerTarballUrl(version)]);
      assert.equal(commands.length, 1);
      assert.equal(commands[0]?.command, "tar");
      assert.isTrue(commands[0]?.args.includes("--strip-components=1"));
      assert.lengthOf(validated, 1);
      assert.equal(published.entryLink, "dist/bin.mjs");
      assert.isTrue(published.entryExists);
      assert.isTrue(published.binExists);
      assert.equal(published.sentinel, `${version}\n`);
    }),
  );

  it.effect("leaves an upstream version on the verified archive install", () =>
    Effect.gen(function* () {
      const { requests, commands, validated } = yield* install(
        "1.2.3",
        "https://releases.example/download",
      );
      assert.deepEqual(requests, [
        "https://releases.example/download/v1.2.3/SHA256SUMS",
        "https://releases.example/download/v1.2.3/t3-1.2.3-linux-x64.tar.gz",
      ]);
      assert.equal(commands.length, 1);
      assert.equal(commands[0]?.command, "tar");
      assert.isTrue(commands[0]?.args.includes("--strip-components=1"));
      assert.equal(validated[0]?.entryPath?.endsWith("t3"), true);
    }),
  );
});
