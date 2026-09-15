// @effect-diagnostics nodeBuiltinImport:off - Fork:ci wiring is Git plumbing; fixtures need real repositories.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { run, type ForkCiStep } from "./fork-ci.ts";

const forkDeltaScript = NodePath.join(import.meta.dirname, "fork-delta.ts");

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

it("runs delta, scan, check, and suite in order when every step passes", () => {
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
      ["vp", "check"],
      ["vp", "run", "--filter", "@t3tools/scripts", "test"],
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("fails a misformatted file through vp check, reformatting nothing", () => {
  // A failing read-only check stops the battery: delta and scan pass
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
    const [delta, scan, check] = calls;
    assert.strictEqual(calls.length, 3);
    assert.deepStrictEqual(delta?.slice(0, 2), ["vp", "run"]);
    assert.deepStrictEqual(scan?.slice(0, 2), ["vp", "run"]);
    assert.deepStrictEqual(check, ["vp", "check"]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
