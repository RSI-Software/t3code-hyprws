// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, afterEach, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(
    WorkspaceEntries.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(VcsDriverRegistry.layer),
    ),
  ),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-entries-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const makeTempDir = Effect.fn(function* (opts?: { prefix?: string; git?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: opts?.prefix ?? "t3code-workspace-entries-",
  });
  if (opts?.git) {
    yield* git(dir, ["init"]);
  }
  return dir;
});
function writeTextFile(
  cwd: string,
  relativePath: string,
  contents = "",
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });
}
const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "WorkspaceEntries.test.git",
      command: "git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10000,
    });
    return result.stdout.trim();
  });
it.layer(TestLayer, { excludeTestServices: true })("WorkspaceEntries", (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  describe("list", () => {
    it.effect("includes gitignored files only when requested", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTempDir({ git: true });
        yield* writeTextFile(cwd, ".gitignore", ".dump/\nignored.txt\n");
        yield* writeTextFile(cwd, "src/index.ts", "export {};\n");
        yield* writeTextFile(cwd, ".dump/review/report.md", "# Review\n");
        yield* writeTextFile(cwd, "ignored.txt", "ignored\n");
        const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
        const hidden = yield* workspaceEntries.list({ cwd });
        const shown = yield* workspaceEntries.list({ cwd, includeIgnored: true });
        expect(hidden.entries.map((entry) => entry.path)).not.toContain(".dump/review/report.md");
        expect(shown.entries).toEqual(
          expect.arrayContaining([
            { path: ".dump", kind: "directory", ignored: true },
            { path: ".dump/review", kind: "directory", ignored: true },
            { path: ".dump/review/report.md", kind: "file", ignored: true },
            { path: "ignored.txt", kind: "file", ignored: true },
            { path: "src/index.ts", kind: "file" },
          ]),
        );
      }),
    );
  });
});
