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
  forkPullRequests,
  memberFindings,
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
  message: `feat: ${short}\n`,
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

it("refuses a plan line whose members differ in Fork-Domain", () => {
  const stack = stackOf(
    commit("aaaa1111", { domain: "fold-a" }),
    commit("bbbb2222", { domain: "fold-b" }),
  );
  assert.throws(
    () => resolvePlan(parsePlan("aaaa\tbbbb\n"), stack),
    /line 1: fold mixes Fork-Domain: fold-a, fold-b/,
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
  const lead = commit("aaaa1111", { tier: "bugfix", upstreamable: "no", message: leadMessage });
  const tail = commit("bbbb2222");
  assert.strictEqual(foldMessage({ members: [lead] }), leadMessage.trimEnd());
  assert.strictEqual(
    foldMessage({ members: [lead], subject: "fix: reworded" }).split("\n")[0],
    "fix: reworded",
  );

  const folded = foldMessage({ members: [lead, tail] });
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

it("appends every member fork PR link, and squashedMembers still reads the sha prefix", () => {
  const first = commit("aaaa1111", {
    subject: "feat(web): first (#1355)",
    message: "feat(web): first (#1355)\n\nWhy it changed.\n",
  });
  const second = commit("bbbb2222", {
    subject: "fix(web): second",
    message: "fix(web): second\n\nhttps://github.com/RSI-Software/t3code-hyprws/pull/1361\n",
  });
  const folded = foldMessage({ members: [first, second] });
  assert.include(folded, "- aaaa1111 feat(web): first (#1355) (RSI-Software/t3code-hyprws#1355)");
  assert.include(folded, "- bbbb2222 fix(web): second (RSI-Software/t3code-hyprws#1361)");
  assert.deepStrictEqual(squashedMembers(folded), ["aaaa1111", "bbbb2222"]);
});

it("renders a fixup member as the repair it carries, once per repair, and refuses one without it", () => {
  const owner = commit("aaaa1111", {
    subject: "feat: alpha feature",
    message: "feat: alpha feature\n",
  });
  const repairLine = "- 9999999 fix: post-sync repairs (#1400) (RSI-Software/t3code-hyprws#1400)";
  const fixup = (short: string): FoldCommit =>
    commit(short, {
      subject: "fixup! feat: alpha feature",
      message: [
        "fixup! feat: alpha feature",
        "",
        "Squashes:",
        "",
        repairLine,
        "",
        "Fork-Domain: fold-a",
        "Fork-Tier: core",
      ].join("\n"),
    });
  const folded = foldMessage({ members: [owner, fixup("cccc2222"), fixup("dddd3333")] });
  assert.strictEqual(folded.split(repairLine).length - 1, 1);
  assert.include(folded, "- aaaa1111 feat: alpha feature");
  assert.notInclude(folded, "fixup!");
  assert.deepStrictEqual(squashedMembers(folded), ["aaaa1111", "9999999"]);
  assert.throws(
    () =>
      foldMessage({
        members: [
          owner,
          commit("eeee4444", {
            subject: "fixup! feat: alpha feature",
            message: "fixup! feat: alpha feature\n",
          }),
        ],
      }),
    /carries no repair line/,
  );
});

it("carries an earlier fold's links into the next fold", () => {
  const earlier = commit("cccc3333", {
    subject: "feat(web): folded (#1355)",
    message: [
      "feat(web): folded (#1355)",
      "",
      "Why the fold exists.",
      "",
      "Squashes:",
      "",
      "- aaaa1111 feat(web): first (RSI-Software/t3code-hyprws#1355)",
      "- bbb2222 fix(web): second (RSI-Software/t3code-hyprws#1355) (RSI-Software/t3code-hyprws#1361)",
      "",
      "Fork-Domain: fork-meta",
      "Fork-Tier: qol",
    ].join("\n"),
  });
  const tail = commit("dddd4444", {
    subject: "fix(web): third (#1370)",
    message: "fix(web): third (#1370)\n",
  });
  const folded = foldMessage({ members: [earlier, tail] });
  assert.include(
    folded,
    "- cccc3333 feat(web): folded (#1355) (RSI-Software/t3code-hyprws#1355) (RSI-Software/t3code-hyprws#1361)",
  );
  assert.include(folded, "- dddd4444 fix(web): third (#1370) (RSI-Software/t3code-hyprws#1370)");
  // The old members are gone; only this fold's members are replay counterparts.
  assert.deepStrictEqual(squashedMembers(folded), ["cccc3333", "dddd4444"]);
});

it("carries only fork PR links: no upstream ref, no bare body #N", () => {
  const message = [
    "feat(web): port of pingdotgg/t3code#6452 (#1355)",
    "",
    "Closes #1361; upstream review at https://github.com/pingdotgg/t3code/pull/6452.",
    "",
    "Fork-Domain: fork-meta",
    "Fork-Tier: qol",
  ].join("\n");
  assert.deepStrictEqual(forkPullRequests(message), ["RSI-Software/t3code-hyprws#1355"]);
  const folded = foldMessage({
    members: [
      commit("aaaa1111", { subject: "feat(web): port of pingdotgg/t3code#6452 (#1355)", message }),
      commit("bbbb2222"),
    ],
  });
  assert.include(
    folded,
    "- aaaa1111 feat(web): port of pingdotgg/t3code#6452 (#1355) (RSI-Software/t3code-hyprws#1355)",
  );
});

it("passes a fold whose commits name their members and touch only member paths", () => {
  const a = commit("aaaa1111", { files: ["a.ts"] });
  const b = commit("bbbb2222", { subject: "fix: b", files: ["b.ts"] });
  const c = commit("cccc3333", { files: ["c.ts"] });
  const folded = commit("ffff0001", {
    subject: a.subject,
    message: foldMessage({ members: [a, b] }),
    files: ["a.ts", "b.ts"],
  });
  const kept = commit("ffff0002", { subject: c.subject, files: ["c.ts"] });
  assert.deepStrictEqual(memberFindings(stackOf(a, b, c), stackOf(folded, kept)), []);
});

it("finds a memberless commit, stray paths, and orphaned or doubly-owned old commits", () => {
  const a = commit("aaaa1111", { files: ["a.ts"] });
  const b = commit("bbbb2222", { files: ["b.ts"] });
  const orphan = commit("cccc3333");
  const stray = commit("ffff0001", { subject: a.subject, files: ["a.ts", "residue.ts"] });
  const twice = commit("ffff0002", {
    subject: "feat: twice",
    message:
      "feat: twice\n\nSquashes:\n\n- aaaa1111 feat: a\n- bbbb2222 feat: b\n- 9999aaaa earlier fold\n",
    files: ["b.ts"],
  });
  const none = commit("ffff0003", { subject: "feat: none" });
  assert.deepStrictEqual(memberFindings(stackOf(a, b, orphan), stackOf(stray, twice, none)), [
    "ffff0001 feat: aaaa1111: touches paths no member touched: residue.ts",
    "ffff0003 feat: none: names no commit in the old range",
    "aaaa1111 feat: aaaa1111: belongs to several new commits: ffff0001, ffff0002",
    "cccc3333 feat: cccc3333: belongs to no new commit",
  ]);
});

it("lets a Fork-Repair commit split across owners but not vanish", () => {
  const repair = commit("eeee0000", { repair: "v1", files: ["a.ts", "b.ts"] });
  const cites = (short: string, file: string) =>
    commit(short, {
      subject: `feat: ${short}`,
      message: `feat: ${short}\n\nSquashes:\n\n- eeee0000 fix: repair\n`,
      files: [file],
    });
  const owners = stackOf(cites("aaaa1111", "a.ts"), cites("bbbb2222", "b.ts"));
  assert.deepStrictEqual(memberFindings(stackOf(repair), owners), []);
  assert.deepStrictEqual(memberFindings(stackOf(repair), stackOf()), [
    "eeee0000 feat: eeee0000: belongs to no new commit",
  ]);
});

it("reads fork PR refs from a subject marker, a fork pull URL, and earlier Squashes lines only", () => {
  const message = [
    "feat(web): first (#1355)",
    "",
    "Body cites https://github.com/RSI-Software/t3code-hyprws/pull/1361,",
    "an upstream https://github.com/pingdotgg/t3code/pull/6452, pingdotgg/t3code#6452,",
    "an issue RSI-Software/t3code-hyprws#999, and a bare #123.",
    "",
    "Squashes:",
    "",
    "- aaaa1111 feat: older (RSI-Software/t3code-hyprws#1370)",
    "",
    "Fork-Domain: fork-meta",
  ].join("\n");
  assert.deepStrictEqual(forkPullRequests(message), [
    "RSI-Software/t3code-hyprws#1355",
    "RSI-Software/t3code-hyprws#1361",
    "RSI-Software/t3code-hyprws#1370",
  ]);
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

/**
 * upstream: seed lines l1-l5; alpha (fold-a): feature (l1), dependent (other.txt),
 * optionally a repair (l5); beta (fold-b): edit (l2), cleanup (l1, adjacent to the
 * edit). The beta pair's replay position after the alpha fold conflicts on the
 * adjacent lines, so apply must fall back to the worktree rebase.
 */
const createWorktreeStack = (withRepair: boolean) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-fold-wt-"));
  git(root, ["init", "-q", "-b", "fixture"]);
  git(root, ["config", "user.name", "Fork Fold Test"]);
  git(root, ["config", "user.email", "fork-fold@example.com"]);
  write(root, "shared.txt", "l1\nl2\nl3\nl4\nl5\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "upstream: seed lines"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  write(root, "shared.txt", "A1\nl2\nl3\nl4\nl5\n");
  const alphaFeature = commitAll(
    root,
    "feat: alpha feature",
    "Fork-Domain: fold-a\nFork-Tier: core",
  );
  write(root, "other.txt", "alpha support\n");
  const alphaDependent = commitAll(
    root,
    "fix: alpha dependent",
    "Fork-Domain: fold-a\nFork-Tier: qol",
  );
  write(root, "shared.txt", "A1\nB2\nl3\nl4\nl5\n");
  const betaEdit = commitAll(root, "fix: beta edit", "Fork-Domain: fold-b\nFork-Tier: core");
  write(root, "shared.txt", "A1!\nB2\nl3\nl4\nl5\n");
  const betaCleanup = commitAll(root, "chore: beta cleanup", "Fork-Domain: fold-b\nFork-Tier: qol");
  let repair: string | undefined;
  if (withRepair) {
    write(root, "shared.txt", "A1!\nB2\nl3\nl4\nR5\n");
    repair = commitAll(
      root,
      "fix: alpha repair",
      "Fork-Domain: fold-a\nFork-Tier: bugfix\nFork-Repair: v1",
    );
  }
  const head = git(root, ["rev-parse", "HEAD"]);
  return { root, base, alphaFeature, alphaDependent, betaEdit, betaCleanup, repair, head };
};

/**
 * upstream: seed; alpha (fold-a) and beta (fold-b) features; one repair touching
 * all three files, ready to split into two owner fixups plus an upstream-fixes residue.
 */
const createSplitStack = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-fold-split-"));
  git(root, ["init", "-q", "-b", "fixture"]);
  git(root, ["config", "user.name", "Fork Fold Test"]);
  git(root, ["config", "user.email", "fork-fold@example.com"]);
  write(root, "base.txt", "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "upstream: seed"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  write(root, "alpha.txt", "alpha one\n");
  const alpha = commitAll(root, "feat: alpha feature", "Fork-Domain: fold-a\nFork-Tier: core");
  write(root, "beta.txt", "beta one\n");
  const beta = commitAll(root, "feat: beta feature", "Fork-Domain: fold-b\nFork-Tier: core");
  write(root, "alpha.txt", "alpha one\nalpha repair\n");
  write(root, "beta.txt", "beta one\nbeta repair\n");
  write(root, "base.txt", "base\nresidue\n");
  const repair = commitAll(
    root,
    "fix: post-sync repairs (#1400)",
    "Fork-Domain: upstream-fixes\nFork-Tier: bugfix\nFork-Repair: v1",
  );
  return { root, base, alpha, beta, repair, head: repair };
};

const withSplitStack = (body: (stack: ReturnType<typeof createSplitStack>) => void) => {
  const stack = createSplitStack();
  try {
    body(stack);
  } finally {
    NodeFS.rmSync(stack.root, { recursive: true, force: true });
  }
};

/**
 * Simulates the agent's repair split on a detached copy of the head: each
 * owner's hunks become a `fixup!` commit carrying the repair line from `list`,
 * and the inseparable remainder becomes one upstream-fixes commit.
 */
const splitRepair = (root: string, repair: string, repairLine: string) => {
  git(root, ["checkout", "-q", "--detach", `${repair}^`]);
  write(root, "alpha.txt", "alpha one\nalpha repair\n");
  git(root, ["add", "alpha.txt"]);
  git(root, [
    "commit",
    "-q",
    "-m",
    "fixup! feat: alpha feature",
    "-m",
    `Squashes:\n\n${repairLine}`,
    "-m",
    "Fork-Domain: fold-a\nFork-Tier: core",
  ]);
  const alphaFixup = git(root, ["rev-parse", "HEAD"]);
  write(root, "beta.txt", "beta one\nbeta repair\n");
  git(root, ["add", "beta.txt"]);
  git(root, [
    "commit",
    "-q",
    "-m",
    "fixup! feat: beta feature",
    "-m",
    `Squashes:\n\n${repairLine}`,
    "-m",
    "Fork-Domain: fold-b\nFork-Tier: core",
  ]);
  const betaFixup = git(root, ["rev-parse", "HEAD"]);
  write(root, "base.txt", "base\nresidue\n");
  git(root, ["add", "base.txt"]);
  git(root, [
    "commit",
    "-q",
    "-m",
    "fix: adapt the seed layout to the upstream change",
    "-m",
    "Fork-Domain: upstream-fixes\nFork-Tier: bugfix",
  ]);
  return { alphaFixup, betaFixup, residue: git(root, ["rev-parse", "HEAD"]) };
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

const withWorktreeStack = (
  withRepair: boolean,
  body: (stack: ReturnType<typeof createWorktreeStack>) => void,
) => {
  const stack = createWorktreeStack(withRepair);
  try {
    body(stack);
  } finally {
    NodeFS.rmSync(stack.root, { recursive: true, force: true });
  }
};

/** Simulates the agent at one stop: write the resolved lines and stage them. */
const resolveStop = (root: string, worktree: string, shared: string) => {
  NodeFS.writeFileSync(NodePath.join(worktree, "shared.txt"), shared);
  git(root, ["-C", worktree, "add", "shared.txt"]);
};

const stateDir = (root: string) => NodePath.join(root, ".git", "fork-fold");
const worktreeDir = (root: string) => NodePath.join(stateDir(root), "worktree");

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
    const stopped = cli(root, ["apply", "conflict.tsv", "--base", base]);
    assert.strictEqual(stopped.status, 1);
    assert.include(stopped.stderr, "merge-tree refused");
    assert.include(stopped.stderr, "stopped: ");
    assert.include(stopped.stderr, "fix: zmux edit");
    assert.include(stopped.stderr, worktreeDir(root));
    assert.strictEqual(NodeFS.existsSync(worktreeDir(root)), true);
  }));

it("refuses a mixed-domain line before any replay work", () =>
  withWorktreeStack(false, ({ root, base, alphaFeature, betaEdit }) => {
    NodeFS.writeFileSync(NodePath.join(root, "mixed.tsv"), `${alphaFeature}\t${betaEdit}\n`);
    const refused = cli(root, ["apply", "mixed.tsv", "--base", base]);
    assert.strictEqual(refused.status, 1);
    assert.include(refused.stderr, "fold mixes Fork-Domain: fold-a, fold-b");
    assert.strictEqual(NodeFS.existsSync(stateDir(root)), false);
  }));

it("falls back to a worktree rebase at the first refused block and resumes across stops to a tree-equal tip", () =>
  withWorktreeStack(
    false,
    ({ root, base, alphaFeature, alphaDependent, betaCleanup, betaEdit, head }) => {
      NodeFS.writeFileSync(
        NodePath.join(root, "plan.tsv"),
        `${alphaFeature}\t${alphaDependent}\n${betaCleanup}\t${betaEdit}\n`,
      );
      const worktree = worktreeDir(root);
      const apply = () => cli(root, ["apply", "plan.tsv", "--base", base]);

      // The alpha fold carries the fast path; the beta pair refuses there — it
      // cannot replay before its dependent — and moves to the worktree rebase.
      const first = apply();
      assert.strictEqual(first.status, 1, first.stderr);
      assert.include(first.stderr, "merge-tree refused");
      assert.include(first.stderr, "stopped: ");
      assert.include(first.stderr, "chore: beta cleanup");
      assert.include(first.stderr, worktree);
      assert.strictEqual(NodeFS.existsSync(worktree), true);

      resolveStop(root, worktree, "A1!\nl2\nl3\nl4\nl5\n");
      const second = apply();
      assert.strictEqual(second.status, 1, second.stderr);
      assert.include(second.stderr, "stopped: ");
      assert.include(second.stderr, "fix: beta edit");

      resolveStop(root, worktree, "A1!\nB2\nl3\nl4\nl5\n");
      const third = apply();
      assert.strictEqual(third.status, 0, third.stderr);
      const tip = third.stdout.trim();
      assert.strictEqual(
        git(root, ["rev-parse", `${tip}^{tree}`]),
        git(root, ["rev-parse", `${head}^{tree}`]),
      );
      assert.strictEqual(git(root, ["rev-parse", "HEAD"]), head);
      // A finished fold removes the throwaway worktree and its state.
      assert.strictEqual(NodeFS.existsSync(stateDir(root)), false);
      assert.deepStrictEqual(
        git(root, ["log", "--reverse", "--format=%s", `${base}..${tip}`]).split("\n"),
        ["feat: alpha feature", "chore: beta cleanup"],
      );
      const beta = git(root, ["log", "-1", "--format=%B", tip]);
      assert.include(beta, `- ${betaCleanup.slice(0, 7)}`);
      assert.include(beta, `- ${betaEdit.slice(0, 7)}`);
      assert.include(beta, "Fork-Domain: fold-b");
      assert.include(beta, "Fork-Tier: core");
    },
  ));

it("starts a repair-absorbing run in the worktree and finishes it tree-equal", () =>
  withWorktreeStack(
    true,
    ({ root, base, alphaFeature, alphaDependent, betaCleanup, betaEdit, repair, head }) => {
      assert.notStrictEqual(repair, undefined);
      NodeFS.writeFileSync(
        NodePath.join(root, "plan.tsv"),
        `${alphaFeature}\t${alphaDependent}\t${repair}\n${betaCleanup}\t${betaEdit}\n`,
      );
      const worktree = worktreeDir(root);
      const apply = () => cli(root, ["apply", "plan.tsv", "--base", base]);

      const first = apply();
      assert.strictEqual(first.status, 1, first.stderr);
      assert.include(first.stderr, "stopped: ");
      assert.include(first.stderr, "chore: beta cleanup");
      // The whole plan started in the worktree: the rebase sits on the seed,
      // not on a merge-tree fold of the first group.
      const rebaseMerge = git(root, [
        "-C",
        worktree,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "rebase-merge",
      ]);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(rebaseMerge, "onto"), "utf8").trim(),
        base,
      );

      resolveStop(root, worktree, "A1!\nl2\nl3\nl4\nR5\n");
      const second = apply();
      assert.strictEqual(second.status, 1, second.stderr);
      assert.include(second.stderr, "stopped: ");
      assert.include(second.stderr, "fix: beta edit");

      resolveStop(root, worktree, "A1!\nB2\nl3\nl4\nR5\n");
      const third = apply();
      assert.strictEqual(third.status, 0, third.stderr);
      assert.strictEqual(
        git(root, ["rev-parse", `${third.stdout.trim()}^{tree}`]),
        git(root, ["rev-parse", `${head}^{tree}`]),
      );
      assert.strictEqual(NodeFS.existsSync(stateDir(root)), false);
    },
  ));

it("folds a split repair into its owners, provenance and residue included", () =>
  withSplitStack(({ root, base, alpha, beta, repair, head }) => {
    // list prints the line every split piece copies under its Squashes:.
    const listed = cli(root, ["list", "--base", base]);
    assert.strictEqual(listed.status, 0, listed.stderr);
    const repairLine = listed.stdout.split("fixup line: ")[1]?.split("\n")[0] ?? "";
    assert.strictEqual(
      repairLine,
      `- ${repair.slice(0, 7)} fix: post-sync repairs (#1400) (RSI-Software/t3code-hyprws#1400)`,
    );

    const { alphaFixup, betaFixup, residue } = splitRepair(root, repair, repairLine);
    const splitHead = residue;
    assert.strictEqual(
      git(root, ["rev-parse", `${splitHead}^{tree}`]),
      git(root, ["rev-parse", `${head}^{tree}`]),
    );
    const splitList = cli(root, ["list", "--base", base, "--head", splitHead, "--json"]);
    assert.strictEqual(splitList.status, 0, splitList.stderr);
    const split = JSON.parse(splitList.stdout) as FoldStack;
    assert.deepStrictEqual(
      split.commits.map((entry) => entry.subject),
      [
        "feat: alpha feature",
        "feat: beta feature",
        "fixup! feat: alpha feature",
        "fixup! feat: beta feature",
        "fix: adapt the seed layout to the upstream change",
      ],
    );

    NodeFS.writeFileSync(
      NodePath.join(root, "plan.tsv"),
      [`${alpha}\t${alphaFixup}`, `${beta}\t${betaFixup}`, residue].join("\n"),
    );
    const applied = cli(root, ["apply", "plan.tsv", "--base", base, "--head", splitHead]);
    assert.strictEqual(applied.status, 0, applied.stderr);
    const tip = applied.stdout.trim();
    assert.strictEqual(
      git(root, ["rev-parse", `${tip}^{tree}`]),
      git(root, ["rev-parse", `${head}^{tree}`]),
    );
    assert.deepStrictEqual(
      git(root, ["log", "--reverse", "--format=%s", `${base}..${tip}`]).split("\n"),
      [
        "feat: alpha feature",
        "feat: beta feature",
        "fix: adapt the seed layout to the upstream change",
      ],
    );

    // Each owner lists its old sha, the repair sha, and the repair's reference.
    const alphaBody = git(root, ["log", "-1", "--format=%B", `${tip}~2`]);
    assert.include(alphaBody, `- ${alpha.slice(0, 7)} feat: alpha feature`);
    assert.include(alphaBody, repairLine);
    assert.notInclude(alphaBody, "fixup!");
    assert.include(alphaBody, "Fork-Domain: fold-a\nFork-Tier: core");
    assert.notInclude(alphaBody, "Fork-Repair");
    assert.deepStrictEqual(squashedMembers(alphaBody), [alpha.slice(0, 7), repair.slice(0, 7)]);
    const betaBody = git(root, ["log", "-1", "--format=%B", `${tip}^`]);
    assert.include(betaBody, `- ${beta.slice(0, 7)} feat: beta feature`);
    assert.include(betaBody, repairLine);
    assert.deepStrictEqual(squashedMembers(betaBody), [beta.slice(0, 7), repair.slice(0, 7)]);
    const residueBody = git(root, ["log", "-1", "--format=%B", tip]);
    assert.notInclude(residueBody, "Squashes:");
    assert.notInclude(residueBody, "Fork-Repair");
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

// -- Publish: a local bare origin, so tests never push to a real remote ----------

const remoteHyprws = (root: string): string =>
  git(root, ["rev-parse", "refs/remotes/origin/hyprws"]);

/** The stack fixture plus local `hyprws` at the tip, checked out in root, published to a bare origin. */
const createTrunk = () => {
  const stack = createStack();
  const origin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-fold-origin-"));
  git(origin, ["init", "--bare", "-q"]);
  git(stack.root, ["remote", "add", "origin", origin]);
  git(stack.root, ["branch", "hyprws", stack.head]);
  git(stack.root, ["checkout", "-q", "hyprws"]);
  git(stack.root, ["push", "-q", "origin", "hyprws"]);
  return { ...stack, origin };
};

const withTrunk = (body: (trunk: ReturnType<typeof createTrunk>) => void) => {
  const trunk = createTrunk();
  try {
    body(trunk);
  } finally {
    NodeFS.rmSync(trunk.root, { recursive: true, force: true });
    NodeFS.rmSync(trunk.origin, { recursive: true, force: true });
  }
};

/** Applies the two per-domain folds; the plan file must not dirty the tree. */
const foldTo = (root: string, base: string, members: [string, string, string, string]): string => {
  NodeFS.writeFileSync(
    NodePath.join(root, "fold.tsv"),
    `${members[0]}\t${members[1]}\n${members[2]}\t${members[3]}\n`,
  );
  const applied = cli(root, ["apply", "fold.tsv", "--base", base]);
  NodeFS.unlinkSync(NodePath.join(root, "fold.tsv"));
  assert.strictEqual(applied.status, 0, applied.stderr);
  return applied.stdout.trim();
};

/** Real git against the fixture, stubbed green vp checks; every call recorded. */
const publishStep = (root: string) => {
  const calls: Array<string> = [];
  const step: ProveStep = (command, args) => {
    calls.push([command, ...args].join(" "));
    return command === "git"
      ? runCommand(command, args, { cwd: root })
      : { status: 0, stdout: "", stderr: "" };
  };
  return { calls, step };
};

it("publish proves, pushes the expected-old lease, and moves the local trunk", () =>
  withTrunk(({ root, base, metaOne, metaTwo, zmux, zmuxEdit, head }) => {
    const next = foldTo(root, base, [metaOne, metaTwo, zmux, zmuxEdit]);
    const target = git(root, ["merge-base", base, next]);
    const { calls, step } = publishStep(root);
    assert.strictEqual(run(["publish", head, next, "--base", base], root, step), 0);
    assert.strictEqual(remoteHyprws(root), next);
    assert.strictEqual(git(root, ["rev-parse", "refs/heads/hyprws"]), next);
    // The lease is the <old> resolved at the start; no fetch re-resolves it.
    assert.deepStrictEqual(calls, [
      `git diff --quiet ${head} ${next}`,
      `vp run fork:delta --check --base ${base} --head ${next}`,
      `vp run fork:scan --head ${next} --target ${target} --since ${target} --replay-of ${head} --no-typecheck`,
      `git push origin ${next}:hyprws --force-with-lease=hyprws:${head}`,
    ]);
  }));

it("a failed proof pushes nothing", () =>
  withTrunk(({ root, base, head }) => {
    const parent = git(root, ["rev-parse", `${head}^`]);
    const { calls, step } = publishStep(root);
    assert.strictEqual(run(["publish", head, parent, "--base", base], root, step), 1);
    assert.strictEqual(remoteHyprws(root), head);
    assert.strictEqual(git(root, ["rev-parse", "refs/heads/hyprws"]), head);
    assert.ok(calls.every((call) => !call.startsWith("git push")));
  }));

it("a moved remote refuses the lease and keeps the local trunk", () =>
  withTrunk(({ root, base, metaOne, metaTwo, zmux, zmuxEdit, head }) => {
    const next = foldTo(root, base, [metaOne, metaTwo, zmux, zmuxEdit]);
    git(root, ["push", "-q", "origin", "--force", `${base}:hyprws`]);
    const { calls, step } = publishStep(root);
    assert.strictEqual(run(["publish", head, next, "--base", base], root, step), 1);
    assert.strictEqual(remoteHyprws(root), base);
    assert.strictEqual(git(root, ["rev-parse", "refs/heads/hyprws"]), head);
    assert.ok(calls.some((call) => call.startsWith("git push")));
  }));

it("checks the hyprws worktree, not the invoking checkout, and skips when checked out nowhere", () =>
  withTrunk(({ root, base, metaOne, metaTwo, zmux, zmuxEdit, head }) => {
    const next = foldTo(root, base, [metaOne, metaTwo, zmux, zmuxEdit]);
    git(root, ["checkout", "-q", "fixture"]); // publish runs from another checkout
    const trunk = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-fold-trunk-")),
      "wt",
    );
    git(root, ["worktree", "add", "-q", trunk, "hyprws"]);
    try {
      // A dirty trunk worktree refuses even though the invoking checkout is clean.
      const dirtyTrunk = publishStep(root);
      write(trunk, "dirty.txt", "uncommitted\n");
      assert.strictEqual(run(["publish", head, next, "--base", base], root, dirtyTrunk.step), 1);
      assert.deepStrictEqual(dirtyTrunk.calls, []);
      assert.strictEqual(remoteHyprws(root), head);
      NodeFS.unlinkSync(NodePath.join(trunk, "dirty.txt"));
      git(root, ["worktree", "remove", trunk]);

      // Checked out nowhere: no worktree tree to check, so a dirty invoking
      // checkout does not refuse.
      const nowhere = publishStep(root);
      write(root, "dirty.txt", "uncommitted\n");
      assert.strictEqual(run(["publish", head, next, "--base", base], root, nowhere.step), 0);
      assert.strictEqual(remoteHyprws(root), next);
      assert.strictEqual(git(root, ["rev-parse", "refs/heads/hyprws"]), next);
    } finally {
      NodeFS.rmSync(NodePath.dirname(trunk), { recursive: true, force: true });
    }
  }));

it("a dirty or moved local refuses before prove and push", () =>
  withTrunk(({ root, base, head }) => {
    const dirty = publishStep(root);
    write(root, "dirty.txt", "uncommitted\n");
    assert.strictEqual(run(["publish", head, head, "--base", base], root, dirty.step), 1);
    assert.deepStrictEqual(dirty.calls, []);
    assert.strictEqual(remoteHyprws(root), head);
    NodeFS.unlinkSync(NodePath.join(root, "dirty.txt"));

    const moved = publishStep(root);
    git(root, ["update-ref", "refs/heads/hyprws", base]);
    assert.strictEqual(run(["publish", head, head, "--base", base], root, moved.step), 1);
    assert.deepStrictEqual(moved.calls, []);
    assert.strictEqual(git(root, ["rev-parse", "refs/heads/hyprws"]), base);
  }));
