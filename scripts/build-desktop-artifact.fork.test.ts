// @effect-diagnostics nodeBuiltinImport:off - packaged-archive fixtures compute the sidecar digest with the same Node primitive as the builder.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  BundleNotSelfContainedError,
  BuildCommandFailedError,
  buildWslRuntimeArchiveArgs,
  parseWslRuntimeArchiveMembers,
  DesktopDmgBackgroundSourceMissingError,
  createStageWorkspaceConfig,
  createStagePatchedDependencies,
  createBuildConfig,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_EXTRA_RESOURCES,
  MAC_FILE_EXCLUSIONS,
  InvalidMacPasskeyRpDomainError,
  InvalidMacPasskeyPublishableKeyError,
  InvalidMockUpdateServerPortError,
  UnsupportedDesktopBuildArchitectureError,
  isMacPasskeySigningConfigurationError,
  LinuxIconResizeError,
  LinuxDesktopBuildPrerequisitesMissingError,
  MacDesktopBuildPrerequisitesMissingError,
  MacPasskeySigningConfigurationResolutionError,
  MissingMacPasskeyProvisioningProfileError,
  packWindowsServerAsar,
  preflightLinuxDesktopBuild,
  preflightMacDesktopBuild,
  preflightWindowsDesktopBuild,
  renderMacPasskeyEntitlements,
  resolveClerkPasskeyNativeArtifacts,
  resolveMacPasskeySigningConfiguration,
  resolveDesktopRuntimeDependencies,
  resolveMacStageDependencies,
  resolveFffNativeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveResourceMonitorRustTargets,
  resolveWindowsServerAsarIgnoreGlobs,
  resourceMonitorExecutableName,
  resolveGitHubPublishConfig,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  resolvePackageManagerUserAgent,
  stageLinuxIconSize,
  stageDesktopDmgBackground,
  stageResourceMonitor,
  stageWslRuntimeArchive,
  bundlesWslRuntime,
  STAGE_INSTALL_ARGS,
  ancestorNodeModulesPaths,
  copyDirectoryPreservingSymlinks,
  validateWindowsPackagedPayload,
  WindowsPrimaryNativeProbeError,
  WindowsDesktopBuildPrerequisitesMissingError,
  WindowsPackagedPayloadValidationError,
  WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT,
  WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
  WINDOWS_SERVER_EXTRA_RESOURCES,
  WINDOWS_SERVER_ASAR_RESOURCE,
  WINDOWS_SERVER_ASAR_UNPACK_GLOB,
  WINDOWS_SERVER_RESOURCE_SOURCE_DIR,
  WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_NAME,
  WSL_RUNTIME_ARCHIVE_NAME,
  WSL_RUNTIME_EXTRA_RESOURCES,
  wslRuntimeArchiveTarTarget,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
// A minimal stand-in for the staged sidecar roots packed into the WSL archive.
const stageWslRuntimeTreeFixture = Effect.fn("stageWslRuntimeTreeFixture")(function* (
  root: string,
  serverSource: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(root, "apps/server/dist"), { recursive: true });
  yield* fs.writeFileString(path.join(root, "apps/server/dist/bin.mjs"), serverSource);
  yield* fs.makeDirectory(path.join(root, "node_modules/node-pty/prebuilds/linux-x64"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    path.join(root, "node_modules/node-pty/package.json"),
    '{"name":"node-pty"}\n',
  );
  yield* fs.writeFileString(
    path.join(root, "node_modules/node-pty/prebuilds/linux-x64/pty.node"),
    "pty",
  );
});
function mockProcess(exitCode: number, stdout = "") {
  const encodedStdout = new TextEncoder().encode(stdout);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(encodedStdout) : Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}
