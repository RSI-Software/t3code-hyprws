// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { parseForkRetirementLedger } from "./lib/fork-retirement-ledger.ts";
import {
  MergeTreeError,
  parseMergeTreeResult,
  runMergeTree,
} from "./lib/fork-rebase-feasibility.ts";
import {
  buildReport,
  canonicalRepository,
  classifyChangeType,
  encodeReportJson,
  parseArgs,
  parseCommitLog,
  renderMarkdown,
  renderStateGraph,
  run,
  SystemGit,
  UsageError,
  type ForkRebaseReport,
  type ReportCommit,
} from "./fork-rebase-report.ts";

it("normalizes HTTPS and SCP-style GitHub remotes", () => {
  assert.deepStrictEqual(canonicalRepository("https://github.com/pingdotgg/t3code.git"), {
    slug: "pingdotgg/t3code",
    webUrl: "https://github.com/pingdotgg/t3code",
  });
  assert.deepStrictEqual(canonicalRepository("git@github.com:RSI-Software/t3code-hyprws.git"), {
    slug: "RSI-Software/t3code-hyprws",
    webUrl: "https://github.com/RSI-Software/t3code-hyprws",
  });
});

const commit = (letter: string, subject: string): ReportCommit => {
  const sha = letter.repeat(40);
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject,
    type: classifyChangeType(subject),
  };
};

const upstreamTagged = commit("b", "fix(web): tagged upstream change");
const upstreamUnreleased = commit("c", "docs: unreleased upstream change");
const forkReleased = commit("d", "feat(desktop): released fork change");
const forkUnreleased = commit("e", "unscoped fork change");

const fixture: ForkRebaseReport = {
  schemaVersion: 3,
  generatedBy: "vp run fork:rebase-report",
  sharedBase: {
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    upstreamTags: ["v0.0.34-nightly.20260823.1163", "v0.0.34-nightly.20260823.1164"],
  },
  upstream: {
    ref: "upstream/main",
    sha: upstreamUnreleased.sha,
    shortSha: upstreamUnreleased.shortSha,
    repository: { slug: "pingdotgg/t3code", webUrl: "https://github.com/pingdotgg/t3code" },
    commitCount: 2,
    changeTypes: { docs: 1, fix: 1 },
    releases: [
      {
        tag: "v0.0.34-nightly.20260823.1163",
        sha: "a".repeat(40),
        shortSha: "aaaaaaa",
        commitsSincePrevious: [],
      },
      {
        tag: "v0.0.34-nightly.20260823.1164",
        sha: "a".repeat(40),
        shortSha: "aaaaaaa",
        commitsSincePrevious: [],
      },
      {
        tag: "v0.0.34-nightly.20260823.1166",
        sha: upstreamTagged.sha,
        shortSha: upstreamTagged.shortSha,
        commitsSincePrevious: [upstreamTagged],
      },
    ],
    unreleasedCommits: [upstreamUnreleased],
  },
  hyprws: {
    ref: "origin/hyprws",
    sha: forkUnreleased.sha,
    shortSha: forkUnreleased.shortSha,
    repository: {
      slug: "RSI-Software/t3code-hyprws",
      webUrl: "https://github.com/RSI-Software/t3code-hyprws",
    },
    commitCount: 2,
    changeTypes: { feat: 1, other: 1 },
    releases: [
      {
        tag: "v0.0.34-hyprws.1",
        sha: forkReleased.sha,
        shortSha: forkReleased.shortSha,
        commitsSincePrevious: [forkReleased],
      },
    ],
    unreleasedCommits: [forkUnreleased],
  },
  feasibility: {
    ffBoundary: {
      upstreamCommitCount: 2,
      cleanCommitCount: 2,
      firstConflict: null,
      changes: [],
    },
    conflicts: [],
    overlap: {
      upstreamChanged: 2,
      forkChanged: 2,
      overlap: 0,
      hardConflict: 0,
      automerged: [],
    },
  },
  retireCandidates: [],
};

it("classifies conventional prefixes and leaves prose as Other", () => {
  assert.strictEqual(classifyChangeType("fix(web): restore route"), "fix");
  assert.strictEqual(classifyChangeType("feat!: replace protocol"), "feat");
  assert.strictEqual(classifyChangeType("unscoped fork change"), null);
});

it("parses the deterministic full-SHA git log format", () => {
  const raw = `${"f".repeat(40)}\u001ffix: first\u001e\n${"1".repeat(40)}\u001fplain subject\u001e\n`;
  assert.deepStrictEqual(parseCommitLog(raw), [
    {
      sha: "f".repeat(40),
      shortSha: "fffffff",
      subject: "fix: first",
      type: "fix",
    },
    {
      sha: "1".repeat(40),
      shortSha: "1111111",
      subject: "plain subject",
      type: null,
    },
  ]);
});

