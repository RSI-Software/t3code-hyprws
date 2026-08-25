import { assert, it } from "@effect/vitest";

import {
  canonicalRepository,
  classifyChangeType,
  encodeReportJson,
  parseArgs,
  parseCommitLog,
  renderMarkdown,
  renderStateGraph,
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
  schemaVersion: 1,
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
  assert.strictEqual(JSON.parse(first).schemaVersion, 1);
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
