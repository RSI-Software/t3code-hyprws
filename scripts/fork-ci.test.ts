// @effect-diagnostics nodeBuiltinImport:off - Fork:ci wiring is Git plumbing; fixtures need real repositories.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { run, type ForkCiStep } from "./fork-ci.ts";

const forkDeltaScript = NodePath.join(import.meta.dirname, "fork-delta.ts");
const mergeTreeScript = NodePath.join(import.meta.dirname, "fork-merge-tree.sh");

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Fork CI Test", "-c", "user.email=fork-ci@example.com", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: NodePath.join(root, ".isolated-global-gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  ).trim();

/** A base pinned as upstream/main with one untagged commit above it: the #1213 shape. */
const untaggedFixture = (): { root: string; head: string; base: string } => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-ci-test-"));
  git(root, ["init", "--quiet", "--initial-branch", "main"]);
  NodeFS.writeFileSync(NodePath.join(root, "base.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "upstream base"]);
  git(root, ["update-ref", "refs/remotes/upstream/main", "main"]);
  const base = git(root, ["rev-parse", "main"]);
  NodeFS.writeFileSync(NodePath.join(root, "fork.txt"), "fork\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "untagged fork commit"]);
  return { root, head: git(root, ["rev-parse", "HEAD"]), base };
};

it("fails an untagged tip through the delta check, before the scan", () => {
  const { root, head } = untaggedFixture();
  try {
    const calls: Array<ReadonlyArray<string>> = [];
    const step: ForkCiStep = (command, args, cwd) => {
      calls.push([command, ...args]);
      if (args[1] === "fork:delta") {
        // The real trailer check, not a canned failure: the fixture tip
        // carries no Fork-Domain or Fork-Tier.
        const result = NodeChildProcess.spawnSync(
          process.execPath,
          [forkDeltaScript, ...args.slice(2)],
          { cwd, encoding: "utf8" },
        );
        assert.notStrictEqual(result.status, 0);
        return result.status ?? 1;
      }
      return 0;
    };
    assert.strictEqual(run([], root, step), 1);
    // The CI form from the workflow's Fork ledger step, and nothing else ran.
    assert.deepStrictEqual(calls, [["vp", "run", "fork:delta", "--check", "--head", head]]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("runs delta, stale-delete, fixup fold, merge-tree, scan, knip, check, typecheck, and suite in order when every step passes", () => {
  const { root, head, base } = untaggedFixture();
  try {
    const calls: Array<ReadonlyArray<string>> = [];
    const step: ForkCiStep = (command, args) => {
      calls.push([command, ...args]);
      return 0;
    };
    assert.strictEqual(run([], root, step), 0);
    // No origin/hyprws ref in the fixture: since falls back to head^ and
    // replay-of is absent, exactly as deriveForkCiFlags defines.
    assert.deepStrictEqual(calls, [
      ["vp", "run", "fork:delta", "--check", "--head", head],
      ["vp", "run", "fork:stale-delete", "--base", `${head}^`, "--head", head],
      ["vp", "run", "fork:fixup-fold", "--base", base, "--head", head],
      ["bash", "scripts/fork-merge-tree.sh", head],
      [
        "vp",
        "run",
        "fork:scan",
        "--head",
        head,
        "--target",
        base,
        "--since",
        `${head}^`,
        "--no-typecheck",
      ],
      ["vp", "run", "knip:check"],
      ["vp", "check"],
      ["vp", "run", "typecheck"],
      ["vp", "run", "--filter", "@t3tools/scripts", "test"],
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("fails a misformatted file through vp check, reformatting nothing", () => {
  // A failing read-only check stops the battery: the earlier steps pass
  // stubbed, the check reports nonzero, and the suite never runs. The
  // exact check argv below is what proves the Scope close condition: no
  // --fix and no extra argument, so no file is reformatted.
  const { root } = untaggedFixture();
  try {
    const calls: Array<ReadonlyArray<string>> = [];
    const step: ForkCiStep = (command, args) => {
      calls.push([command, ...args]);
      return command === "vp" && args.length === 1 && args[0] === "check" ? 1 : 0;
    };
    assert.strictEqual(run([], root, step), 1);
    const [delta, staleDelete, fixupFold, mergeTree, scan, knip, check] = calls;
    assert.strictEqual(calls.length, 7);
    assert.deepStrictEqual(delta?.slice(0, 2), ["vp", "run"]);
    assert.deepStrictEqual(staleDelete?.slice(0, 2), ["vp", "run"]);
    assert.deepStrictEqual(fixupFold?.slice(0, 2), ["vp", "run"]);
    assert.deepStrictEqual(mergeTree?.[0], "bash");
    assert.deepStrictEqual(scan?.slice(0, 2), ["vp", "run"]);
    assert.deepStrictEqual(knip, ["vp", "run", "knip:check"]);
    assert.deepStrictEqual(check, ["vp", "check"]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("skips stale-delete on a sync candidate and scans from its base", () => {
  const { root, head: oldTip, base: oldBase } = untaggedFixture();
  try {
    git(root, ["update-ref", "refs/remotes/origin/hyprws", oldTip]);
    git(root, ["checkout", "--quiet", "--detach", oldBase]);
    NodeFS.writeFileSync(NodePath.join(root, "base.txt"), "base v2\n");
    git(root, ["commit", "--quiet", "--all", "-m", "upstream release"]);
    git(root, ["update-ref", "refs/remotes/upstream/main", "HEAD"]);
    const base = git(root, ["rev-parse", "HEAD"]);
    git(root, ["cherry-pick", oldTip]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const calls: Array<ReadonlyArray<string>> = [];
    const step: ForkCiStep = (command, args) => {
      calls.push([command, ...args]);
      return 0;
    };
    assert.strictEqual(run([], root, step), 0);
    assert.deepStrictEqual(calls.slice(0, 4), [
      ["vp", "run", "fork:delta", "--check", "--head", head],
      ["vp", "run", "fork:fixup-fold", "--base", base, "--head", head],
      ["bash", "scripts/fork-merge-tree.sh", head],
      [
        "vp",
        "run",
        "fork:scan",
        "--head",
        head,
        "--target",
        base,
        "--since",
        base,
        "--replay-of",
        "origin/hyprws",
        "--no-typecheck",
      ],
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a head-only merge-tree conflict and stops before the scan", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-ci-test-"));
  const commit = (files: Record<string, string>, message: string): string => {
    for (const [name, text] of Object.entries(files)) {
      NodeFS.writeFileSync(NodePath.join(root, name), text);
    }
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", message]);
    return git(root, ["rev-parse", "HEAD"]);
  };
  try {
    git(root, ["init", "--quiet", "--initial-branch", "main"]);
    const base = commit({ "a.txt": "a\n", "b.txt": "b\n" }, "base");
    git(root, [
      "update-ref",
      "refs/remotes/upstream/main",
      commit({ "a.txt": "a up\n", "b.txt": "b up\n" }, "upstream"),
    ]);
    git(root, ["checkout", "--quiet", "--detach", base]);
    // The trunk already conflicts on b.txt: carried, so never the head's fault.
    const trunk = commit({ "b.txt": "b fork\n" }, "trunk");
    git(root, ["update-ref", "refs/remotes/origin/hyprws", trunk]);
    const runWith = (head: string): { code: number; calls: Array<string> } => {
      git(root, ["checkout", "--quiet", "--detach", head]);
      const calls: Array<string> = [];
      const step: ForkCiStep = (command, args, cwd) => {
        calls.push(command === "bash" ? "merge-tree" : (args[1] ?? command));
        if (command !== "bash") return 0;
        return (
          NodeChildProcess.spawnSync("bash", [mergeTreeScript, ...args.slice(1)], { cwd }).status ??
          1
        );
      };
      return { code: run([], root, step), calls };
    };

    git(root, ["checkout", "--quiet", "--detach", trunk]);
    const clean = runWith(commit({ "c.txt": "c\n" }, "fork addition"));
    assert.strictEqual(clean.code, 0);
    assert.include(clean.calls, "fork:scan");

    git(root, ["checkout", "--quiet", "--detach", trunk]);
    const refused = runWith(commit({ "a.txt": "a fork\n" }, "fork edit on an upstream line"));
    assert.strictEqual(refused.code, 1);
    assert.strictEqual(refused.calls.at(-1), "merge-tree");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
