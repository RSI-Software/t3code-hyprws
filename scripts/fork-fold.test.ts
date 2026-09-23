// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  type FoldCommit,
  type FoldStack,
  foldMessage,
  foldTrailers,
  parsePlan,
  type ProveStep,
  resolvePlan,
  run,
} from "./fork-fold.ts";
import { squashedMembers } from "./fork-scan.ts";
import { runCommand } from "./lib/fork-command.ts";
import { parseForkTrailers } from "./lib/fork-trailers.ts";

const forkFoldScript = NodePath.join(import.meta.dirname, "fork-fold.ts");

const commit = (short: string, overrides: Partial<FoldCommit> = {}): FoldCommit => ({
  sha: short.padEnd(40, "0"),
  short,
  authorDate: "2026-01-01T00:00:00+00:00",
  subject: `feat: ${short}`,
  domain: "fork-meta",
  tier: "qol",
  files: [],
  ...overrides,
});

const stackOf = (...commits: ReadonlyArray<FoldCommit>): FoldStack => ({
  base: "upstream/main",
  head: "HEAD",
  commits,
});

it("parses members, a subject override, and skips blank and comment lines", () => {
  const plan = parsePlan("# fold the fixes\naaaa1111\tbbbb2222\tfix: one intent\n\ncccc3333\n");
  assert.deepStrictEqual(plan, [
    { line: 2, members: ["aaaa1111", "bbbb2222"], subject: "fix: one intent" },
    { line: 4, members: ["cccc3333"] },
  ]);
  assert.throws(() => parsePlan("aaaa1111\tHEAD~1\tsubject\n"), /plan line 1/);
});

it("refuses a plan that drops, repeats, or invents a commit", () => {
  const stack = stackOf(commit("aaaa1111"), commit("bbbb2222"), commit("cccc3333"));
  assert.throws(
    () => resolvePlan(parsePlan("aaaa1111\tbbbb2222\naaaa1111\ndddd4444\n"), stack),
    /aaaa1111 is listed twice[\s\S]*dddd4444 is not an ahead commit[\s\S]*cccc3333 feat: cccc3333: missing/,
  );
  const blocks = resolvePlan(parsePlan("aaaa\tcccc\nbbbb\n"), stack);
  assert.deepStrictEqual(
    blocks.map((block) => block.members.map((member) => member.short)),
    [["aaaa1111", "cccc3333"], ["bbbb2222"]],
  );
});

it("merges trailers: first domain, strongest tier, upstreamable only when all are", () => {
  assert.strictEqual(
    foldTrailers([
      commit("a", { tier: "bugfix", upstreamable: "yes" }),
      commit("b", { tier: "core" }),
    ]),
    "Fork-Domain: fork-meta\nFork-Tier: core\nFork-Upstreamable: no",
  );
  assert.strictEqual(
    foldTrailers([
      commit("a", { tier: "bugfix", upstreamable: "yes", repair: "v1" }),
      commit("b", { tier: "bugfix", upstreamable: "yes", repair: "v2" }),
    ]),
    "Fork-Domain: fork-meta\nFork-Tier: bugfix\nFork-Upstreamable: yes\nFork-Repair: v2",
  );
});

it("keeps one member verbatim and gives a fold the lead's prose, its members, and trailers", () => {
  const lead = commit("aaaa1111", { tier: "bugfix", upstreamable: "no" });
  const tail = commit("bbbb2222");
  const leadMessage = [
    "feat: aaaa1111",
    "",
    "Why the change exists.",
    "",
    "Squashes:",
    "",
    "- 0123456789 feat: an older fold member",
    "",
    "Fork-Domain: fork-meta",
    "Fork-Tier: bugfix",
    "Fork-Upstreamable: no",
    "Co-authored-by: donjor <donjor@example.com>",
    "",
  ].join("\n");
  assert.strictEqual(foldMessage({ members: [lead] }, leadMessage), leadMessage.trimEnd());
  assert.strictEqual(
    foldMessage({ members: [lead], subject: "fix: reworded" }, leadMessage).split("\n")[0],
    "fix: reworded",
  );

  const folded = foldMessage({ members: [lead, tail] }, leadMessage);
  assert.strictEqual(
    folded,
    [
      "feat: aaaa1111",
      "",
      "Why the change exists.",
      "",
      "Squashes:",
      "",
      "- aaaa1111 feat: aaaa1111",
      "- bbbb2222 feat: bbbb2222",
      "",
      "Fork-Domain: fork-meta",
      "Fork-Tier: qol",
      "Fork-Upstreamable: no",
    ].join("\n"),
  );
  // fork:scan reads exactly this fold's members as replay counterparts.
  assert.deepStrictEqual(squashedMembers(folded), ["aaaa1111", "bbbb2222"]);
  assert.deepStrictEqual(parseForkTrailers(folded), {
    domain: "fork-meta",
    tier: "qol",
    upstreamable: "no",
  });
});