function iconResizeSpawnerLayer(
  commands: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  }>,
  exitCodes: ReadonlyArray<number>,
) {
  let commandIndex = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockProcess(exitCodes[commandIndex++] ?? 0));
    }),
  );
}
const makeWindowsPayloadFixture = Effect.fn("test.makeWindowsPayloadFixture")(function* (input: {
  readonly copyUnpackedNatives: boolean;
  readonly serverEntrySource?: string;
  readonly wslRuntime?: "valid" | "forbidden" | "bad-digest";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-windows-payload-test-",
  });
  const sourceDir = path.join(tempDir, "server-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  const nativePath = path.join(sourceDir, "node_modules/native/addon.node");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
  yield* fs.writeFileString(serverEntryPath, input.serverEntrySource ?? "console.log('server');\n");
  yield* fs.writeFileString(nativePath, "native-binary");
  const generatedAsarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
  yield* packWindowsServerAsar({ sourceDir, asarPath: generatedAsarPath, arch: "x64" });
  const stageDistDir = path.join(tempDir, "dist");
  const packagedAppDir = path.join(stageDistDir, "win-unpacked");
  const resourcesDir = path.join(packagedAppDir, "resources");
  yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
  yield* fs.copyFile(generatedAsarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
  if (input.copyUnpackedNatives) {
    yield* fs.copy(
      `${generatedAsarPath}.unpacked`,
      path.join(resourcesDir, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`),
    );
  }
  yield* fs.writeFileString(
    path.join(resourcesDir, "resource-monitor/t3-resource-monitor.exe"),
    "monitor",
  );
  const appExecutableName = "t3code.exe";
  yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
  yield* fs.writeFileString(path.join(packagedAppDir, "chrome_crashpad_handler.exe"), "crashpad");
  if (input.wslRuntime !== undefined) {
    const wslSourceDir = path.join(tempDir, "wsl-source");
    const linuxPrebuildDir = path.join(wslSourceDir, "node_modules/node-pty/prebuilds/linux-x64");
    yield* fs.makeDirectory(path.join(wslSourceDir, "apps/server/dist"), { recursive: true });
    yield* fs.makeDirectory(linuxPrebuildDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(wslSourceDir, "apps/server/dist/bin.mjs"),
      "console.log('wsl server');\n",
    );
    yield* fs.writeFileString(
      path.join(wslSourceDir, "node_modules/node-pty/package.json"),
      '{"name":"node-pty"}',
    );
    yield* fs.writeFileString(path.join(linuxPrebuildDir, "pty.node"), "linux-pty");
    yield* fs.writeFileString(
      path.join(linuxPrebuildDir, "t3code-wsl-node-pty.json"),
      '{"arch":"x64"}',
    );
    if (input.wslRuntime === "forbidden") {
      const windowsPrebuildDir = path.join(
        wslSourceDir,
        "node_modules/node-pty/prebuilds/win32-x64",
      );
      yield* fs.makeDirectory(windowsPrebuildDir, { recursive: true });
      yield* fs.writeFileString(path.join(windowsPrebuildDir, "pty.node"), "windows-pty");
    }
    const archivePath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_NAME);
    const hashPath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_HASH_NAME);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const tar = yield* spawner.spawn(
      ChildProcess.make(
        "tar",
        [
          "-czf",
          wslRuntimeArchiveTarTarget(path.relative(wslSourceDir, archivePath)),
          "apps/server/dist",
          "node_modules",
        ],
        { cwd: wslSourceDir, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      ),
    );
    assert.equal(Number(yield* tar.exitCode), 0);
    const archiveDigest = NodeCrypto.createHash("sha256");
    yield* fs
      .stream(archivePath)
      .pipe(Stream.runForEach((chunk) => Effect.sync(() => archiveDigest.update(chunk))));
    yield* fs.writeFileString(
      hashPath,
      input.wslRuntime === "bad-digest"
        ? `${"0".repeat(64)}\n`
        : `${archiveDigest.digest("hex")}\n`,
    );
  }
  return {
    stageDistDir,
    packagedAppDir,
    sourceDir,
    generatedAsarPath,
    appExecutableName,
  } as const;
});
it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves updater channels for upstream and fork release versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17-hyprws-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17-hyprws.2"), "latest");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });
});