it("renders the accepted vertical split with two lanes and no node circles", () => {
  const lines = renderStateGraph(fixture).split("\n");
  assert.strictEqual(lines[0], `${" ".repeat(34)}aaaaaaa`);
  assert.strictEqual(lines[3], `${" ".repeat(8)}┌${"─".repeat(27)}┴${"─".repeat(27)}┐`);
  assert.strictEqual(lines[6], "UPSTREAM".padEnd(60) + "HYPRWS");
  assert.strictEqual(
    lines[8],
    "v0.0.34-nightly.20260823.1163 @ aaaaaaa".padEnd(60) + "fork base @ aaaaaaa",
  );
  assert.ok(lines.some((line) => line.startsWith("v0.0.34-nightly.20260823.1164 @ aaaaaaa")));
  assert.ok(lines.some((line) => line.endsWith("origin/hyprws @ eeeeeee")));
  assert.notInclude(renderStateGraph(fixture), "○");
});

it("renders compact release dividers and changelogs on both sides", () => {
  const markdown = renderMarkdown(fixture);
  assert.ok(markdown.indexOf("## Change types") < markdown.indexOf("## Upstream commits/merges"));
  assert.match(markdown, /\| `fix`\s+\|\s+1 \|\s+0 \|/);
  assert.match(markdown, /\| Other\s+\|\s+0 \|\s+1 \|/);
  assert.match(markdown, /-+\[ nightly 1166 \]-+/);
  assert.match(markdown, /-+\[ release v0\.0\.34-hyprws\.1 \]-+/);
  assert.include(markdown, "[`bbbbbbb`](https://github.com/");
  assert.include(markdown, "fix(web): tagged upstream change");
  assert.include(markdown, "feat(desktop): released fork change");
  assert.notInclude(markdown, "###");
  assert.strictEqual(markdown.endsWith("\n"), true);
});

it("encodes versioned, stable, ANSI-free JSON", () => {
  const first = encodeReportJson(fixture);
  const second = encodeReportJson(fixture);
  assert.strictEqual(first, second);
  assert.strictEqual(JSON.parse(first).schemaVersion, 3);
  assert.notMatch(first, /\u001b\[/);
});

it("parses cron and manual output options and rejects ambiguous argv", () => {
  assert.deepStrictEqual(
    parseArgs([
      "--fetch",
      "--check",
      "--source",
      "fork/live",
      "--target",
      "canonical/main",
      "--json-out",
      "state.json",
      "--markdown-out",
      "state.md",
    ]),
    {
      source: "fork/live",
      target: "canonical/main",
      jsonOut: "state.json",
      markdownOut: "state.md",
      fetch: true,
      check: true,
    },
  );
  assert.throws(() => parseArgs(["--fetch", "--fetch"]), UsageError);
  assert.throws(() => parseArgs(["--wat"]), UsageError);
  assert.throws(() => parseArgs(["--source"]), UsageError);
});

interface GitFixture {
  readonly root: string;
  readonly sourceSha: string;
  readonly cleanTargetSha: string;
  readonly conflictTargetSha: string;
  readonly introducingSha: string;
  readonly alreadyUpstreamSha: string;
}

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();

const writeLines = (root: string, path: string, changes: Readonly<Record<number, string>> = {}) => {
  const lines = Array.from({ length: 36 }, (_, index) => changes[index + 1] ?? `line ${index + 1}`);
  NodeFS.writeFileSync(NodePath.join(root, path), `${lines.join("\n")}\n`);
};

const makeGitFixture = (): GitFixture => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-rebase-report-"));
  git(root, ["init", "-b", "base"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["remote", "add", "origin", "https://github.com/RSI-Software/t3code-hyprws.git"]);
  git(root, ["remote", "add", "upstream", "https://github.com/pingdotgg/t3code.git"]);

  writeLines(root, "shared.txt");
  writeLines(root, "auto.txt");
  writeLines(root, "adjacent.txt");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  git(root, ["branch", "fork-stack"]);

  git(root, ["switch", "-c", "upstream-lane"]);
  writeLines(root, "auto.txt", { 30: "upstream auto change" });
  writeLines(root, "adjacent.txt", { 12: "upstream adjacent change" });
  NodeFS.writeFileSync(NodePath.join(root, "upstream.txt"), "upstream\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fix: clean upstream change"]);
  const cleanTargetSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["tag", "v1.0.0-nightly.1"]);

  writeLines(root, "shared.txt", {
    2: "upstream first conflict",
    30: "upstream second conflict",
  });
  git(root, ["add", "shared.txt"]);
  git(root, ["commit", "-m", "feat: conflicting upstream change"]);
  const conflictTargetSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["tag", "v1.0.0"]);
  git(root, ["update-ref", "refs/remotes/upstream/main", conflictTargetSha]);

  git(root, ["switch", "fork-stack"]);
  writeLines(root, "shared.txt", { 2: "fork first conflict", 30: "fork second conflict" });
  writeLines(root, "auto.txt", { 2: "fork auto change" });
  writeLines(root, "adjacent.txt", { 10: "fork adjacent change" });
  git(root, ["add", "."]);
  git(root, [
    "commit",
    "-m",
    "feat(test): introduce fork changes",
    "-m",
    "Fork-Domain: fixture-domain\nFork-Tier: qol",
  ]);
  const introducingSha = git(root, ["rev-parse", "HEAD"]);

  NodeFS.writeFileSync(NodePath.join(root, "upstream.txt"), "upstream\n");
  git(root, ["add", "upstream.txt"]);
  git(root, [
    "commit",
    "-m",
    "fix(test): change already upstream",
    "-m",
    "Fork-Domain: fixture-domain\nFork-Tier: bugfix\nFork-Upstreamable: yes",
  ]);
  const sourceSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", "refs/remotes/origin/hyprws", sourceSha]);

  NodeFS.mkdirSync(NodePath.join(root, "docs/internals"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(root, "docs/internals/fork-delta.md"),
    "## Retired\n\n| Fork commit | Domain | Upstream replacement | Retired at |\n| --- | --- | --- | --- |\n\n## Kept\n\n| Fork commit | Domain | Reason | Reviewed at |\n| --- | --- | --- | --- |\n",
  );

  return {
    root,
    sourceSha,
    cleanTargetSha,
    conflictTargetSha,
    introducingSha,
    alreadyUpstreamSha: sourceSha,
  };
};

