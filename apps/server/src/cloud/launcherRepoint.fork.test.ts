import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import { repointLaunchersFork } from "./launcherRepoint.fork.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

// A home with an installed old runtime, and an install.sh-style `bin/t3`
// symlink pointing at it.
const makeHome = Effect.fn("test.make_launcher_home")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launcher-repoint-test-" });
  const baseDir = path.join(root, "home");
  const versionsDir = path.join(baseDir, "runtime", "versions");
  const binDir = path.join(root, "bin");
  yield* fs.makeDirectory(path.join(versionsDir, "1.0.0"), { recursive: true });
  yield* fs.makeDirectory(binDir, { recursive: true });
  yield* fs.writeFileString(path.join(versionsDir, "1.0.0", "t3"), "#!/bin/sh\n");
  const launcher = path.join(binDir, "t3");
  const target = (version: string) => path.join(versionsDir, version, "t3");
  return { fs, path, root, baseDir, binDir, launcher, target };
});

const repoint = (
  home: Effect.Success<ReturnType<typeof makeHome>>,
  environment: NodeJS.ProcessEnv,
) =>
  repointLaunchersFork(home.fs, home.path, home.baseDir, "1.1.0").pipe(
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provideService(HostProcess.Platform, "linux"),
  );

const runResult = (stdout: string) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

// The self-update service with a fake release download, tar, and preflight,
// so the hook is proven at its seam rather than only in isolation.
const makeSelfUpdate = Effect.fn("test.make_launcher_self_update")(function* (
  home: Effect.Success<ReturnType<typeof makeHome>>,
  preflight: "ready" | "blocked",
) {
  const { fs, path } = home;
  const archiveBytes = new TextEncoder().encode("not really a tarball");
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", archiveBytes));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  const httpClient = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          request.url.endsWith("/SHA256SUMS")
            ? `${hex.join("")}  t3-1.1.0-linux-x64.tar.gz\n`
            : archiveBytes,
        ),
      ),
    ),
  );
  const preflightResult =
    preflight === "ready"
      ? { status: "ready", version: "1.1.0", launcherProtocol: SERVICE_LAUNCHER_PROTOCOL }
      : { status: "blocked", version: "1.1.0", reason: "local update required" };
  const preflightStdout = JSON.stringify(preflightResult);
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) => {
      if (input.command !== "tar") return Effect.succeed(runResult(preflightStdout));
      const stagingDir = input.args[input.args.indexOf("-C") + 1];
      if (stagingDir === undefined) return Effect.die("missing tar target");
      return fs
        .writeFileString(path.join(stagingDir, "t3"), "")
        .pipe(Effect.orDie, Effect.as(runResult("")));
    },
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), home.baseDir)),
  );
  return yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(
      ServiceLauncherClient.ServiceLauncherClient,
      ServiceLauncherClient.ServiceLauncherClient.of({
        managed: true,
        requestUpdate: () => Effect.succeed("launcher-id"),
        prepareTrial: Effect.undefined,
      }),
    ),
    Effect.provideService(DesktopAppUpdate.DesktopAppUpdate, {
      available: false,
      run: () => Effect.die("unexpected desktop app update run"),
      commit: () => Effect.die("unexpected desktop app update commit"),
    }),
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provide(ServerConfig.layer({ ...config, mode: "web" })),
  );
});

it.layer(NodeServices.layer)("launcher repoint on a client update", (it) => {
  it.effect("repoints the owned launcher once the service launcher accepts the update", () =>
    Effect.gen(function* () {
      const home = yield* makeHome();
      yield* home.fs.symlink(home.target("1.0.0"), home.launcher);
      const selfUpdate = yield* makeSelfUpdate(home, "ready");
      yield* selfUpdate
        .update({ targetVersion: "1.1.0" })
        .pipe(Effect.provideService(HostProcess.Environment, { PATH: home.binDir }));
      expect(yield* home.fs.readLink(home.launcher)).toBe(home.target("1.1.0"));
    }),
  );

  it.effect("leaves the launcher when the staged preflight refuses the update", () =>
    Effect.gen(function* () {
      const home = yield* makeHome();
      yield* home.fs.symlink(home.target("1.0.0"), home.launcher);
      const selfUpdate = yield* makeSelfUpdate(home, "blocked");
      yield* selfUpdate
        .update({ targetVersion: "1.1.0" })
        .pipe(Effect.provideService(HostProcess.Environment, { PATH: home.binDir }), Effect.flip);
      expect(yield* home.fs.readLink(home.launcher)).toBe(home.target("1.0.0"));
    }),
  );

  it.effect("finds the install default bin dir when the service PATH omits it", () =>
    Effect.gen(function* () {
      const home = yield* makeHome();
      const defaultBin = home.path.join(home.root, ".local", "bin");
      yield* home.fs.makeDirectory(defaultBin, { recursive: true });
      yield* home.fs.symlink(home.target("1.0.0"), home.path.join(defaultBin, "t3"));
      expect(yield* repoint(home, { HOME: home.root, PATH: "/nonexistent" })).toEqual([
        home.path.join(defaultBin, "t3"),
      ]);
      expect(yield* home.fs.readLink(home.path.join(defaultBin, "t3"))).toBe(home.target("1.1.0"));
    }),
  );

  it.effect("leaves a launcher for another home and a plain copy alone", () =>
    Effect.gen(function* () {
      const home = yield* makeHome();
      const foreignTarget = home.path.join(
        home.root,
        "other",
        "runtime",
        "versions",
        "1.0.0",
        "t3",
      );
      yield* home.fs.symlink(foreignTarget, home.launcher);
      const copyDir = home.path.join(home.root, "copy");
      yield* home.fs.makeDirectory(copyDir);
      yield* home.fs.writeFileString(home.path.join(copyDir, "t3"), "#!/bin/sh\n");
      expect(yield* repoint(home, { PATH: `${home.binDir}:${copyDir}` })).toEqual([]);
      expect(yield* home.fs.readLink(home.launcher)).toBe(foreignTarget);
      expect(yield* home.fs.readFileString(home.path.join(copyDir, "t3"))).toBe("#!/bin/sh\n");
    }),
  );

  it.effect("does nothing when no launcher is installed", () =>
    Effect.gen(function* () {
      const home = yield* makeHome();
      expect(yield* repoint(home, { PATH: home.binDir })).toEqual([]);
    }),
  );
});
