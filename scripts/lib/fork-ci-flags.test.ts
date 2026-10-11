// @effect-diagnostics nodeBuiltinImport:off - Flag derivation is Git plumbing; fixtures need real repositories.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  deriveForkCiFlags,
  forkScanArguments,
  renderForkCiOutputs,
  renderForkCiScanArguments,
  systemForkCiGit,
  type ForkCiGit,
} from "./fork-ci-flags.ts";
import { SystemGit } from "./fork-command.ts";

const HEAD = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const BASE = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
const TRUNK = "cccc3333cccc3333cccc3333cccc3333cccc3333";
const HEAD_PARENT = "dddd4444dddd4444dddd4444dddd4444dddd4444";

const fakeGit = (overrides: {
  readonly base?: string;
  readonly trunkMergeBase?: string | null;
  readonly trunkResolves?: boolean;
  readonly trunkBelowBase?: boolean;
}): ForkCiGit => ({
  run: (args) => {
    if (args[0] === "merge-base" && args[1] === "upstream/main")
      return `${overrides.base ?? BASE}\n`;
    if (args[0] === "rev-parse") return `${HEAD}\n`;
    throw new Error(`unexpected required git call: ${args.join(" ")}`);
  },
  attempt: (args) => {
    if (args[0] === "merge-base" && args[1] === "--is-ancestor")
      return overrides.trunkBelowBase === true ? "" : null;
    if (args[0] === "merge-base")
      return overrides.trunkMergeBase === undefined ? `${TRUNK}\n` : overrides.trunkMergeBase;
    if (args[0] === "rev-parse") return overrides.trunkResolves === false ? null : `${TRUNK}\n`;
    return null;
  },
});

it("derives base, since, target, and replay-of the way the workflow used to", () => {
  assert.deepStrictEqual(deriveForkCiFlags(fakeGit({}), HEAD), {
    head: HEAD,
    base: BASE,
    since: TRUNK,
    target: BASE,
    replayOf: "origin/hyprws",
    rebased: false,
  });
});

it("falls back to head^ when the head is the trunk tip itself", () => {
  const flags = deriveForkCiFlags(fakeGit({ trunkMergeBase: `${HEAD}\n` }), HEAD);
  assert.strictEqual(flags.since, `${HEAD}^`);
});

it("falls back to head^ and drops replay-of when the trunk ref is absent", () => {
  const flags = deriveForkCiFlags(fakeGit({ trunkMergeBase: null, trunkResolves: false }), HEAD);
  assert.strictEqual(flags.since, `${HEAD}^`);
  assert.strictEqual(flags.replayOf, null);
});

it("passes the whole CI shape to fork:scan, replay-of included only when it resolves", () => {
  const flags = deriveForkCiFlags(fakeGit({}), HEAD);
  assert.deepStrictEqual(forkScanArguments(flags), [
    "--head",
    HEAD,
    "--target",
    BASE,
    "--since",
    TRUNK,
    "--replay-of",
    "origin/hyprws",
    "--no-typecheck",
  ]);
  const offTrunk = deriveForkCiFlags(fakeGit({ trunkResolves: false, trunkMergeBase: null }), HEAD);
  assert.deepStrictEqual(forkScanArguments(offTrunk), [
    "--head",
    HEAD,
    "--target",
    BASE,
    "--since",
    `${HEAD}^`,
    "--no-typecheck",
  ]);
});

it("renders the base and since outputs the workflow consumes", () => {
  assert.strictEqual(
    renderForkCiOutputs(deriveForkCiFlags(fakeGit({}), HEAD)),
    `base=${BASE}\nsince=${TRUNK}\nrebased=false\n`,
  );
  assert.strictEqual(
    renderForkCiOutputs(
      deriveForkCiFlags(fakeGit({ trunkResolves: false, trunkMergeBase: null }), HEAD),
    ),
    `base=${BASE}\nsince=${HEAD}^\nrebased=false\n`,
  );
  assert.strictEqual(
    renderForkCiOutputs(deriveForkCiFlags(fakeGit({ trunkBelowBase: true }), HEAD)),
    `base=${BASE}\nsince=${BASE}\nrebased=true\n`,
  );
});

