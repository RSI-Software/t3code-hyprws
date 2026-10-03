// @effect-diagnostics nodeBuiltinImport:off - Tests exercise checkout-local env files and real Git worktree discovery.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildDevAppRunnerArgs,
  loadDevAppEnvironment,
  resolveDevAppCheckoutRoot,
} from "./dev-app-env.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-dev-app-env-"));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, args: readonly string[]): string {
  return NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function makeLinkedWorktree(): { readonly base: string; readonly worktree: string } {
  const container = makeTemporaryDirectory();
  const base = NodePath.join(container, "base");
  const worktree = NodePath.join(container, "candidate");
  NodeFS.mkdirSync(base);
  git(base, ["init", "-b", "main"]);
  git(base, ["config", "user.email", "test@example.com"]);
  git(base, ["config", "user.name", "Test"]);
  NodeFS.writeFileSync(NodePath.join(base, "README.md"), "fixture\n");
  git(base, ["add", "README.md"]);
  git(base, ["commit", "-m", "fixture"]);
  git(base, ["worktree", "add", "-b", "candidate", worktree]);
  return { base, worktree };
}

describe("dev app launch environment", () => {
  it("resolves the invoking base or linked worktree instead of another checkout", () => {
    const fixture = makeLinkedWorktree();
    const nestedBase = NodePath.join(fixture.base, "apps", "web");
    const nestedCandidate = NodePath.join(fixture.worktree, "scripts", "lib");
    NodeFS.mkdirSync(nestedBase, { recursive: true });
    NodeFS.mkdirSync(nestedCandidate, { recursive: true });

    expect(resolveDevAppCheckoutRoot(nestedBase)).toBe(NodeFS.realpathSync(fixture.base));
    expect(resolveDevAppCheckoutRoot(nestedCandidate)).toBe(NodeFS.realpathSync(fixture.worktree));
  });

  it("ignores Git discovery variables inherited from another checkout", () => {
    const selected = makeLinkedWorktree();
    const foreign = makeLinkedWorktree();
    const previousGitDirectory = process.env.GIT_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = NodePath.join(foreign.base, ".git");
    process.env.GIT_WORK_TREE = foreign.base;
    try {
      expect(resolveDevAppCheckoutRoot(selected.worktree)).toBe(
        NodeFS.realpathSync(selected.worktree),
      );
    } finally {
      if (previousGitDirectory === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDirectory;
      if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousGitWorkTree;
    }
  });

  it("strips a parent app's runner settings before loading deliberate repository values", () => {
    const checkoutRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(checkoutRoot, ".env"),
      [
        "T3CODE_PORT=4773",
        "T3CODE_PORT_OFFSET=12",
        "T3CODE_HOME=/repo/configured-home",
        "T3CODE_RELAY_URL=https://repo.example.test",
      ].join("\n"),
    );

    expect(
      loadDevAppEnvironment({
        checkoutRoot,
        environment: {
          PATH: "/usr/bin",
          T3CODE_PORT: "3773",
          T3CODE_PORT_OFFSET: "4",
          T3CODE_HOME: "/home/user/.t3",
          VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
          VITE_HTTP_URL: "http://127.0.0.1:3773",
          VITE_WS_URL: "ws://127.0.0.1:3773",
        },
      }),
    ).toMatchObject({
      PATH: "/usr/bin",
      T3CODE_PORT: "4773",
      T3CODE_PORT_OFFSET: "12",
      T3CODE_HOME: "/repo/configured-home",
      T3CODE_RELAY_URL: "https://repo.example.test",
      VITE_T3CODE_RELAY_URL: "https://repo.example.test",
    });
  });

  it("leaves runner allocation settings absent when neither checkout nor caller configures them", () => {
    const environment = loadDevAppEnvironment({
      checkoutRoot: makeTemporaryDirectory(),
      environment: {
        T3CODE_PORT: "3773",
        PORT: "5173",
        T3CODE_HOME: "/home/user/.t3",
        T3CODE_DEV_INSTANCE: "stable",
        T3CODE_PORT_OFFSET: "4",
      },
    });

    expect(environment.T3CODE_PORT).toBeUndefined();
    expect(environment.PORT).toBeUndefined();
    expect(environment.T3CODE_HOME).toBeUndefined();
    expect(environment.T3CODE_DEV_INSTANCE).toBeUndefined();
    expect(environment.T3CODE_PORT_OFFSET).toBeUndefined();
  });

  it("pins state to the selected checkout while preserving deliberate runner overrides", () => {
    expect(
      buildDevAppRunnerArgs({
        checkoutRoot: "/repos/feature candidate",
        mode: "dev",
        runnerArgs: ["--port", "4773", "--host=0.0.0.0", "--browser"],
      }),
    ).toEqual([
      "scripts/dev-runner.ts",
      "dev",
      "--home-dir",
      NodePath.join("/repos/feature candidate", ".t3"),
      "--port",
      "4773",
      "--host=0.0.0.0",
      "--browser",
    ]);
  });

  it("rejects state overrides while leaving post-separator task arguments untouched", () => {
    expect(() =>
      buildDevAppRunnerArgs({
        checkoutRoot: "/repos/feature",
        mode: "dev",
        runnerArgs: ["--home-dir", "/home/user/.t3"],
      }),
    ).toThrow(/always uses.+checkout.+\.t3/u);
    expect(() =>
      buildDevAppRunnerArgs({
        checkoutRoot: "/repos/feature",
        mode: "dev",
        runnerArgs: ["--home-dir=/home/user/.t3"],
      }),
    ).toThrow(/always uses.+checkout.+\.t3/u);
    expect(
      buildDevAppRunnerArgs({
        checkoutRoot: "/repos/feature",
        mode: "dev:web",
        runnerArgs: ["--", "--home-dir", "task-value"],
      }),
    ).toEqual([
      "scripts/dev-runner.ts",
      "dev:web",
      "--home-dir",
      NodePath.join("/repos/feature", ".t3"),
      "--",
      "--home-dir",
      "task-value",
    ]);
  });
});
