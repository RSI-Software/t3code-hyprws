// @effect-diagnostics nodeBuiltinImport:off - Tests exercise real disposable Git repositories.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import type { CommandResult, CwdCommandRunner } from "./fork-command.ts";
import {
  DEV_APP_PROJECT_RELATIVE_PATH,
  DEV_APP_PROJECT_TITLE,
  devAppProjectCliEnvironment,
  prepareDevAppProject,
  registerDevAppProject,
} from "./dev-app-project.ts";

const containers: string[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    NodeFS.rmSync(container, { recursive: true, force: true });
  }
});

function makeCheckout(): string {
  const checkout = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-dev-app-project-"));
  containers.push(checkout);
  return checkout;
}

function git(root: string, args: readonly string[]): string {
  return NodeChildProcess.execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();
}

class RecordingRunner implements CwdCommandRunner {
  readonly calls: Array<{
    command: string;
    args: ReadonlyArray<string>;
    cwd: string;
    env: NodeJS.ProcessEnv | undefined;
  }> = [];
  private readonly result: CommandResult;

  constructor(result: CommandResult) {
    this.result = result;
  }

  run(
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    _input?: string,
    env?: NodeJS.ProcessEnv,
  ): CommandResult {
    this.calls.push({ command, args, cwd, env });
    return this.result;
  }
}

describe("dev app project fixture", () => {
  it("creates an owned Git repository with deterministic editable files", () => {
    const checkout = makeCheckout();
    const fixture = prepareDevAppProject(checkout);

    assert.isTrue(fixture.created);
    assert.equal(fixture.root, NodePath.join(checkout, DEV_APP_PROJECT_RELATIVE_PATH));
    assert.equal(git(fixture.root, ["branch", "--show-current"]), "main");
    assert.equal(git(fixture.root, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(git(fixture.root, ["status", "--porcelain"]), "");
    assert.deepStrictEqual(git(fixture.root, ["ls-files"]).split("\n"), [
      "README.md",
      "src/greeting.ts",
    ]);
    assert.include(
      NodeFS.readFileSync(NodePath.join(fixture.root, "README.md"), "utf8"),
      "safe to edit",
    );
  });

  it("retains commits, tracked edits, and untracked files across preparation", () => {
    const checkout = makeCheckout();
    const first = prepareDevAppProject(checkout);
    const firstHead = git(first.root, ["rev-parse", "HEAD"]);
    const readme = NodePath.join(first.root, "README.md");
    const scratch = NodePath.join(first.root, "notes.txt");
    NodeFS.appendFileSync(readme, "User edit\n");
    NodeFS.writeFileSync(scratch, "Untracked work\n");

    const second = prepareDevAppProject(checkout);

    assert.isFalse(second.created);
    assert.equal(git(second.root, ["rev-parse", "HEAD"]), firstHead);
    assert.isTrue(NodeFS.readFileSync(readme, "utf8").endsWith("User edit\n"));
    assert.equal(NodeFS.readFileSync(scratch, "utf8"), "Untracked work\n");
    assert.deepStrictEqual(git(second.root, ["status", "--porcelain"]).split("\n"), [
      "M README.md",
      "?? notes.txt",
    ]);
  });

  it("refuses a fixture symlink that resolves outside the checkout-local home", () => {
    const checkout = makeCheckout();
    const outside = makeCheckout();
    const home = NodePath.join(checkout, ".t3");
    NodeFS.mkdirSync(home);
    NodeFS.symlinkSync(outside, NodePath.join(home, "test-project"), "dir");

    assert.throws(() => prepareDevAppProject(checkout), /resolves outside checkout-local home/u);
    assert.isFalse(NodeFS.existsSync(NodePath.join(outside, ".git")));
  });

  it("removes inherited runner and bootstrap channels from the project CLI", () => {
    assert.deepStrictEqual(
      devAppProjectCliEnvironment({
        PATH: "/usr/bin",
        T3CODE_HOME: "/home/user/.t3",
        T3CODE_PORT: "13773",
        T3CODE_BOOTSTRAP_FD: "7",
        NODE_CHANNEL_FD: "9",
        NODE_CHANNEL_SERIALIZATION: "advanced",
      }),
      { PATH: "/usr/bin" },
    );
  });

  it("registers through the public project CLI and accepts its duplicate result", () => {
    const checkoutRoot = makeCheckout();
    const baseDir = NodePath.join(checkoutRoot, ".t3");
    const projectRoot = NodePath.join(checkoutRoot, DEV_APP_PROJECT_RELATIVE_PATH);
    const addedRunner = new RecordingRunner({ status: 0, stdout: "Added project.\n", stderr: "" });

    assert.equal(
      registerDevAppProject({
        checkoutRoot,
        baseDir,
        environment: { PATH: "/usr/bin", T3CODE_HOME: "/foreign" },
        runner: addedRunner,
      }),
      "added",
    );
    assert.deepStrictEqual(addedRunner.calls, [
      {
        command: process.execPath,
        args: [
          "apps/server/src/bin.ts",
          "project",
          "add",
          projectRoot,
          "--title",
          DEV_APP_PROJECT_TITLE,
          "--base-dir",
          baseDir,
        ],
        cwd: checkoutRoot,
        env: { PATH: "/usr/bin" },
      },
    ]);
    assert.equal(git(projectRoot, ["rev-list", "--count", "HEAD"]), "1");

    const duplicateRunner = new RecordingRunner({
      status: 1,
      stdout: "",
      stderr: `An active project already exists for '${projectRoot}'.\n`,
    });
    assert.equal(
      registerDevAppProject({ checkoutRoot, baseDir, runner: duplicateRunner }),
      "already-registered",
    );
  });

  it("surfaces project registration failures", () => {
    const checkoutRoot = makeCheckout();
    const runner = new RecordingRunner({ status: 1, stdout: "", stderr: "database is busy" });

    assert.throws(
      () => registerDevAppProject({ checkoutRoot, baseDir: ".t3", runner }),
      /database is busy/u,
    );
  });
});
