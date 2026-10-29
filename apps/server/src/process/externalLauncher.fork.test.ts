import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ExternalLauncher from "./externalLauncher.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

type SessionManager = { readonly stdout: string } | { readonly spawnError: true };

const SESSION_MANAGER: SessionManager = {
  stdout: JSON.stringify({
    type: "as",
    data: ["HOME=/home/t3", "DISPLAY=:1", "XAUTHORITY=/home/t3/auth files/cookie"],
  }),
};

it.effect.skipIf(windowsHost)(
  "a boot service without a display gives editors and the file manager the user manager's display",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const binDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      for (const name of ["code", "xdg-open", "xdg-mime"]) {
        yield* fileSystem.writeFileString(path.join(binDir, name), "#!/bin/sh\n");
        yield* fileSystem.chmod(path.join(binDir, name), 0o755);
      }

      const run = (sessionManager: SessionManager) =>
        Effect.gen(function* () {
          const spawned: ChildProcess.StandardCommand[] = [];
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected a command");
              spawned.push(command);
              if (command.command === "busctl" && "spawnError" in sessionManager) {
                return yield* PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                });
              }
              const stdout =
                command.command === "busctl" && "stdout" in sessionManager
                  ? sessionManager.stdout
                  : command.command === "xdg-mime"
                    ? "org.gnome.Nautilus.desktop\n"
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

          const available = yield* Effect.gen(function* () {
            const launcher = yield* ExternalLauncher.ExternalLauncher;
            const available = yield* launcher.resolveAvailableEditors();
            yield* launcher.launchEditor({ editor: "vscode", cwd: "/workspace" });
            if (available.includes("file-manager")) {
              yield* launcher.launchEditor({ editor: "file-manager", cwd: "/workspace" });
            }
            yield* launcher.launchBrowser("https://example.com");
            return available;
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
          const launchEnv = (command: string, arg: string) =>
            spawned.find((spawn) => spawn.command === command && spawn.args.includes(arg))?.options
              .env;
          return {
            fileManager: available.includes("file-manager"),
            editor: launchEnv("code", "/workspace"),
            files: launchEnv("xdg-open", "/workspace"),
            browser: launchEnv("xdg-open", "https://example.com"),
          };
        });

      const session = { PATH: binDir, DISPLAY: ":1", XAUTHORITY: "/home/t3/auth files/cookie" };
      assert.deepEqual(yield* run(SESSION_MANAGER), {
        fileManager: true,
        editor: session,
        files: session,
        browser: { PATH: binDir },
      });
      // A broken or missing user manager keeps the server's own environment.
      for (const failure of [{ stdout: "invalid JSON" }, { spawnError: true as const }]) {
        assert.deepEqual(yield* run(failure), {
          fileManager: false,
          editor: { PATH: binDir },
          files: undefined,
          browser: { PATH: binDir },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