it("renders the scan argv one token per line for the workflow's mapfile", () => {
  assert.strictEqual(
    renderForkCiScanArguments(deriveForkCiFlags(fakeGit({}), HEAD)),
    `--head\n${HEAD}\n--target\n${BASE}\n--since\n${TRUNK}\n--replay-of\norigin/hyprws\n--no-typecheck\n`,
  );
});

const repository = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-ci-flags-test-"));
  const git = (args: ReadonlyArray<string>): void => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.stdout}`);
  };
  git(["init", "--quiet", "--initial-branch", "main"]);
  git(["config", "user.email", "fork@example.invalid"]);
  git(["config", "user.name", "fork"]);
  NodeFS.writeFileSync(NodePath.join(root, "upstream.txt"), "upstream\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "upstream base"]);
  git(["update-ref", "refs/remotes/upstream/main", "main"]);
  git(["branch", "trunk"]);
  NodeFS.writeFileSync(NodePath.join(root, "fork.txt"), "fork\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "fork commit", "-m", "Fork-Domain: fork-meta"]);
  return root;
};

it("derives the same flags from a real repository with remote-tracking refs", () => {
  const root = repository();
  try {
    const git = systemForkCiGit(new SystemGit(root));
    const reader = new SystemGit(root);
    const head = reader.run(["rev-parse", "HEAD"]).trim();
    const base = reader.run(["rev-parse", "trunk"]).trim();
    // No origin/hyprws ref yet: since falls back to head^ and replay-of is absent.
    assert.deepStrictEqual(deriveForkCiFlags(git, head), {
      head,
      base,
      since: `${head}^`,
      target: base,
      replayOf: null,
      rebased: false,
    });
    reader.run(["update-ref", "refs/remotes/origin/hyprws", "main"]);
    // The head sits on the trunk tip: still head^, but the trunk now resolves.
    assert.deepStrictEqual(deriveForkCiFlags(git, head), {
      head,
      base,
      since: `${head}^`,
      target: base,
      replayOf: "origin/hyprws",
      rebased: false,
    });
    reader.run(["update-ref", "refs/remotes/origin/hyprws", "trunk"]);
    // One fork commit above the trunk: the trunk commit is the since.
    assert.deepStrictEqual(deriveForkCiFlags(git, head), {
      head,
      base,
      since: base,
      target: base,
      replayOf: "origin/hyprws",
      rebased: false,
    });
    // A sync candidate: the fork commit replayed onto a newer upstream base.
    reader.run(["checkout", "--quiet", "--detach", "trunk"]);
    NodeFS.writeFileSync(NodePath.join(root, "upstream.txt"), "upstream v2\n");
    reader.run(["commit", "--quiet", "--all", "-m", "upstream release"]);
    reader.run(["update-ref", "refs/remotes/upstream/main", "HEAD"]);
    const newBase = reader.run(["rev-parse", "HEAD"]).trim();
    reader.run(["cherry-pick", head]);
    reader.run(["update-ref", "refs/remotes/origin/hyprws", head]);
    const candidate = reader.run(["rev-parse", "HEAD"]).trim();
    assert.deepStrictEqual(deriveForkCiFlags(git, candidate), {
      head: candidate,
      base: newBase,
      since: newBase,
      target: newBase,
      replayOf: "origin/hyprws",
      rebased: true,
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("starts a sync candidate's range at its base, not the old trunk's upstream base", () => {
  const flags = deriveForkCiFlags(fakeGit({ trunkBelowBase: true }), HEAD);
  assert.strictEqual(flags.since, BASE);
  assert.strictEqual(flags.rebased, true);
});

it("never treats the trunk tip itself as a candidate", () => {
  const flags = deriveForkCiFlags(
    fakeGit({ trunkMergeBase: `${HEAD}\n`, trunkBelowBase: true }),
    HEAD,
  );
  assert.strictEqual(flags.since, `${HEAD}^`);
  assert.strictEqual(flags.rebased, false);
});
