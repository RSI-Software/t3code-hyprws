// @effect-diagnostics nodeBuiltinImport:off - These integration fixtures exercise the pre-install Node bootstrap against real Git worktrees.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import {
  assessTrunkBase,
  captureGit,
  reconcileEnvironmentLink,
  reconcileEnvironmentLinks,
  resolveRepositoryRoots,
  resolveVpInstallCommand,
  runSetupWorktree,
  type CaptureGit,
  type GitCapture,
  type SetupWorktreeDependencies,
} from "./setup-worktree.ts";

function git(cwd: string, args: readonly string[]): string {
  return NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

const fixtureContainers: string[] = [];

afterEach(() => {
  for (const container of fixtureContainers.splice(0)) {
    NodeFS.rmSync(container, { recursive: true, force: true });
  }
});

function makeLinkedWorktreeFixture(): {
  readonly canonicalRoot: string;
  readonly worktree: string;
} {
  const container = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worktree-setup-"));
  fixtureContainers.push(container);
  const canonicalRoot = NodePath.join(container, "canonical");
  const worktree = NodePath.join(container, "linked");
  NodeFS.mkdirSync(canonicalRoot);
  git(canonicalRoot, ["init", "-b", "main"]);
  git(canonicalRoot, ["config", "user.email", "test@example.com"]);
  git(canonicalRoot, ["config", "user.name", "Test"]);
  NodeFS.writeFileSync(NodePath.join(canonicalRoot, "README.md"), "fixture\n");
  git(canonicalRoot, ["add", "README.md"]);
  git(canonicalRoot, ["commit", "-m", "fixture"]);
  git(canonicalRoot, ["worktree", "add", "-b", "linked", worktree]);
  return { canonicalRoot, worktree };
}

function makeDependencies(
  cwd: string,
  output: { stdout: string; stderr: string; commands: string[] },
): SetupWorktreeDependencies {
  return {
    cwd,
    nodeExecutable: "/runtime/node",
    resolveRepositoryRoots,
    resolveVpInstallCommand: () => ({
      command: "/tools/vp",
      args: ["i", "--frozen-lockfile"],
      shell: false,
    }),
    reconcileLinks: reconcileEnvironmentLinks,
    runCommand: (command, commandCwd) =>
      output.commands.push(
        `${commandCwd} :: shell=${String(command.shell)} :: ${[command.command, ...command.args].join(" ")}`,
      ),
    captureGit,
    writeStdout: (value) => {
      output.stdout += value;
    },
    writeStderr: (value) => {
      output.stderr += value;
    },
  };
}

describe("worktree setup", () => {
  it("resolves the canonical checkout through a linked worktree's absolute common directory", () => {
    const fixture = makeLinkedWorktreeFixture();
    assert.deepStrictEqual(resolveRepositoryRoots(fixture.worktree), {
      canonicalRoot: fixture.canonicalRoot,
      worktreeRoot: fixture.worktree,
    });
  });

  it("refuses a separate Git common-directory layout", () => {
    const container = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worktree-setup-"));
    fixtureContainers.push(container);
    const worktree = NodePath.join(container, "worktree");
    const separateGitDirectory = NodePath.join(container, "git-metadata");
    git(container, ["init", "--separate-git-dir", separateGitDirectory, worktree]);

    assert.throws(
      () => resolveRepositoryRoots(worktree),
      /unsupported Git common directory layout/u,
    );
  });

  it("ignores a foreign Git discovery environment", () => {
    const fixture = makeLinkedWorktreeFixture();
    const foreign = makeLinkedWorktreeFixture();
    const invocationDirectory = NodePath.join(fixture.worktree, "apps", "server");
    NodeFS.mkdirSync(invocationDirectory, { recursive: true });
    const priorCommonDirectory = process.env.GIT_COMMON_DIR;
    const priorCeilingDirectories = process.env.GIT_CEILING_DIRECTORIES;
    const priorDiscoveryAcrossFilesystem = process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM;
    process.env.GIT_COMMON_DIR = NodePath.join(foreign.canonicalRoot, ".git");
    process.env.GIT_CEILING_DIRECTORIES = fixture.worktree;
    process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM = "0";
    try {
      assert.deepStrictEqual(resolveRepositoryRoots(invocationDirectory), {
        canonicalRoot: fixture.canonicalRoot,
        worktreeRoot: fixture.worktree,
      });
    } finally {
      if (priorCommonDirectory === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = priorCommonDirectory;
      if (priorCeilingDirectories === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = priorCeilingDirectories;
      if (priorDiscoveryAcrossFilesystem === undefined) {
        delete process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM;
      } else {
        process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM = priorDiscoveryAcrossFilesystem;
      }
    }
  });

  it("ignores stale or missing T3CODE environment variables and creates canonical links", async () => {
    const fixture = makeLinkedWorktreeFixture();
    const invocationDirectory = NodePath.join(fixture.worktree, "apps", "server");
    NodeFS.mkdirSync(NodePath.join(fixture.canonicalRoot, "infra", "relay"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(fixture.worktree, "infra", "relay"), { recursive: true });
    NodeFS.mkdirSync(invocationDirectory, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(fixture.canonicalRoot, ".env"), "root=true\n");
    NodeFS.writeFileSync(
      NodePath.join(fixture.canonicalRoot, "infra", "relay", ".env"),
      "relay=true\n",
    );
    const priorProjectRoot = process.env.T3CODE_PROJECT_ROOT;
    const priorWorktreePath = process.env.T3CODE_WORKTREE_PATH;
    process.env.T3CODE_PROJECT_ROOT = "/wrong/project";
    process.env.T3CODE_WORKTREE_PATH = "/wrong/worktree";
    const output = { stdout: "", stderr: "", commands: [] as string[] };
    try {
      assert.equal(await runSetupWorktree([], makeDependencies(invocationDirectory, output)), 0);
      delete process.env.T3CODE_PROJECT_ROOT;
      delete process.env.T3CODE_WORKTREE_PATH;
      assert.equal(await runSetupWorktree([], makeDependencies(invocationDirectory, output)), 0);
    } finally {
      if (priorProjectRoot === undefined) delete process.env.T3CODE_PROJECT_ROOT;
      else process.env.T3CODE_PROJECT_ROOT = priorProjectRoot;
      if (priorWorktreePath === undefined) delete process.env.T3CODE_WORKTREE_PATH;
      else process.env.T3CODE_WORKTREE_PATH = priorWorktreePath;
    }

    const rootTarget = NodeFS.readlinkSync(NodePath.join(fixture.worktree, ".env"));
    const relayTarget = NodeFS.readlinkSync(
      NodePath.join(fixture.worktree, "infra", "relay", ".env"),
    );
    assert.equal(rootTarget, NodePath.join(fixture.canonicalRoot, ".env"));
    assert.equal(relayTarget, NodePath.join(fixture.canonicalRoot, "infra", "relay", ".env"));
    assert.equal(NodePath.isAbsolute(rootTarget), true);
    assert.deepStrictEqual(output.commands, [
      `${fixture.worktree} :: shell=false :: /tools/vp i --frozen-lockfile`,
      `${fixture.worktree} :: shell=false :: /runtime/node apps/web/scripts/warm-dep-cache.ts`,
      `${fixture.worktree} :: shell=false :: /tools/vp i --frozen-lockfile`,
      `${fixture.worktree} :: shell=false :: /runtime/node apps/web/scripts/warm-dep-cache.ts`,
    ]);
  });

  it("is idempotent and replaces only stale symlinks", () => {
    const fixture = makeLinkedWorktreeFixture();
    const source = NodePath.join(fixture.canonicalRoot, ".env");
    const destination = NodePath.join(fixture.worktree, ".env");
    const staleTarget = NodePath.join(fixture.canonicalRoot, ".env.old");
    NodeFS.writeFileSync(source, "root=true\n");
    NodeFS.symlinkSync(staleTarget, destination);

    assert.equal(reconcileEnvironmentLink(source, destination), "linked");
    const inode = NodeFS.lstatSync(destination).ino;
    assert.equal(NodeFS.readlinkSync(destination), source);
    assert.equal(reconcileEnvironmentLink(source, destination), "unchanged");
    assert.equal(NodeFS.lstatSync(destination).ino, inode);
  });

  it("creates canonical dangling links when optional sources are missing", () => {
    const fixture = makeLinkedWorktreeFixture();
    const source = NodePath.join(fixture.canonicalRoot, ".env");
    const destination = NodePath.join(fixture.worktree, ".env");

    assert.equal(NodeFS.existsSync(source), false);
    assert.equal(reconcileEnvironmentLink(source, destination), "linked");
    assert.equal(NodeFS.readlinkSync(destination), source);
    assert.equal(NodePath.isAbsolute(NodeFS.readlinkSync(destination)), true);
  });

  it("leaves canonical-checkout environment files unchanged", () => {
    const fixture = makeLinkedWorktreeFixture();
    const environmentFile = NodePath.join(fixture.canonicalRoot, ".env");
    NodeFS.writeFileSync(environmentFile, "canonical=true\n");

    assert.equal(reconcileEnvironmentLink(environmentFile, environmentFile), "unchanged");
    assert.equal(NodeFS.readFileSync(environmentFile, "utf8"), "canonical=true\n");
    assert.equal(NodeFS.lstatSync(environmentFile).isSymbolicLink(), false);
  });

  it("prefers an absolute native Vite+ executable without shell parsing", () => {
    assert.deepStrictEqual(
      resolveVpInstallCommand({ VP_CLI_BIN: "C:\\Program Files\\Vite+\\vp.exe" }, "win32"),
      {
        command: "C:\\Program Files\\Vite+\\vp.exe",
        args: ["i", "--frozen-lockfile"],
        shell: false,
      },
    );
    assert.deepStrictEqual(resolveVpInstallCommand({ VP_CLI_BIN: "/opt/vite plus/vp" }, "linux"), {
      command: "/opt/vite plus/vp",
      args: ["i", "--frozen-lockfile"],
      shell: false,
    });
    assert.throws(
      () => resolveVpInstallCommand({ VP_CLI_BIN: "tools/vp" }, "linux"),
      /must be an absolute path/u,
    );
  });

  it("falls back to PATH without dynamically tokenizing Windows input", () => {
    assert.deepStrictEqual(resolveVpInstallCommand({}, "linux"), {
      command: "vp",
      args: ["i", "--frozen-lockfile"],
      shell: false,
    });
    assert.deepStrictEqual(resolveVpInstallCommand({}, "win32"), {
      command: "vp i --frozen-lockfile",
      args: [],
      shell: true,
    });
  });

  it("runs successfully when Vite+ falls back to PATH resolution", async () => {
    const fixture = makeLinkedWorktreeFixture();
    NodeFS.mkdirSync(NodePath.join(fixture.worktree, "infra", "relay"), { recursive: true });
    const output = { stdout: "", stderr: "", commands: [] as string[] };
    const dependencies: SetupWorktreeDependencies = {
      ...makeDependencies(fixture.worktree, output),
      resolveVpInstallCommand: () => resolveVpInstallCommand({}, "linux"),
    };

    assert.equal(await runSetupWorktree([], dependencies), 0);
    assert.equal(
      output.commands[0],
      `${fixture.worktree} :: shell=false :: vp i --frozen-lockfile`,
    );
  });

  it("preflights both destinations before changing either one", async () => {
    const fixture = makeLinkedWorktreeFixture();
    const canonicalRelayDirectory = NodePath.join(fixture.canonicalRoot, "infra", "relay");
    const worktreeRelayDirectory = NodePath.join(fixture.worktree, "infra", "relay");
    NodeFS.mkdirSync(canonicalRelayDirectory, { recursive: true });
    NodeFS.mkdirSync(worktreeRelayDirectory, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(fixture.canonicalRoot, ".env"), "root=true\n");
    NodeFS.writeFileSync(NodePath.join(canonicalRelayDirectory, ".env"), "relay=true\n");
    const relayDestination = NodePath.join(worktreeRelayDirectory, ".env");
    NodeFS.writeFileSync(relayDestination, "local=true\n");
    const output = { stdout: "", stderr: "", commands: [] as string[] };

    assert.equal(await runSetupWorktree([], makeDependencies(fixture.worktree, output)), 1);
    assert.equal(NodeFS.existsSync(NodePath.join(fixture.worktree, ".env")), false);
    assert.equal(NodeFS.readFileSync(relayDestination, "utf8"), "local=true\n");
  });

  it("preserves a regular destination file and reports an actionable failure", async () => {
    const fixture = makeLinkedWorktreeFixture();
    const source = NodePath.join(fixture.canonicalRoot, ".env");
    const destination = NodePath.join(fixture.worktree, ".env");
    NodeFS.writeFileSync(source, "canonical=true\n");
    NodeFS.writeFileSync(destination, "local=true\n");
    const output = { stdout: "", stderr: "", commands: [] as string[] };

    assert.equal(await runSetupWorktree([], makeDependencies(fixture.worktree, output)), 1);
    assert.equal(NodeFS.readFileSync(destination, "utf8"), "local=true\n");
    assert.match(output.stderr, /refusing to replace.+not a symbolic link/u);
  });

  it("handles help before side effects and rejects unknown arguments with exit 2", async () => {
    const output = { stdout: "", stderr: "", commands: [] as string[] };
    const dependencies = makeDependencies("/not-a-repository", output);

    assert.equal(await runSetupWorktree(["--help"], dependencies), 0);
    assert.equal(await runSetupWorktree(["-h"], dependencies), 0);
    assert.match(output.stdout, /Usage: node scripts\/setup-worktree\.ts/u);
    assert.deepStrictEqual(output.commands, []);

    assert.equal(await runSetupWorktree(["--unknown"], dependencies), 2);
    assert.match(output.stderr, /unknown argument: --unknown/u);
    assert.match(output.stderr, /Usage: node scripts\/setup-worktree\.ts/u);
    assert.deepStrictEqual(output.commands, []);
  });
});

describe("trunk-base check", () => {
  const headSha = "a".repeat(40);
  const publishedSha = "b".repeat(40);
  const localTrunkSha = "c".repeat(40);

  function stubCapture(responses: Record<string, Partial<GitCapture>>): CaptureGit {
    return (_cwd, args) => {
      const key = args.join(" ");
      const response =
        responses[key] ??
        responses[args.slice(0, 3).join(" ")] ??
        responses[args.slice(0, 2).join(" ")];
      if (!response) throw new Error(`unexpected git invocation: git ${key}`);
      return {
        code: response.code ?? 0,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      };
    };
  }

  const baseResponses = {
    "fetch origin hyprws": {},
    "rev-parse --verify refs/remotes/origin/hyprws": { stdout: `${publishedSha}\n` },
    "rev-parse HEAD": { stdout: `${headSha}\n` },
    "branch -r --contains": { stdout: "  origin/hyprws\n" },
    "rev-parse --verify refs/heads/hyprws": { stdout: `${localTrunkSha}\n` },
  };

  it("accepts a HEAD contained in a remote-tracking ref", () => {
    const assessment = assessTrunkBase(stubCapture(baseResponses), "/worktree");

    assert.deepStrictEqual(assessment, {
      kind: "assessed",
      contained: true,
      headSha,
      publishedSha,
      localTrunkSha,
    });
  });

  it("accepts an upstream/main base via its own remote ref", () => {
    const assessment = assessTrunkBase(
      stubCapture({ ...baseResponses, "branch -r --contains": { stdout: "  upstream/main\n" } }),
      "/worktree",
    );

    assert.deepStrictEqual(assessment, {
      kind: "assessed",
      contained: true,
      headSha,
      publishedSha,
      localTrunkSha,
    });
  });

  it("reports a HEAD contained in no remote ref with both shas", () => {
    const assessment = assessTrunkBase(
      stubCapture({ ...baseResponses, "branch -r --contains": { code: 0, stdout: "" } }),
      "/worktree",
    );

    assert.deepStrictEqual(assessment, {
      kind: "assessed",
      contained: false,
      headSha,
      publishedSha,
      localTrunkSha,
    });
  });

  it("skips when the fetch fails and carries the git error", () => {
    const assessment = assessTrunkBase(
      stubCapture({
        "fetch origin hyprws": { code: 128, stderr: "fatal: no origin\n" },
      }),
      "/worktree",
    );

    assert.deepStrictEqual(assessment, {
      kind: "skipped",
      reason: "could not fetch origin hyprws: fatal: no origin",
    });
  });

  it("skips when origin/hyprws is missing after the fetch", () => {
    const assessment = assessTrunkBase(
      stubCapture({
        "fetch origin hyprws": {},
        "rev-parse --verify refs/remotes/origin/hyprws": { code: 128 },
      }),
      "/worktree",
    );

    assert.deepStrictEqual(assessment, {
      kind: "skipped",
      reason: "origin/hyprws not found after the fetch",
    });
  });

  it("reports no local trunk when the hyprws branch does not exist", () => {
    const assessment = assessTrunkBase(
      stubCapture({
        ...baseResponses,
        "rev-parse --verify refs/heads/hyprws": { code: 128 },
      }),
      "/worktree",
    );

    assert.deepStrictEqual(assessment, {
      kind: "assessed",
      contained: true,
      headSha,
      publishedSha,
      localTrunkSha: undefined,
    });
  });

  it("refuses a worktree HEAD with no containing remote ref before installing anything", async () => {
    const fixture = makeLinkedWorktreeFixture();
    const output = { stdout: "", stderr: "", commands: [] as string[] };
    const dependencies: SetupWorktreeDependencies = {
      ...makeDependencies(fixture.worktree, output),
      captureGit: stubCapture({
        ...baseResponses,
        "branch -r --contains": { code: 0, stdout: "" },
      }),
    };

    assert.equal(await runSetupWorktree([], dependencies), 1);
    assert.match(output.stderr, /contained in no remote-tracking ref/u);
    assert.match(output.stderr, /git reset --hard origin\/hyprws/u);
    assert.match(output.stderr, /--base origin\/hyprws/u);
    assert.deepStrictEqual(output.commands, []);
  });

  it("notices a stale local trunk and continues", async () => {
    const fixture = makeLinkedWorktreeFixture();
    NodeFS.mkdirSync(NodePath.join(fixture.worktree, "infra", "relay"), { recursive: true });
    const output = { stdout: "", stderr: "", commands: [] as string[] };
    const dependencies: SetupWorktreeDependencies = {
      ...makeDependencies(fixture.worktree, output),
      captureGit: stubCapture(baseResponses),
    };

    assert.equal(await runSetupWorktree([], dependencies), 0);
    assert.match(
      output.stdout,
      /notice: local 'hyprws' \(cccccccccccc\).*reset --hard origin\/hyprws/u,
    );
    assert.equal(output.commands.length, 2);
  });

  it("refuses a branch cut from discarded trunk history until it is reset", async () => {
    const fixture = makeTrunkFixture();
    const output = { stdout: "", stderr: "", commands: [] as string[] };

    assert.equal(await runSetupWorktree([], makeDependencies(fixture.worktree, output)), 1);
    assert.match(output.stderr, /contained in no remote-tracking ref/u);
    assert.deepStrictEqual(output.commands, []);

    output.stderr = "";
    git(fixture.worktree, ["reset", "--hard", "origin/hyprws"]);
    NodeFS.writeFileSync(NodePath.join(fixture.worktree, "README.md"), "advanced\n");
    git(fixture.worktree, ["commit", "-am", "advanced"]);
    git(fixture.worktree, ["push", "origin", "HEAD:hyprws"]);

    assert.equal(await runSetupWorktree([], makeDependencies(fixture.worktree, output)), 0);
    assert.match(output.stdout, /notice: local 'hyprws'/u);
  });

  function makeTrunkFixture(): { readonly canonicalRoot: string; readonly worktree: string } {
    const container = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worktree-trunk-"));
    fixtureContainers.push(container);
    const origin = NodePath.join(container, "origin.git");
    const canonicalRoot = NodePath.join(container, "canonical");
    const worktree = NodePath.join(container, "linked");
    git(container, ["init", "--bare", "-b", "hyprws", origin]);
    NodeFS.mkdirSync(canonicalRoot);
    git(canonicalRoot, ["init", "-b", "hyprws"]);
    git(canonicalRoot, ["config", "user.email", "test@example.com"]);
    git(canonicalRoot, ["config", "user.name", "Test"]);
    git(canonicalRoot, ["remote", "add", "origin", origin]);
    NodeFS.writeFileSync(NodePath.join(canonicalRoot, "README.md"), "base\n");
    git(canonicalRoot, ["add", "README.md"]);
    git(canonicalRoot, ["commit", "-m", "base"]);
    NodeFS.writeFileSync(NodePath.join(canonicalRoot, "README.md"), "discarded\n");
    git(canonicalRoot, ["commit", "-am", "discarded"]);
    git(canonicalRoot, ["push", "origin", "hyprws"]);
    git(canonicalRoot, ["worktree", "add", "-b", "linked", worktree]);
    NodeFS.mkdirSync(NodePath.join(worktree, "infra", "relay"), { recursive: true });
    git(canonicalRoot, ["reset", "--hard", "HEAD~1"]);
    NodeFS.writeFileSync(NodePath.join(canonicalRoot, "README.md"), "rewritten\n");
    git(canonicalRoot, ["commit", "-am", "rewritten"]);
    git(canonicalRoot, ["push", "--force", "origin", "hyprws"]);
    return { canonicalRoot, worktree };
  }
});
