// @effect-diagnostics nodeBuiltinImport:off - These integration fixtures exercise the pre-install Node bootstrap against real Git worktrees.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import {
  resolveMainCheckoutFromGit,
  resolveSetupProjectRoot,
  shouldReplaceEnvTarget,
} from "./setup-worktree.fork.ts";

function git(cwd: string, args: readonly string[]): string {
  return NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

const fixtureContainers: string[] = [];

afterEach(() => {
  for (const container of fixtureContainers.splice(0)) {
    NodeFS.rmSync(container, { recursive: true, force: true });
  }
});

function makeContainer(): string {
  const container = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worktree-setup-"));
  fixtureContainers.push(container);
  return container;
}

function makeLinkedWorktreeFixture(): {
  readonly canonicalRoot: string;
  readonly worktree: string;
} {
  const container = makeContainer();
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

describe("worktree setup fork seams", () => {
  it("resolves the main checkout through a linked worktree's common directory", () => {
    const fixture = makeLinkedWorktreeFixture();
    assert.strictEqual(resolveMainCheckoutFromGit(fixture.worktree, {}), fixture.canonicalRoot);
  });

  it("refuses a separate Git common-directory layout", () => {
    const container = makeContainer();
    const worktree = NodePath.join(container, "worktree");
    git(container, ["init", "--separate-git-dir", NodePath.join(container, "meta"), worktree]);
    assert.throws(
      () => resolveMainCheckoutFromGit(worktree, {}),
      /unsupported Git common directory layout/u,
    );
  });

  it("ignores a foreign Git discovery environment", () => {
    const fixture = makeLinkedWorktreeFixture();
    const foreign = makeLinkedWorktreeFixture();
    const invocationDirectory = NodePath.join(fixture.worktree, "apps", "server");
    NodeFS.mkdirSync(invocationDirectory, { recursive: true });
    assert.strictEqual(
      resolveMainCheckoutFromGit(invocationDirectory, {
        ...process.env,
        GIT_COMMON_DIR: NodePath.join(foreign.canonicalRoot, ".git"),
        GIT_CEILING_DIRECTORIES: fixture.worktree,
        GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
      }),
      fixture.canonicalRoot,
    );
  });

  it("prefers an existing T3CODE_PROJECT_ROOT and falls back to Git when it is stale or unset", () => {
    const fixture = makeLinkedWorktreeFixture();
    const other = makeContainer();
    assert.strictEqual(
      resolveSetupProjectRoot({ T3CODE_PROJECT_ROOT: other }, fixture.worktree),
      other,
    );
    assert.strictEqual(
      resolveSetupProjectRoot(
        { T3CODE_PROJECT_ROOT: NodePath.join(other, "missing") },
        fixture.worktree,
      ),
      fixture.canonicalRoot,
    );
    assert.strictEqual(resolveSetupProjectRoot({}, fixture.worktree), fixture.canonicalRoot);
  });

  it("replaces absent targets and symlinks but preserves a regular file", () => {
    const container = makeContainer();
    const regular = NodePath.join(container, "regular.env");
    const link = NodePath.join(container, "link.env");
    NodeFS.writeFileSync(regular, "KEEP=1\n");
    NodeFS.symlinkSync(NodePath.join(container, "stale"), link);
    assert.isTrue(shouldReplaceEnvTarget(NodePath.join(container, "absent.env")));
    assert.isTrue(shouldReplaceEnvTarget(link));
    assert.isFalse(shouldReplaceEnvTarget(regular));
  });
});
