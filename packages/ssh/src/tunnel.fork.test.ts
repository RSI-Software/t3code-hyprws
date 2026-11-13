// @effect-diagnostics nodeBuiltinImport:off - Runs the generated runner in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { forkSupersedes } from "../../../scripts/lib/fork-supersedes.ts";
import { buildRemoteLaunchScript, buildRemoteT3RunnerScript } from "./tunnel.ts";

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
const NODE_SCRIPT = {
  nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
} as const;

describe("ssh tunnel scripts (fork)", () => {
  forkSupersedes({
    upstream:
      "packages/ssh/src/tunnel.test.ts > only downloads a release archive the host can run: $host",
    reason:
      "SSH installs fork release archives, so download failures must name the fork repository",
    commit: "5ca20b4128053f848a44a41935e87c8a2fbb925d",
  });
  it.each([
    { host: "Darwin x86_64", system: "Darwin", machine: "x86_64", downloads: false },
    { host: "Darwin arm64", system: "Darwin", machine: "arm64", downloads: true },
  ])(
    "only downloads a fork release archive the host can run: $host",
    ({ system, machine, downloads }) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-runner-"));
      try {
        const bin = NodePath.join(root, "bin");
        NodeFS.mkdirSync(bin);
        NodeFS.mkdirSync(NodePath.join(root, "home"));
        NodeFS.writeFileSync(
          NodePath.join(bin, "uname"),
          `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
          { mode: 0o755 },
        );
        NodeFS.writeFileSync(
          NodePath.join(bin, "curl"),
          "#!/bin/sh\necho 'download attempt' >&2\necho 'curl: (6) Could not resolve host: github.com' >&2\nexit 6\n",
          { mode: 0o755 },
        );
        const runner = NodePath.join(root, "run-t3.sh");
        NodeFS.writeFileSync(runner, buildRemoteT3RunnerScript(ARCHIVE));
        const result = NodeChildProcess.spawnSync("sh", [runner, "--version"], {
          encoding: "utf8",
          env: { HOME: NodePath.join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
        assert.notEqual(result.status, 0);
        if (downloads) {
          assert.include(result.stderr, "download attempt");
          assert.include(result.stderr, ARCHIVE.archiveVersion);
          assert.include(
            result.stderr,
            "https://github.com/RSI-Software/t3code-hyprws/releases/download",
          );
          assert.include(
            result.stderr,
            "https://raw.githubusercontent.com/RSI-Software/t3code-hyprws/hyprws/scripts/install.sh",
          );
        } else {
          assert.notInclude(result.stderr, "download attempt");
          assert.include(result.stderr, "has no t3 release archive.");
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("installs and runs the fork release archive without Node, npm, or npx", () => {
    const script = buildRemoteT3RunnerScript(ARCHIVE);

    assert.include(script, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(
      script,
      "T3_RELEASE_BASE_URL='https://github.com/RSI-Software/t3code-hyprws/releases/download'",
    );
    assert.include(script, 'T3_RUNTIME_DIR="$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION"');
    assert.include(script, 'T3_ARCHIVE="t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM_KEY.tar.gz"');
    assert.include(script, "SHA256SUMS");
    assert.include(script, 'exec "$T3_RUNTIME_DIR/t3" "$@"');
    assert.notInclude(script, "npx");
    assert.notInclude(script, "npm exec");
    assert.notInclude(script, "t3@latest");
    assert.notInclude(script, 'exec t3 "$@"');
    // Concurrent launches serialize on a per-version lock and recheck the
    // completion marker after acquiring it; upstream's tests own the lock body.
    assert.include(
      script,
      'T3_LOCK="$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock"',
    );
    assert.include(script, 'if [ "$T3_LOCK_WAITED" -ge 360 ]; then');
    assert.include(script, '"$T3_STAGING/SHA256SUMS" 30');
    assert.include(script, '"$T3_STAGING/$T3_ARCHIVE" 240');
    assert.notInclude(script, "T3_LOCK_CANDIDATE");
    assert.notInclude(script, "-mmin");
    assert.equal(script.split("if ! t3_runtime_ready; then").length - 1, 2);
    assert.isBelow(
      script.indexOf('"$T3_STAGING/t3" --version'),
      script.indexOf('> "$T3_STAGING/.install-complete"'),
    );
    // Node discovery is defined for the dev path but only ever invoked inside
    // the node-script branch, which the archive path skips entirely.
    assert.equal(script.split("ensure_remote_node_path || true").length - 1, 1);
    assert.isBelow(
      script.indexOf("ensure_remote_node_path || true"),
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
    );
    assert.isBelow(
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
      script.indexOf("T3_ARCHIVE_VERSION="),
    );

    const launch = buildRemoteLaunchScript({
      ...ARCHIVE,
      releaseBaseUrl: "https://mirror.example/t3/",
    });
    assert.include(launch, "T3_ARCHIVE_MODE=1");
    assert.include(launch, "T3_RELEASE_BASE_URL='https://mirror.example/t3'");
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"');
    assert.include(buildRemoteLaunchScript(NODE_SCRIPT), "T3_ARCHIVE_MODE=0");
  });
});