it("reports a clean fork stack through a non-conflicting target", () => {
  const fixtureRepo = makeGitFixture();
  try {
    const report = buildReport(
      new SystemGit(fixtureRepo.root),
      "origin/hyprws",
      fixtureRepo.cleanTargetSha,
    );
    assert.strictEqual(report.schemaVersion, 3);
    assert.strictEqual(report.feasibility.ffBoundary.firstConflict, null);
    assert.strictEqual(report.feasibility.ffBoundary.cleanCommitCount, 1);
    assert.deepStrictEqual(report.feasibility.conflicts, []);
    assert.deepStrictEqual(
      report.retireCandidates.map((candidate) => [
        candidate.commit,
        candidate.signals.map((signal) => signal.kind),
      ]),
      [
        [fixtureRepo.introducingSha, ["behaviour-overlap"]],
        [fixtureRepo.alreadyUpstreamSha, ["already-upstream", "behaviour-overlap"]],
      ],
    );
    assert.include(
      report.retireCandidates[0]?.signals[0]?.evidence ?? "",
      "weak hunk overlap: adjacent.txt@10~12",
    );
    assert.notInclude(report.retireCandidates[0]?.signals[0]?.evidence ?? "", "auto.txt");
  } finally {
    NodeFS.rmSync(fixtureRepo.root, { recursive: true, force: true });
  }
});

it("finds conflict commit N, attributes files and counts conflict hunks and overlap", () => {
  const fixtureRepo = makeGitFixture();
  try {
    const report = buildReport(
      new SystemGit(fixtureRepo.root),
      "origin/hyprws",
      fixtureRepo.conflictTargetSha,
    );
    const boundary = report.feasibility.ffBoundary;
    assert.strictEqual(boundary.upstreamCommitCount, 2);
    assert.strictEqual(boundary.cleanCommitCount, 1);
    assert.strictEqual(boundary.firstConflict?.sha, fixtureRepo.conflictTargetSha);
    assert.deepStrictEqual(boundary.firstConflict?.tags, ["v1.0.0"]);
    assert.deepStrictEqual(
      boundary.changes.map((change) => change.filesAdded),
      [["shared.txt"]],
    );

    assert.strictEqual(report.feasibility.conflicts.length, 1);
    const conflict = report.feasibility.conflicts[0];
    assert.strictEqual(conflict?.path, "shared.txt");
    assert.strictEqual(conflict?.hunkCount, 2);
    assert.deepStrictEqual(conflict?.introducingForkCommit, {
      sha: fixtureRepo.introducingSha,
      shortSha: fixtureRepo.introducingSha.slice(0, 7),
      subject: "feat(test): introduce fork changes",
      domain: "fixture-domain",
      tier: "qol",
    });
    assert.deepStrictEqual(report.feasibility.overlap, {
      upstreamChanged: 4,
      forkChanged: 4,
      overlap: 4,
      hardConflict: 1,
      automerged: ["adjacent.txt", "auto.txt", "upstream.txt"],
    });
    const overlap = report.retireCandidates.find(
      (candidate) => candidate.commit === fixtureRepo.introducingSha,
    );
    assert.include(overlap?.signals[0]?.evidence ?? "", "hard: shared.txt (2 hunks)");
    assert.include(overlap?.signals[0]?.evidence ?? "", "weak hunk overlap: adjacent.txt@10~12");
    assert.notInclude(overlap?.signals[0]?.evidence ?? "", "auto.txt");
    assert.include(renderMarkdown(report), "Feasibility: clean through 1/2 upstream commits");
  } finally {
    NodeFS.rmSync(fixtureRepo.root, { recursive: true, force: true });
  }
});

