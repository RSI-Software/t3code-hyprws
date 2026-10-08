// @effect-diagnostics nodeBuiltinImport:off - The fixup fold check is Git plumbing; fixtures need real repositories.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { assert, it, vi } from "@effect/vitest";

import * as ForkCommand from "./lib/fork-command.ts";
import { fixupFoldFailures } from "./fork-fixup-fold.ts";

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

/** Repo-local identity, so the replayed rebase commits without ambient global config. */
const identity = (root: string): void => {
  git(root, ["config", "user.name", "Fixup Fold Test"]);
  git(root, ["config", "user.email", "fixup-fold@example.com"]);
  git(root, ["config", "commit.gpgsign", "false"]);
};

const commit = (root: string, subject: string, files: Record<string, string>): void => {
  for (const [file, text] of Object.entries(files)) NodeFS.writeFileSync(`${root}/${file}`, text);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "--allow-empty", "-m", subject]);
};

const worktreeCount = (root: string): number =>
  git(root, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;

it("passes a stack whose fixups fold at their owners, squash suffix included", () => {
  const root = NodeFS.mkdtempSync(NodeOS.tmpdir() + "/fork-fixup-fold-");
  try {
    git(root, ["init", "--quiet", "--initial-branch", "main"]);
    identity(root);
    commit(root, "upstream base", { "file.txt": "one\ntwo\nthree\n" });
    git(root, ["update-ref", "refs/remotes/upstream/main", "main"]);
    const base = git(root, ["rev-parse", "main"]);
    commit(root, "owner edit", { "file.txt": "ONE\ntwo\nthree\n" });
    commit(root, "later edit", { "file.txt": "ONE\ntwo\nTHREE\n" });
    commit(root, "fixup! owner edit (#2)", { "file.txt": "ONE!\ntwo\nTHREE\n" });
    assert.deepStrictEqual(fixupFoldFailures(root, base, "HEAD"), []);
    // The throwaway replay worktree is gone again.
    assert.strictEqual(worktreeCount(root), 1);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("folds without configured Git identity and leaves the live repository unchanged", () => {
  const root = NodeFS.mkdtempSync(NodeOS.tmpdir() + "/fork-fixup-fold-");
  try {
    git(root, ["init", "--quiet", "--initial-branch", "main"]);
    identity(root);
    commit(root, "upstream base", { "file.txt": "one\ntwo\n" });
    const base = git(root, ["rev-parse", "HEAD"]);
    commit(root, "owner edit", { "file.txt": "ONE\ntwo\n" });
    commit(root, "fixup! owner edit", { "file.txt": "ONE!\ntwo\n" });
    const tip = git(root, ["rev-parse", "HEAD"]);
    // Empty local values mask any ambient global identity, like a clean CI runner.
    git(root, ["config", "user.name", ""]);
    git(root, ["config", "user.email", ""]);
    assert.deepStrictEqual(fixupFoldFailures(root, base, "HEAD"), []);
    assert.strictEqual(git(root, ["rev-parse", "HEAD"]), tip);
    assert.strictEqual(git(root, ["config", "user.name"]), "");
    assert.strictEqual(git(root, ["config", "user.email"]), "");
    assert.strictEqual(worktreeCount(root), 1);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("reports Git's error when the replay fails before applying a commit", () => {
  const root = NodeFS.mkdtempSync(NodeOS.tmpdir() + "/fork-fixup-fold-");
  try {
    git(root, ["init", "--quiet", "--initial-branch", "main"]);
    identity(root);
    commit(root, "upstream base", { "file.txt": "one\n" });
    const base = git(root, ["rev-parse", "HEAD"]);
    commit(root, "owner edit", { "file.txt": "ONE\n" });
    commit(root, "fixup! owner edit", { "file.txt": "ONE!\n" });
    const hooks = `${root}/hooks`;
    NodeFS.mkdirSync(hooks);
    NodeFS.writeFileSync(
      `${hooks}/pre-rebase`,
      "#!/bin/sh\necho 'fixture refuses replay' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    git(root, ["config", "core.hooksPath", hooks]);
    const [failure] = fixupFoldFailures(root, base, "HEAD");
    assert.ok(failure?.includes("the replay failed before applying a commit"), failure);
    assert.ok(failure?.includes("fixture refuses replay"), failure);
    assert.strictEqual(worktreeCount(root), 1);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps both Git stderr and a subprocess timeout error", () => {
  const root = NodeFS.mkdtempSync(NodeOS.tmpdir() + "/fork-fixup-fold-");
  try {
    git(root, ["init", "--quiet", "--initial-branch", "main"]);
    identity(root);
    commit(root, "upstream base", { "file.txt": "one\n" });
    const base = git(root, ["rev-parse", "HEAD"]);
    commit(root, "owner edit", { "file.txt": "ONE\n" });
    commit(root, "fixup! owner edit", { "file.txt": "ONE!\n" });
    const runCommand = ForkCommand.runCommand;
    vi.spyOn(ForkCommand, "runCommand").mockImplementation((command, args, options) =>
      command === "git" && args.includes("rebase") && args.includes("-i")
        ? {
            status: 1,
            stdout: "",
            stderr: "replay progress",
            error: new Error("spawnSync git ETIMEDOUT"),
          }
        : runCommand(command, args, options),
    );
    const [failure] = fixupFoldFailures(root, base, "HEAD");
    assert.ok(failure?.includes("replay progress"), failure);
    assert.ok(failure?.includes("spawnSync git ETIMEDOUT"), failure);
    assert.strictEqual(worktreeCount(root), 1);
  } finally {
    vi.restoreAllMocks();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a fixup that only folds at the tip, naming fixup and owner", () => {
  const root = NodeFS.mkdtempSync(NodeOS.tmpdir() + "/fork-fixup-fold-");
  try {
    git(root, ["init", "--quiet", "--initial-branch", "main"]);
    identity(root);
    commit(root, "upstream base", { "file.txt": "a\ntail\n" });
    git(root, ["update-ref", "refs/remotes/upstream/main", "main"]);
    const base = git(root, ["rev-parse", "main"]);
    commit(root, "owner edit", { "file.txt": "b\ntail\n" });
    commit(root, "later edit", { "file.txt": "c\ntail\n" });
    // The fixup edit builds on the later commit's content, so it applies at
    // the tip and nowhere near its owner: the proof must stop there.
    commit(root, "fixup! owner edit", { "file.txt": "c!\ntail\n" });
    const [failure] = fixupFoldFailures(root, base, "HEAD");
    assert.ok(failure?.includes('fixup "fixup! owner edit"'), failure);
    assert.ok(failure?.includes('owner "owner edit"'), failure);
    // The live checkout is untouched: the tip stands and the replay worktree is gone.
    assert.strictEqual(git(root, ["rev-parse", "HEAD"]), git(root, ["rev-parse", "main"]));
    assert.strictEqual(worktreeCount(root), 1);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a fixup that names no fork commit", () => {
  const root = NodeFS.mkdtempSync(NodeOS.tmpdir() + "/fork-fixup-fold-");
  try {
    git(root, ["init", "--quiet", "--initial-branch", "main"]);
    identity(root);
    commit(root, "upstream base", { "file.txt": "a\n" });
    git(root, ["update-ref", "refs/remotes/upstream/main", "main"]);
    const base = git(root, ["rev-parse", "main"]);
    commit(root, "fixup! nothing names this", { "file.txt": "b\n" });
    assert.deepStrictEqual(fixupFoldFailures(root, base, "HEAD"), [
      'fixup "fixup! nothing names this" names no fork commit above the target',
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("skips the replay when the stack has no fixups", () => {
  const root = NodeFS.mkdtempSync(NodeOS.tmpdir() + "/fork-fixup-fold-");
  try {
    git(root, ["init", "--quiet", "--initial-branch", "main"]);
    identity(root);
    commit(root, "upstream base", { "file.txt": "a\n" });
    git(root, ["update-ref", "refs/remotes/upstream/main", "main"]);
    const base = git(root, ["rev-parse", "main"]);
    commit(root, "plain fork commit", { "file.txt": "b\n" });
    assert.deepStrictEqual(fixupFoldFailures(root, base, "HEAD"), []);
    assert.strictEqual(worktreeCount(root), 1);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
