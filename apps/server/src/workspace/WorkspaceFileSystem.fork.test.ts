// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot create a FIFO.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { projectFileRevision } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspaceFileSystemFork from "./WorkspaceFileSystem.fork.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
const ServerSettingsLayer = ServerSettings.layerTest();
const KnownWorkspacesLayer = Layer.mock(KnownWorkspaces.KnownWorkspaces)({
  assertContains: () => Effect.void,
});
const ProjectLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(KnownWorkspacesLayer),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provide(ServerSettingsLayer),
  WorkspaceFileSystemFork.oneWritePerFile,
);
const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(ServerSettingsLayer),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});
const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});
it.layer(TestLayer, { excludeTestServices: true })("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads through external workspace symlinks when globally enabled", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const serverSettings = yield* ServerSettings.ServerSettingsService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outsideDir = yield* makeTempDir;
        yield* writeTextFile(outsideDir, "plans/spec.md", "# Shared plan\n");
        yield* fileSystem.symlink(outsideDir, path.join(cwd, ".dump"));
        yield* serverSettings.updateSettings({ followExternalWorkspaceSymlinks: true });
        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: ".dump/plans/spec.md",
        });
        expect(result).toEqual({
          relativePath: ".dump/plans/spec.md",
          contents: "# Shared plan\n",
          byteLength: 14,
          truncated: false,
        });
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("refuses a save whose draft predates a disk change", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "README.md", "# Readme\n");
        const loadedRevision = projectFileRevision("# Readme\n");
        yield* writeTextFile(cwd, "README.md", "# Readme\nline from disk\n");

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "README.md",
            contents: "# Readme edited\n",
            expectedRevision: loadedRevision,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileChangedError");
        expect(yield* fileSystem.readFileString(path.join(cwd, "README.md"))).toBe(
          "# Readme\nline from disk\n",
        );
      }),
    );

    it.effect("refuses a save whose loaded file was deleted since", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "empty.md",
            contents: "draft\n",
            expectedRevision: projectFileRevision(""),
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileChangedError");
        expect(yield* fileSystem.exists(path.join(cwd, "empty.md"))).toBe(false);
      }),
    );

    it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      "refuses a save whose loaded file became a FIFO, without reading it",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const filePath = path.join(cwd, "README.md");
          yield* writeTextFile(cwd, "README.md", "# Readme\n");
          yield* fileSystem.remove(filePath);
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) =>
                NodeChildProcess.execFile("mkfifo", [filePath], (error) =>
                  error ? reject(error) : resolve(),
                ),
              ),
          );

          const error = yield* workspaceFileSystem
            .writeFile({
              cwd,
              relativePath: "README.md",
              contents: "# Readme edited\n",
              expectedRevision: projectFileRevision("# Readme\n"),
            })
            .pipe(Effect.flip);

          expect(error._tag).toBe("WorkspaceFileChangedError");
        }),
    );

    it.effect("reports an unreadable file as a failed read, not a disk change", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "README.md", "# Readme\n");
        yield* fileSystem.chmod(path.join(cwd, "README.md"), 0o000);

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "README.md",
            contents: "# Readme edited\n",
            expectedRevision: projectFileRevision("# Readme\n"),
          })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "WorkspaceFileSystemOperationError",
          operation: "read",
        });
      }),
    );

    it.effect("lets only one of two saves from the same disk version through, by any name", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "README.md", "# Readme\n");
        yield* fileSystem.symlink(path.join(cwd, "README.md"), path.join(cwd, "Alias.md"));
        yield* fileSystem.link(path.join(cwd, "README.md"), path.join(cwd, "Hard.md"));
        const save = (relativePath: string, contents: string) =>
          workspaceFileSystem
            .writeFile({
              cwd,
              relativePath,
              contents,
              expectedRevision: projectFileRevision("# Readme\n"),
            })
            .pipe(Effect.result);

        const saves = [
          save("README.md", "# From one\n"),
          save("Alias.md", "# From two\n"),
          save("Hard.md", "# From three\n"),
        ];
        const results = yield* Effect.all(saves, {
          concurrency: "unbounded",
        });

        expect(results.map((result) => result._tag).toSorted()).toEqual([
          "Failure",
          "Failure",
          "Success",
        ]);
      }),
    );

    it.effect("refuses a path outside the workspace before following it", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* makeTempDir;
        const followed: Array<string> = [];
        const watchedFileSystem = Layer.succeed(FileSystem.FileSystem, {
          ...fileSystem,
          stat: (target) => {
            followed.push(target);
            return fileSystem.stat(target);
          },
          realPath: (target) => {
            followed.push(target);
            return fileSystem.realPath(target);
          },
        });

        const failures = yield* Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          return yield* Effect.forEach(
            ["../outside.md", "//server/share/notes.md"],
            (relativePath) =>
              workspaceFileSystem.writeFile({ cwd, relativePath, contents: "x" }).pipe(Effect.flip),
          );
        }).pipe(Effect.provide(Layer.fresh(ProjectLayer).pipe(Layer.provide(watchedFileSystem))));

        expect(failures.map((failure) => failure._tag)).toEqual([
          "WorkspacePathOutsideRootError",
          "WorkspacePathOutsideRootError",
        ]);
        expect(followed).toEqual([]);
      }),
    );

    it.effect("saves over the disk version the draft started from", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "README.md", "# Readme\n");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "README.md",
          contents: "# Readme edited\n",
          expectedRevision: projectFileRevision("# Readme\n"),
        });

        expect(yield* fileSystem.readFileString(path.join(cwd, "README.md"))).toBe(
          "# Readme edited\n",
        );
      }),
    );
  });
});