it("renders a recorded keep as kept instead of a fresh candidate", () => {
  const fixtureRepo = makeGitFixture();
  try {
    const ledger = parseForkRetirementLedger(
      "## Retired\n\n| Fork commit | Domain | Upstream replacement | Retired at |\n| --- | --- | --- | --- |\n\n## Kept\n\n| Fork commit | Domain | Reason | Reviewed at |\n| --- | --- | --- | --- |\n| feat(test): introduce fork changes | fixture-domain | upstream changed another hunk | v1.0.0 |\n",
    );
    const report = buildReport(
      new SystemGit(fixtureRepo.root),
      "origin/hyprws",
      fixtureRepo.cleanTargetSha,
      ledger,
    );
    const kept = report.retireCandidates.find(
      (candidate) => candidate.commit === fixtureRepo.introducingSha,
    );
    assert.strictEqual(kept?.decision, "keep");
    assert.strictEqual(kept?.reason, "upstream changed another hunk");
    assert.include(renderMarkdown(report), "| kept — upstream changed another hunk |");
  } finally {
    NodeFS.rmSync(fixtureRepo.root, { recursive: true, force: true });
  }
});

it("parses merge-tree tree, stage and message records", () => {
  const tree = "a".repeat(40);
  const blob = "b".repeat(40);
  assert.deepStrictEqual(
    parseMergeTreeResult("left", "right", {
      status: 1,
      stderr: "",
      stdout: `${tree}\n100644 ${blob} 1\tpath with spaces.txt\n100644 ${blob} 2\tpath with spaces.txt\n\nAuto-merging path with spaces.txt\nCONFLICT (content): Merge conflict in path with spaces.txt\n`,
    }),
    { tree, conflicts: ["path with spaces.txt"] },
  );
});

it("treats merge-tree exit codes above one as command errors", () => {
  assert.throws(
    () =>
      runMergeTree(
        {
          runResult: () => ({ status: 2, stdout: "", stderr: "unknown option" }),
        },
        "left",
        "right",
      ),
    MergeTreeError,
  );
});

it("checks schema v3 output for default and explicit targets and detects a moved ref", () => {
  const fixtureRepo = makeGitFixture();
  try {
    const args = ["--json-out", "report.json", "--markdown-out", "report.md"];
    const targetArgs = [...args, "--target", fixtureRepo.cleanTargetSha];
    assert.strictEqual(run(targetArgs, fixtureRepo.root), 0);
    assert.strictEqual(run([...targetArgs, "--check"], fixtureRepo.root), 0);

    assert.strictEqual(run(args, fixtureRepo.root), 0);
    assert.strictEqual(
      JSON.parse(NodeFS.readFileSync(NodePath.join(fixtureRepo.root, "report.json"), "utf8"))
        .schemaVersion,
      3,
    );
    assert.strictEqual(run([...args, "--check"], fixtureRepo.root), 0);

    git(fixtureRepo.root, ["switch", "upstream-lane"]);
    NodeFS.writeFileSync(NodePath.join(fixtureRepo.root, "later.txt"), "later\n");
    git(fixtureRepo.root, ["add", "later.txt"]);
    git(fixtureRepo.root, ["commit", "-m", "docs: later upstream change"]);
    git(fixtureRepo.root, ["update-ref", "refs/remotes/upstream/main", "HEAD"]);
    assert.strictEqual(run([...args, "--check"], fixtureRepo.root), 1);
  } finally {
    NodeFS.rmSync(fixtureRepo.root, { recursive: true, force: true });
  }
});
