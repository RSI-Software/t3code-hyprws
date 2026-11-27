// @effect-diagnostics nodeBuiltinImport:off - builds a real worktree layout on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { runDevRunnerWithInput } from "./dev-runner.ts";

const exitedProcess = ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(1),
  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  isRunning: Effect.succeed(false),
  kill: () => Effect.void,
  unref: Effect.succeed(Effect.void),
  stdin: Sink.drain,
  stdout: Stream.empty,
  stderr: Stream.empty,
  all: Stream.empty,
  getInputFd: () => Sink.drain,
  getOutputFd: () => Stream.empty,
});

const makeWorktree = Effect.acquireRelease(
  Effect.sync(() => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devrunner-fork-"));
    NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    return root;
  }),
  (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
);

/** The environment dev-runner hands Vite+ for one `dev:server` run. */
const spawnedEnv = (input: {
  readonly cwd: string;
  readonly t3Home?: string;
  readonly port?: number;
  readonly ambient?: Record<string, string>;
  readonly home?: string;
}) =>
  Effect.gen(function* () {
    let captured: Record<string, string | undefined> | undefined;
    const spawner = ChildProcessSpawner.make((command) => {
      captured = (command as { readonly options?: { readonly env?: Record<string, string> } })
        .options?.env;
      return Effect.succeed(exitedProcess);
    });
    yield* runDevRunnerWithInput({
      mode: "dev:server",
      t3Home: input.t3Home,
      browser: undefined,
      autoBootstrapProjectFromCwd: undefined,
      logWebSocketEvents: undefined,
      host: undefined,
      port: input.port,
      devUrl: undefined,
      dryRun: false,
      share: false,
      seed: false,
      built: false,
      runArgs: [],
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.ambient ?? {} })),
          Layer.succeed(NetService.NetService, {
            canListenOnHost: () => Effect.succeed(true),
            probeListenOnHost: () => Effect.succeed(true),
            isPortAvailableOnLoopback: () => Effect.succeed(true),
            hasListenerOnHost: () => Effect.succeed(false),
            reserveLoopbackPort: () => Effect.succeed(49_152),
            findAvailablePort: (port) => Effect.succeed(port),
          }),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.WorkingDirectory, input.cwd),
      Effect.provideService(HostProcess.HomeDirectory, input.home ?? NodeOS.homedir()),
      Effect.provideService(HostProcess.Environment, input.ambient ?? {}),
      Effect.scoped,
    );
    return captured;
  });

it.layer(NodeServices.layer)("dev-runner (fork)", (it) => {
  it.effect("a worktree ignores the live install's ambient T3CODE_PORT; --port still wins", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorktree;
      const ambient = { T3CODE_PORT: "3773" };
      assert.notEqual((yield* spawnedEnv({ cwd, ambient }))?.T3CODE_PORT, "3773");
      assert.equal((yield* spawnedEnv({ cwd, ambient, port: 4321 }))?.T3CODE_PORT, "4321");
    }).pipe(Effect.scoped),
  );

  it.effect("gives worktree dev Electron its own profile unless one is set", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorktree;
      const own = yield* spawnedEnv({ cwd });
      assert.equal(own?.T3CODE_DEV_ELECTRON_USER_DATA, NodePath.join(cwd, ".t3", "electron"));
      const preset = { T3CODE_DEV_ELECTRON_USER_DATA: "/tmp/mine" };
      const kept = yield* spawnedEnv({ cwd, ambient: preset });
      assert.equal(kept?.T3CODE_DEV_ELECTRON_USER_DATA, "/tmp/mine");
    }).pipe(Effect.scoped),
  );
  it.effect("runs worktree Claude from its own home with only the developer's sign-in", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorktree;
      const claude = NodePath.join(cwd, "home", ".claude");
      NodeFS.mkdirSync(claude, { recursive: true });
      const oauth = { accessToken: "a", expiresAt: 1, refreshToken: "r", refreshTokenExpiresAt: 2 };
      NodeFS.writeFileSync(
        NodePath.join(claude, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: oauth, mcpOAuth: { linear: {} } }),
      );
      NodeFS.writeFileSync(
        NodePath.join(claude, "settings.json"),
        JSON.stringify({
          apiKeyHelper: "helper",
          env: { ANTHROPIC_BASE_URL: "https://proxy", OTHER: "1" },
          hooks: { Stop: [] },
        }),
      );
      const env = yield* spawnedEnv({ cwd, home: NodePath.join(cwd, "home") });
      const own = NodePath.join(cwd, ".t3", "claude");
      assert.equal(env?.CLAUDE_CONFIG_DIR, own);
      assert.equal(env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
      const read = (name: string) =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(own, name), "utf8")) as unknown;
      assert.deepEqual(read(".credentials.json"), {
        claudeAiOauth: { accessToken: "a", expiresAt: 1 },
      });
      assert.deepEqual(read("settings.json"), {
        apiKeyHelper: "helper",
        env: { ANTHROPIC_BASE_URL: "https://proxy" },
      });
      const explicit = yield* spawnedEnv({ cwd, t3Home: NodePath.join(cwd, "explicit-home") });
      assert.isUndefined(explicit?.CLAUDE_CONFIG_DIR);
    }).pipe(Effect.scoped),
  );
  it.effect("disables zmux for worktree state unless opted back in", () =>
    Effect.gen(function* () {
      const cwd = yield* makeWorktree;
      assert.equal((yield* spawnedEnv({ cwd }))?.T3CODE_ZMUX_DISABLED, "1");
      const optIn = { T3CODE_ZMUX_DISABLED: "0" };
      assert.equal((yield* spawnedEnv({ cwd, ambient: optIn }))?.T3CODE_ZMUX_DISABLED, "0");
      const explicit = yield* spawnedEnv({ cwd, t3Home: NodePath.join(cwd, "explicit-home") });
      assert.isUndefined(explicit?.T3CODE_ZMUX_DISABLED);
    }).pipe(Effect.scoped),
  );
});
