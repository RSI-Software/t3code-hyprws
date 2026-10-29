import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ExternalLauncher from "./externalLauncher.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.effect.skipIf(windowsHost)(
  "a boot service without a display launches editors on the user manager's display",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      const codePath = path.join(binDir, "code");
      yield* fileSystem.writeFileString(codePath, "#!/bin/sh\n");
      yield* fileSystem.chmod(codePath, 0o755);

      const spawned: ChildProcess.StandardCommand[] = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected a command");
          spawned.push(command);
          const stdout =
            command.command === "systemctl"
              ? "HOME=/home/t3\nDISPLAY=:1\nWAYLAND_DISPLAY=wayland-1\n"
              : "";
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );

      yield* Effect.gen(function* () {
        const launcher = yield* ExternalLauncher.ExternalLauncher;
        yield* launcher.launchEditor({ editor: "vscode", cwd: "/workspace" });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ExternalLauncher.layer.pipe(
              Layer.provide(
                Layer.merge(
                  NodeServices.layer,
                  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
                ),
              ),
            ),
            Layer.succeed(HostProcess.Platform, "linux"),
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { PATH: binDir } })),
          ),
        ),
        Effect.provideService(HostProcess.Environment, { PATH: binDir }),
      );

      const code = spawned.find((command) => command.command === "code");
      assert.deepEqual(code?.options.env, {
        PATH: binDir,
        DISPLAY: ":1",
        WAYLAND_DISPLAY: "wayland-1",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