// -- Fixture repository ---------------------------------------------------------

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: NodePath.join(root, ".isolated-global-gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();

const write = (root: string, path: string, text: string) =>
  NodeFS.writeFileSync(NodePath.join(root, path), text);

const commitAll = (root: string, subject: string, trailers: string): string => {
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", subject, "-m", trailers]);
  return git(root, ["rev-parse", "HEAD"]);
};

/** upstream: one seed commit; stack: meta one, zmux, meta two, zmux edit of the same line. */
const createStack = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-fold-"));
  git(root, ["init", "-q", "-b", "fixture"]);
  git(root, ["config", "user.name", "Fork Fold Test"]);
  git(root, ["config", "user.email", "fork-fold@example.com"]);
  write(root, "seed.txt", "seed\n");
  write(root, "shared.txt", "line one\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "upstream: seed"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  write(root, "meta.txt", "meta one\n");
  const metaOne = commitAll(root, "feat: meta one", "Fork-Domain: fork-meta\nFork-Tier: qol");
  write(root, "shared.txt", "zmux line\n");
  const zmux = commitAll(root, "feat: zmux", "Fork-Domain: zmux-estate\nFork-Tier: core");
  write(root, "meta2.txt", "meta two\n");
  const metaTwo = commitAll(root, "fix: meta two", "Fork-Domain: fork-meta\nFork-Tier: core");
  write(root, "shared.txt", "zmux line, edited\n");
  const zmuxEdit = commitAll(root, "fix: zmux edit", "Fork-Domain: zmux-estate\nFork-Tier: qol");
  return { root, base, metaOne, zmux, metaTwo, zmuxEdit, head: zmuxEdit };
};

const cli = (root: string, args: ReadonlyArray<string>) => {
  const result = NodeChildProcess.spawnSync(process.execPath, [forkFoldScript, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

const withStack = (body: (stack: ReturnType<typeof createStack>) => void) => {
  const stack = createStack();
  try {
    body(stack);
  } finally {
    NodeFS.rmSync(stack.root, { recursive: true, force: true });
  }
};

it("lists the ahead commits with their files in stack order", () =>
  withStack(({ root, base }) => {
    const listed = cli(root, ["list", "--json", "--base", base]);
    assert.strictEqual(listed.status, 0, listed.stderr);
    const stack = JSON.parse(listed.stdout) as FoldStack;
    assert.deepStrictEqual(
      stack.commits.map((entry) => [entry.subject, entry.domain, entry.files]),
      [
        ["feat: meta one", "fork-meta", ["meta.txt"]],
        ["feat: zmux", "zmux-estate", ["shared.txt"]],
        ["fix: meta two", "fork-meta", ["meta2.txt"]],
        ["fix: zmux edit", "zmux-estate", ["shared.txt"]],
      ],
    );
    const table = cli(root, ["list", "--base", base]);
    assert.include(table.stdout, "4 commits in");
    assert.include(table.stdout, "## zmux-estate");
  }));

it("replays an identity plan to a tree-equal tip without moving a ref", () =>
  withStack(({ root, base, metaOne, zmux, metaTwo, zmuxEdit, head }) => {
    NodeFS.writeFileSync(
      NodePath.join(root, "plan.tsv"),
      [metaOne, zmux, metaTwo, zmuxEdit].join("\n"),
    );
    const applied = cli(root, ["apply", "plan.tsv", "--base", base]);
    assert.strictEqual(applied.status, 0, applied.stderr);
    const tip = applied.stdout.trim();
    assert.strictEqual(git(root, ["rev-parse", "HEAD"]), head);
    assert.strictEqual(
      git(root, ["rev-parse", `${tip}^{tree}`]),
      git(root, ["rev-parse", `${head}^{tree}`]),
    );
    const messages = (ref: string) =>
      git(root, ["log", "--format=%an%n%aI%n%B", `${base}..${ref}`]);
    assert.strictEqual(messages(tip), messages(head));
  }));

it("folds same-domain commits across a disjoint neighbor and refuses a conflicting order", () =>
  withStack(({ root, base, metaOne, zmux, metaTwo, zmuxEdit, head }) => {
    NodeFS.writeFileSync(
      NodePath.join(root, "fold.tsv"),
      `${metaOne}\t${metaTwo}\n${zmux}\t${zmuxEdit}\tfeat: zmux, one intent\n`,
    );
    const applied = cli(root, ["apply", "fold.tsv", "--base", base]);
    assert.strictEqual(applied.status, 0, applied.stderr);
    const tip = applied.stdout.trim();
    assert.strictEqual(
      git(root, ["rev-parse", `${tip}^{tree}`]),
      git(root, ["rev-parse", `${head}^{tree}`]),
    );
    assert.deepStrictEqual(
      git(root, ["log", "--reverse", "--format=%s", `${base}..${tip}`]).split("\n"),
      ["feat: meta one", "feat: zmux, one intent"],
    );
    const meta = git(root, ["log", "-1", "--format=%B", `${tip}^`]);
    assert.include(meta, `- ${metaTwo.slice(0, 7)}`);
    assert.include(meta, "Fork-Tier: core");

    NodeFS.writeFileSync(
      NodePath.join(root, "conflict.tsv"),
      `${metaOne}\n${zmuxEdit}\n${metaTwo}\n${zmux}\n`,
    );
    const refused = cli(root, ["apply", "conflict.tsv", "--base", base]);
    assert.strictEqual(refused.status, 1);
    assert.include(refused.stderr, "fix: zmux edit: does not apply at its plan position");
  }));

it("proves tree equality, the delta check, and the replay scan, failing on any", () =>
  withStack(({ root, base, head }) => {
    const calls: Array<string> = [];
    const step: ProveStep = (command, args) => {
      calls.push([command, ...args].join(" "));
      return command === "git"
        ? runCommand(command, args, { cwd: root })
        : { status: 0, stdout: "", stderr: "" };
    };
    const target = git(root, ["merge-base", base, head]);
    assert.strictEqual(run(["prove", head, head, "--base", base], root, step), 0);
    assert.deepStrictEqual(calls, [
      `git diff --quiet ${head} ${head}`,
      `vp run fork:delta --check --base ${base} --head ${head}`,
      `vp run fork:scan --head ${head} --target ${target} --since ${target} --replay-of ${head} --no-typecheck`,
    ]);
    const parent = git(root, ["rev-parse", `${head}^`]);
    assert.strictEqual(run(["prove", head, parent, "--base", base], root, step), 1);
    assert.strictEqual(run(["prove", head], root, step), 2);
  }));
