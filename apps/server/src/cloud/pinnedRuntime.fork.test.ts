import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import { forkServerTarballUrl } from "./forkRuntimeRelease.ts";
import { ensurePinnedRuntimeInstalled } from "./pinnedRuntime.ts";

// The fork publishes no npm package, so the upstream `t3@<version>` spec can
// never resolve a fork version. Everything else in the install stays upstream's.
const recordingRunner = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  commands: Array<ProcessRunner.ProcessRunInput>,
) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        commands.push(input);
        const stagingDir = input.args[input.args.indexOf("--prefix") + 1];
        if (stagingDir === undefined) return yield* Effect.die("missing npm --prefix");
        const entry = path.join(stagingDir, "node_modules", "t3", "dist", "bin.mjs");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(entry, "export {};\n").pipe(Effect.orDie);
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
  });

const install = (version: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-fork-" });
    const commands: Array<ProcessRunner.ProcessRunInput> = [];
    yield* ensurePinnedRuntimeInstalled({
      baseDir,
      version,
      fs,
      path,
      runner: recordingRunner(fs, path, commands),
      validate: () => Effect.void,
    });
    return commands;
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled (fork)", (it) => {
  it.effect("installs a fork version from its release tarball", () =>
    Effect.gen(function* () {
      const commands = yield* install("0.0.41-hyprws-nightly.20260910.406");
      assert.lengthOf(commands, 1);
      assert.equal(commands[0]?.command, "npm");
      assert.include(
        commands[0]?.args ?? [],
        forkServerTarballUrl("0.0.41-hyprws-nightly.20260910.406"),
      );
    }),
  );

  it.effect("leaves an upstream version on the registry spec", () =>
    Effect.gen(function* () {
      const commands = yield* install("1.2.3");
      assert.include(commands[0]?.args ?? [], "t3@1.2.3");
    }),
  );
});
