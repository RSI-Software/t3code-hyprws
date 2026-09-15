// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Temporary report fixtures use Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  agentProvenance,
  announceStableCandidates,
  autoGateFour,
  baseReleaseTag,
  autoResolveConflicts,
  collectRetireEvidence,
  completeGeneratedConflictRegeneration,
  conflictResolutionIsReady,
  conflictStopDirtAllowance,
  decisionSurface,
  execute,
  filledDecisionCells,
  filterRetiredMessagesForTest,
  forkCommitIdentifiers,
  gateVerificationEnv,
  identifyRerereResolvedPaths,
  laneExecutablePath,
  lockDriftClass,
  nightlyProposalDigest,
  nextScheduledFire,
  NIGHTLY_REVIEW_EVIDENCE,
  NIGHTLY_WITHHOLD_RULES,
  NO_GROUNDING_CLAIM,
  offeredTagLines,
  orientationDecisionRows,
  orientationTouchedPaths,
  parseConflictRows,
  parseSilentSeam,
  preserveRecordDecisions,
  repairDomain,
  resumeRererePublication,
  regenerateGeneratedConflicts,
  rehearsalConflictRows,
  toolingDeltaCheck,
  rehearsalConflictStop,
  rehearsalRebaseArgs,
  assertRetiredInLedgerForTest,
  retiredSubjectsForTest,
  renderRecord,
  verifyReplay,
  resolveAutoTarget,
  resolveUnblockTarget,
  run,
  SystemRunner,
  validateAutoLane,
  validateNightlyReview,
  validateReport,
  validateSignedRecord,
  walkSummary,
  walkRebaseArgs,
  type CommandResult,
  type CommandRunner,
  type RetireEvidence,
  type SyncReport,
} from "./fork-sync.ts";
import { inspectRecord } from "./fork-sync-gate.ts";
import { waitForCiVerdict } from "./fork-sync-ci.ts";
import { run as carryRun } from "./fork-carry.ts";
import { commitNumstatArguments } from "./lib/fork-numstat.ts";
import { leasedPushWithFoldRetry, type FoldVerbContext } from "./fork-sync-fold-verb.ts";
import { forkLogArguments } from "./lib/fork-trailers.ts";
import { renderMarkdown } from "./fork-churn.ts";
import { censusChurn, hotSeams } from "./fork-churn-ledger.ts";
import { seamKey } from "./lib/fork-conflict-outcomes.ts";
import {
  appendDecision,
  decisionLine,
  parseDecisionRecords,
  requireWalkDecisions,
  walkDecisionIdentity,
  type WalkDecision,
} from "./lib/fork-decisions.ts";
import { type RebaseGitHubClient } from "./fork-rebase-notify.ts";
import { type StableCandidate } from "./lib/fork-rebase-issues.ts";
import { findUpstreamReferences } from "./fork-upstream-refs.ts";
import {
  CHURN_LEDGER_FILE,
  CHURN_REF,
  RERERE_REF,
  readBotRefFile,
  saveRerereCache,
  writeBotRefFile,
} from "./lib/fork-bot-refs.ts";
import {
  parseLedger,
  parseRepairCommits,
  parseSilentSeams,
  readChurnState,
} from "./fork-churn-ledger.ts";
import { summarizeOutcomes } from "./lib/fork-sync-outcomes.ts";
import {
  foldMessagesDigest,
  parseFoldRecordHeader,
  parseFoldSection,
  parseRecord,
  restoreFoldSegments,
  SYNC_HELP,
  REPOSITORY,
  uniqueSilentSeams,
} from "./fork-sync-state.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

it("resumes failed cache publication from an applied report without reapplying trunk", () => {
  const root = fixtureRoot();
  const remote = NodePath.join(root, "remote.git");
  NodeChildProcess.execFileSync("git", ["init", "--quiet", "--bare", remote], { cwd: root });
  NodeChildProcess.execFileSync("git", ["remote", "add", "origin", remote], { cwd: root });
  NodeChildProcess.execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  const cache = NodePath.join(root, ".git", "rr-cache", "key");
  NodeFS.mkdirSync(cache, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cache, "postimage"), "reviewed resolution\n");
  const snapshot = saveRerereCache(root, "rerere: reviewed snapshot")!;
  const applied = report(root, {
    stage: "applied",
    lane: { branch: "rehearse/test", worktree: root },
    installedHead: B,
    recordCommentUrl: "https://example.test/reviewed-record",
    rererePublication: { state: "pending", snapshot },
  });
  try {
    assert.throws(
      () =>
        resumeRererePublication(applied, () => {
          throw new Error("cache unavailable");
        }),
      /trunk already applied/,
    );
    const pending = validateReport(JSON.parse(NodeFS.readFileSync(applied.reportPath, "utf8")));
    assert.strictEqual(pending.stage, "applied");
    assert.strictEqual(pending.rererePublication?.snapshot, snapshot);
    assert.strictEqual(pending.recordCommentUrl, applied.recordCommentUrl);
    // Recovery uses its bound snapshot even after a later walk changes the cache.
    NodeFS.writeFileSync(NodePath.join(cache, "postimage"), "later unreviewed resolution\n");
    const runner = new FakeRunner();
    const completed = execute(
      ["unblock-apply", "--report", applied.reportPath, "--record", applied.recordPath],
      root,
      runner,
    );
    assert.strictEqual(completed.rererePublication?.state, "published");
    assert.strictEqual(
      readBotRefFile(remote, RERERE_REF, "key/postimage"),
      "reviewed resolution\n",
    );
    execute(
      ["unblock-apply", "--report", applied.reportPath, "--record", applied.recordPath],
      root,
      runner,
    );
    assert.deepStrictEqual(runner.calls, []);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(applied.reportPath), { recursive: true, force: true });
  }
});

const fixtureRoot = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-test-"));
  NodeChildProcess.execFileSync("git", ["init", "-b", "fixture"], { cwd: root });
  const workflowDirectory = NodePath.join(root, ".github", "workflows");
  NodeFS.mkdirSync(workflowDirectory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(workflowDirectory, "hyprws-upstream-sync.yml"),
    'on:\n  schedule:\n    - cron: "23 */4 * * *"\n',
  );
  return root;
};

/**
 * The apply publishes the walk's row and outcome record in its own invocation
 * (RSI-Software/t3code-hyprws#664), so an apply fixture needs a real origin, a seeded ledger ref,
 * and a `gh` that answers the record lookup with the record file the apply just posted.
 * `reachable: false` gives the fixture an origin no lease can read, which is the only way to fail
 * the ledger write after the trunk has already moved.
 */
const ledgerFixture = (
  root: string,
  recordPath: string,
  { reachable = true }: { reachable?: boolean } = {},
): { remote: string; restore: () => void } => {
  const remote = NodePath.join(root, "ledger-remote.git");
  NodeChildProcess.execFileSync("git", ["init", "--quiet", "--bare", remote]);
  NodeChildProcess.execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  NodeChildProcess.execFileSync(
    "git",
    ["remote", "add", "origin", reachable ? remote : NodePath.join(root, "absent.git")],
    { cwd: root },
  );
  writeBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE, "[]\n", "churn: fixture");
  if (reachable)
    NodeChildProcess.execFileSync("git", ["push", "--quiet", remote, `${CHURN_REF}:${CHURN_REF}`], {
      cwd: root,
    });
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      'const record = require("node:fs").readFileSync(process.env.FAKE_RECORD_PATH, "utf8");',
      "process.stdout.write(",
      "  JSON.stringify({",
      "    body: process.env.FAKE_ISSUE_BODY,",
      '    url: "https://example.test/issue",',
      '    comments: [{ body: record, url: "https://example.test/record" }],',
      "  }),",
      ");",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const previousRecord = process.env.FAKE_RECORD_PATH;
  const previousBody = process.env.FAKE_ISSUE_BODY;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_RECORD_PATH = recordPath;
  process.env.FAKE_ISSUE_BODY = [
    "## Sequential rebase census",
    "",
    "| File | Hunks | Fork commit | Domain |",
    "| --- | ---: | --- | --- |",
    "| `scripts/fork-sync.ts` | 1 | `1234567 feat(fork): walk identity` | fork-meta |",
  ].join("\n");
  return {
    remote,
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousRecord === undefined) delete process.env.FAKE_RECORD_PATH;
      else process.env.FAKE_RECORD_PATH = previousRecord;
      if (previousBody === undefined) delete process.env.FAKE_ISSUE_BODY;
      else process.env.FAKE_ISSUE_BODY = previousBody;
    },
  };
};

const report = (root: string, overrides: Partial<SyncReport> = {}): SyncReport => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-report-"));
  return {
    schemaVersion: 1,
    stage: "listed",
    repositoryRoot: root,
    reportPath: NodePath.join(directory, "report.json"),
    recordPath: NodePath.join(directory, "record.md"),
    issue: { number: 352, blockingSha: A, title: "blocked" },
    candidates: [{ tag: "v1.2.3", sha: B }],
    bot: { mode: "candidate", lastRun: null, nextFire: "2026-09-02T08:23:00.000Z" },
    conflicts: [],
    verification: [],
    ...overrides,
  };
};

class FakeRunner implements CommandRunner {
  readonly calls: Array<{
    command: string;
    args: ReadonlyArray<string>;
    cwd: string;
    env?: NodeJS.ProcessEnv;
  }> = [];
  readonly responses = new Map<string, CommandResult>();
  readonly sequences = new Map<string, Array<CommandResult>>();
  fallback: CommandResult = { status: 0, stdout: "", stderr: "" };

  key(command: string, args: ReadonlyArray<string>): string {
    return `${command} ${args.join(" ")}`;
  }
  set(command: string, args: ReadonlyArray<string>, result: Partial<CommandResult>): void {
    this.responses.set(this.key(command, args), { status: 0, stdout: "", stderr: "", ...result });
  }
  setSequence(
    command: string,
    args: ReadonlyArray<string>,
    results: ReadonlyArray<Partial<CommandResult>>,
  ): void {
    this.sequences.set(
      this.key(command, args),
      results.map((result) => ({ status: 0, stdout: "", stderr: "", ...result })),
    );
  }
  run(
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    _input?: string,
    env?: NodeJS.ProcessEnv,
  ): CommandResult {
    this.calls.push({ command, args, cwd, ...(env === undefined ? {} : { env }) });
    const key = this.key(command, args);
    const sequence = this.sequences.get(key);
    if (sequence !== undefined && sequence.length > 0) return sequence.shift() ?? this.fallback;
    return this.responses.get(key) ?? this.fallback;
  }
}

const issueJson = JSON.stringify([
  { number: 352, title: "blocked", body: `body\n<!-- blocking-sha:${A} -->` },
]);
const orientCandidates = [{ tag: "v1.2.3", sha: B }];

it("orders automatic target rules as explicit, tracker, then newest offered", () => {
  const candidates = [
    { tag: "v1.2.5", sha: A },
    { tag: "v1.2.4", sha: B },
    { tag: "v1.2.3", sha: C },
  ];
  const tracker = [
    {
      title: "unblock walk lands v1.2.4 [📡#397]",
      createdAt: "2026-09-02T10:00:00Z",
    },
  ];
  assert.deepStrictEqual(resolveAutoTarget(candidates, "v1.2.5", tracker), {
    target: candidates[0],
    rule: "explicit --target",
  });
  assert.deepStrictEqual(resolveAutoTarget(candidates, null, tracker), {
    target: candidates[1],
    rule: "open tracker sub-issue",
  });
  assert.deepStrictEqual(resolveAutoTarget(candidates, null, []), {
    target: candidates[0],
    rule: "newest offered tag containing the block",
  });
});

it("prints the newest offered tag alone and every tag under --all", () => {
  const candidates = [
    { tag: "v1.2.5", sha: A },
    { tag: "v1.2.4", sha: B },
    { tag: "v1.2.3", sha: C },
  ];
  assert.deepStrictEqual(offeredTagLines(candidates, false), [
    `  v1.2.5@${A}`,
    "  (2 older offered tags hidden; rerun with --all)",
  ]);
  assert.deepStrictEqual(offeredTagLines(candidates, true), [
    `  v1.2.5@${A}`,
    `  v1.2.4@${B}`,
    `  v1.2.3@${C}`,
  ]);
  assert.deepStrictEqual(offeredTagLines([candidates[0]!], false), [`  v1.2.5@${A}`]);
});

it("accepts a bare unblock target tag", () => {
  assert.deepStrictEqual(resolveUnblockTarget(orientCandidates, "v1.2.3"), orientCandidates[0]);
});

it("accepts an unblock target tag with its full sha", () => {
  assert.deepStrictEqual(
    resolveUnblockTarget(orientCandidates, `v1.2.3@${B}`),
    orientCandidates[0],
  );
});

it("accepts an unblock target tag with a unique sha prefix", () => {
  assert.deepStrictEqual(
    resolveUnblockTarget(orientCandidates, "v1.2.3@bbbbbbb"),
    orientCandidates[0],
  );
});

it("refuses an unblock target tag with a mismatched sha", () => {
  assert.throws(
    () => resolveUnblockTarget(orientCandidates, "v1.2.3@ccccccc"),
    new RegExp(`^target v1\\.2\\.3 was offered at ${B}, not ccccccc$`),
  );
});

it("lists accepted unblock target forms when a tag was not offered", () => {
  assert.throws(
    () => resolveUnblockTarget(orientCandidates, "v9.9.9"),
    new RegExp(
      `^target v9\\.9\\.9 was not offered by unblock-list; accepted forms: v1\\.2\\.3, v1\\.2\\.3@${B}$`,
    ),
  );
});
const modeArgs = [
  "variable",
  "get",
  "HYPRWS_AUTO_REBASE",
  "--repo",
  "RSI-Software/t3code-hyprws",
] as const;
const runListArgs = [
  "run",
  "list",
  "--workflow",
  "hyprws-upstream-sync.yml",
  "-L",
  "1",
  "--json",
  "status,conclusion,createdAt,url",
  "--repo",
  "RSI-Software/t3code-hyprws",
] as const;
const lastRun = {
  status: "completed",
  conclusion: "success",
  createdAt: "2026-09-02T04:18:00Z",
  url: "https://example.test/runs/1",
};

const setBotResponses = (runner: FakeRunner, mode: "off" | "candidate" | "on"): void => {
  runner.set("gh", modeArgs, { stdout: `${mode}\n` });
  runner.set("gh", runListArgs, { stdout: JSON.stringify([lastRun]) });
};

const coherentOrientation = `mirror:       origin/main matches upstream/main at ${A.slice(0, 12)}\n`;

const setOrientationResponses = (
  runner: FakeRunner,
  source = C,
  target = B,
  sharedBase = A,
): void => {
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${source}\n` });
  runner.set("git", ["rev-parse", "refs/tags/v1.2.3^{commit}"], { stdout: `${target}\n` });
  runner.set("git", ["merge-base", source, target], { stdout: `${sharedBase}\n` });
};

const setListResponses = (runner: FakeRunner, root: string): void => {
  runner.set("git", ["rev-parse", "--show-toplevel"], { stdout: `${root}\n` });
  runner.set(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "rebase-blocked",
      "-R",
      "RSI-Software/t3code-hyprws",
      "--json",
      "number,title,body",
    ],
    { stdout: issueJson },
  );
  runner.set("git", ["rev-list", "--first-parent", "--reverse", "upstream/main"], {
    stdout: `${A}\n${B}\n`,
  });
  runner.set(
    "git",
    [
      "for-each-ref",
      "--format=%(refname:strip=2)%09%(objectname)%09%(*objectname)",
      "refs/tags/v*",
    ],
    { stdout: `v1.2.3\t${B}\t\n` },
  );
};

const captureStdout = <T>(effect: () => T): { readonly output: string; readonly result: T } => {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = effect();
    return { output, result };
  } finally {
    process.stdout.write = original;
  }
};

it("writes a listed report without accepting or inferring a target", () => {
  const root = fixtureRoot();
  const output = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-out-")),
    "report.json",
  );
  const runner = new FakeRunner();
  runner.set("git", ["rev-parse", "--show-toplevel"], { stdout: `${root}\n` });
  runner.set(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "rebase-blocked",
      "-R",
      "RSI-Software/t3code-hyprws",
      "--json",
      "number,title,body",
    ],
    { stdout: issueJson },
  );
  runner.set("git", ["rev-list", "--first-parent", "--reverse", "upstream/main"], {
    stdout: `${A}\n${B}\n`,
  });
  runner.set(
    "git",
    [
      "for-each-ref",
      "--format=%(refname:strip=2)%09%(objectname)%09%(*objectname)",
      "refs/tags/v*",
    ],
    { stdout: `v1.2.3\t${B}\t\nv1.2.4-nightly.20260831.2\t${C}\t\n` },
  );
  setBotResponses(runner, "candidate");

  try {
    const listed = execute(["unblock-list", "--output", output], root, runner);
    assert.strictEqual(listed.stage, "listed");
    assert.deepStrictEqual(listed.candidates, [{ tag: "v1.2.3", sha: B }]);
    assert.isUndefined(listed.target);
    assert.strictEqual(
      validateReport(JSON.parse(NodeFS.readFileSync(output, "utf8"))).stage,
      "listed",
    );
    assert.throws(
      () => execute(["unblock-list", "--target", "v1.2.3"], root, runner),
      /unknown option/,
    );
    // This walk chooses its own target, so it requires a current mirror.
    assert.deepStrictEqual(runner.calls.find(({ command }) => command === "node")?.args, [
      "scripts/fork-preflight.ts",
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(output), { recursive: true, force: true });
  }
});

it("prints the bot block after candidates for every mode", () => {
  for (const mode of ["off", "candidate", "on"] as const) {
    const root = fixtureRoot();
    const outputPath = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-out-")),
      "report.json",
    );
    const runner = new FakeRunner();
    setListResponses(runner, root);
    setBotResponses(runner, mode);
    if (mode === "candidate")
      runner.set("gh", runListArgs, {
        stdout: JSON.stringify([{ ...lastRun, status: "in_progress", conclusion: null }]),
      });
    try {
      const { output, result } = captureStdout(() =>
        execute(["unblock-list", "--output", outputPath], root, runner),
      );
      assert.strictEqual(result.bot?.mode, mode);
      assert.include(output, `bot:\n  mode: ${mode}\n`);
      assert.include(
        output,
        mode === "candidate"
          ? "  last run: in_progress 2026-09-02T04:18:00Z https://example.test/runs/1\n"
          : "  last run: completed success 2026-09-02T04:18:00Z https://example.test/runs/1\n",
      );
      if (mode === "candidate") assert.include(output, "  RUNNING\n");
      else assert.notInclude(output, "  RUNNING\n");
      assert.match(output, /  next fire: \d{4}-\d\d-\d\dT(?:00|04|08|12|16|20):23:00\.000Z\n/);
      assert.isBelow(output.indexOf(`  v1.2.3@${B}`), output.indexOf("bot:\n"));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.rmSync(NodePath.dirname(outputPath), { recursive: true, force: true });
    }
  }
});

it("unblock-list prints the lease it takes and the walk freeze", () => {
  const root = fixtureRoot();
  const outputPath = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-out-")),
    "report.json",
  );
  const runner = new FakeRunner();
  setListResponses(runner, root);
  setBotResponses(runner, "candidate");
  // The list lease probe reads the same live head the orient bind takes.
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  try {
    const { output } = captureStdout(() =>
      execute(["unblock-list", "--output", outputPath], root, runner),
    );
    assert.include(output, `Freeze: walk lease taken at \`${C}\` (origin/hyprws)`);
    assert.include(output, "linear landings on hyprws fold at vp run fork:sync unblock-fold");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(outputPath), { recursive: true, force: true });
  }
});

it("unblock-check repeats the lease beside the candidate", () => {
  const state = replayedRun();
  setCiSuccess(state.runner, state.branch);
  try {
    const { output } = captureStdout(() =>
      execute(["unblock-check", "--report", state.reportPath], state.root, state.runner),
    );
    assert.include(
      output,
      `Lease: walk lease \`${C}\` beside the candidate above — linear landings fold at \`vp run fork:sync unblock-fold\``,
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("uses candidate mode when the repository variable is missing", () => {
  const root = fixtureRoot();
  const outputPath = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-out-")),
    "report.json",
  );
  const runner = new FakeRunner();
  setListResponses(runner, root);
  runner.set("gh", modeArgs, { status: 1, stderr: "HTTP 404: variable not found" });
  runner.set("gh", runListArgs, { stdout: "[]" });
  try {
    const { output, result } = captureStdout(() =>
      execute(["unblock-list", "--output", outputPath], root, runner),
    );
    assert.strictEqual(result.bot?.mode, "candidate");
    assert.include(output, "bot:\n  mode: candidate\n  last run: none\n");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(outputPath), { recursive: true, force: true });
  }
});

it("prefers an injected bot mode over the repository variable API", () => {
  const root = fixtureRoot();
  const outputPath = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-out-")),
    "report.json",
  );
  const runner = new FakeRunner();
  setListResponses(runner, root);
  // The API read is left unstubbed, so reaching it would fail the mode validation.
  runner.set("gh", runListArgs, { stdout: "[]" });
  const previous = process.env["HYPRWS_AUTO_REBASE"];
  try {
    process.env["HYPRWS_AUTO_REBASE"] = "on";
    const { result } = captureStdout(() =>
      execute(["unblock-list", "--output", outputPath], root, runner),
    );
    assert.strictEqual(result.bot?.mode, "on");
    assert.isUndefined(
      runner.calls.find(({ command, args }) => command === "gh" && args[0] === "variable"),
    );

    process.env["HYPRWS_AUTO_REBASE"] = "yes";
    assert.throws(
      () => execute(["unblock-list", "--output", outputPath], root, runner),
      /^HYPRWS_AUTO_REBASE has unsupported mode: yes$/,
    );
  } finally {
    if (previous === undefined) delete process.env["HYPRWS_AUTO_REBASE"];
    else process.env["HYPRWS_AUTO_REBASE"] = previous;
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(outputPath), { recursive: true, force: true });
  }
});

it("derives the next fire from the workflow cron", () => {
  assert.strictEqual(
    nextScheduledFire("23 */4 * * *", new Date("2026-09-02T04:24:00.000Z")),
    "2026-09-02T08:23:00.000Z",
  );
});

it("refuses orientation in on mode with the exact pause remedy", () => {
  const root = fixtureRoot();
  const listed = report(root, {
    bot: { mode: "on", lastRun: null, nextFire: "2026-09-02T08:23:00.000Z" },
  });
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  try {
    assert.throws(
      () =>
        execute(
          ["unblock-orient", "--report", listed.reportPath, "--target", "v1.2.3"],
          root,
          new FakeRunner(),
        ),
      new RegExp(
        "gh variable set HYPRWS_AUTO_REBASE --body candidate --repo RSI-Software/t3code-hyprws$",
      ),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("waits out a running bot and then orients", () => {
  const root = fixtureRoot();
  const listed = report(root, {
    bot: {
      mode: "candidate",
      lastRun: { ...lastRun, status: "in_progress", conclusion: null },
      nextFire: "2026-09-02T08:23:00.000Z",
    },
  });
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  const runner = new FakeRunner();
  // No real sleep: one short poll, then the run completes on the repoll.
  runner.set("sleep", ["30"], { stdout: "" });
  runner.setSequence("gh", runListArgs, [
    { stdout: JSON.stringify([{ ...lastRun, status: "in_progress", conclusion: null }]) },
    { stdout: JSON.stringify([lastRun]) },
  ]);
  runner.set("gh", modeArgs, { stdout: "candidate\n" });
  try {
    runner.set(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "rebase-blocked",
        "-R",
        "RSI-Software/t3code-hyprws",
        "--json",
        "number,title,body",
      ],
      { stdout: issueJson },
    );
    runner.set("git", ["rev-parse", "refs/tags/v1.2.3^{commit}"], { stdout: `${B}\n` });
    runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
    runner.set("git", ["merge-base", C, B], { stdout: `${A}\n` });
    runner.set("node", ["scripts/fork-orient.ts", "--target", "v1.2.3"], {
      stdout:
        "## Retire candidates\n  [keep] `feat(web): preserve fork behavior` (workspace-files)\n",
    });
    const { output, result } = captureStdout(() =>
      execute(
        ["unblock-orient", "--report", listed.reportPath, "--target", "v1.2.3"],
        root,
        runner,
      ),
    );
    assert.strictEqual(result.stage, "oriented");
    assert.include(
      output,
      "waiting for the auto-rebase bot run to finish: https://example.test/runs/1",
    );
    assert.include(output, "bot run finished; continuing");
    assert.isTrue(
      runner.calls.some(({ command, args }) => command === "sleep" && args[0] === "30"),
    );
    // The settled snapshot is written back, so the next verb does not wait twice.
    const persisted = validateReport(JSON.parse(NodeFS.readFileSync(listed.reportPath, "utf8")));
    assert.strictEqual(persisted.bot?.lastRun?.status, "completed");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("declares the outcome attempt before orient can fail (#1023)", () => {
  const root = fixtureRoot();
  const listed = report(root, {
    bot: { mode: "candidate", lastRun: null, nextFire: "2026-09-02T08:23:00.000Z" },
  });
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  const runner = new FakeRunner();
  runner.set("gh", runListArgs, { stdout: "[]" });
  runner.set("gh", modeArgs, { stdout: "candidate\n" });
  runner.set(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "rebase-blocked",
      "-R",
      "RSI-Software/t3code-hyprws",
      "--json",
      "number,title,body",
    ],
    { stdout: issueJson },
  );
  runner.set("git", ["rev-parse", "refs/tags/v1.2.3^{commit}"], { stdout: `${B}\n` });
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  runner.set("git", ["merge-base", C, B], { stdout: `${A}\n` });
  // Everything up to and including target/source binding succeeds; orient explodes.
  runner.set("node", ["scripts/fork-orient.ts", "--target", "v1.2.3"], {
    status: 1,
    stderr: "orient exploded",
  });
  try {
    assert.throws(() =>
      execute(
        ["unblock-orient", "--report", listed.reportPath, "--target", "v1.2.3"],
        root,
        runner,
      ),
    );
    // The thrown walk still leaves a well-formed declaration: a target receipt and an attempt
    // receipt, the same shape the receipt guards accept from prepareAutoOutcome.
    const bundle = JSON.parse(NodeFS.readFileSync(`${listed.reportPath}.outcome.json`, "utf8"));
    assert.strictEqual(bundle.version, 1);
    assert.lengthOf(bundle.receipts, 2);
    const [target, attempt] = bundle.receipts;
    assert.strictEqual(target.kind, "target");
    assert.deepStrictEqual(target.target, { tag: "v1.2.3", sha: B });
    assert.strictEqual(target.eligible, true);
    assert.strictEqual(attempt.kind, "attempt");
    assert.strictEqual(attempt.targetSha, B);
    assert.strictEqual(attempt.sourceSha, C);
    assert.strictEqual(attempt.mode, "candidate");
    // The executor is genuinely environment-dependent (run coordinate in Actions, `local/`
    // elsewhere); only its presence is behaviour.
    assert.strictEqual(typeof attempt.executor, "string");
    assert.notEqual(attempt.executor, "");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("fails loudly when the bot run outlasts the ceiling", () => {
  const root = fixtureRoot();
  const listed = report(root, {
    bot: {
      mode: "candidate",
      lastRun: { ...lastRun, status: "queued", conclusion: null },
      nextFire: "2026-09-02T08:23:00.000Z",
    },
  });
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  const runner = new FakeRunner();
  // The run never completes: every repoll still reports it queued, and each
  // poll's sleep is faked. The ceiling breaks the loop instead of hanging.
  runner.set("sleep", ["30"], { stdout: "" });
  runner.set("gh", runListArgs, {
    stdout: JSON.stringify([{ ...lastRun, status: "queued", conclusion: null }]),
  });
  runner.set("gh", modeArgs, { stdout: "candidate\n" });
  try {
    assert.throws(
      () =>
        execute(
          ["unblock-orient", "--report", listed.reportPath, "--target", "v1.2.3"],
          root,
          runner,
        ),
      /bot run is in progress after 45 minutes: https:\/\/example\.test\/runs\/1; rerun when it finishes/,
    );
    assert.lengthOf(
      runner.calls.filter(({ command, args }) => command === "sleep" && args[0] === "30"),
      90,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("orients only to a tag carried by the previous report", () => {
  const root = fixtureRoot();
  const listed = report(root);
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  const runner = new FakeRunner();
  try {
    runner.set(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "rebase-blocked",
        "-R",
        "RSI-Software/t3code-hyprws",
        "--json",
        "number,title,body",
      ],
      { stdout: issueJson },
    );
    runner.set("git", ["rev-parse", "refs/tags/v1.2.3^{commit}"], { stdout: `${B}\n` });
    runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
    runner.set("git", ["merge-base", C, B], { stdout: `${A}\n` });
    runner.set("node", ["scripts/fork-orient.ts", "--target", "v1.2.3"], {
      stdout:
        "## Retire candidates\n  [keep] `feat(web): preserve fork behavior` (workspace-files)\n",
    });
    const oriented = execute(
      ["unblock-orient", "--report", listed.reportPath, "--target", "v1.2.3"],
      root,
      runner,
    );
    assert.strictEqual(oriented.stage, "oriented");
    assert.deepStrictEqual(oriented.source, { sha: C, expectedOld: C, sharedBase: A });
    assert.deepStrictEqual(oriented.conflicts, []);
    assert.deepStrictEqual(oriented.orientationDecisions, [
      {
        verdict: "keep",
        subject: "feat(web): preserve fork behavior",
        domain: "workspace-files",
        decidedBy: "TODO",
      },
    ]);
    // The target is a tag from here on, so an upstream tip that moved mid-walk
    // is reported by the preflight rather than blocking the verb.
    assert.deepStrictEqual(
      runner.calls.find(({ command, args }) => command === "node" && args.length === 2)?.args,
      ["scripts/fork-preflight.ts", "--tag-pinned"],
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("carries orientation overlap and every retirement verdict into structured state", () => {
  const orientation = [
    "## Automerged overlap",
    "Automerged files:",
    "  - apps/web/src/a.ts",
    "  - package.json",
    "",
    "## Retire candidates",
    "  [candidate] `fix(web): review upstream overlap` (project-windows)",
    "  [keep] `feat(web): keep fork behavior` (workspace-files)",
    "  [retire] `fix(server): use upstream behavior` (fork-meta)",
    "  [partial] `feat(desktop): retain one seam` (custom-agents)",
    "",
  ].join("\n");
  assert.deepStrictEqual(orientationTouchedPaths(orientation), [
    "apps/web/src/a.ts",
    "package.json",
  ]);
  assert.deepStrictEqual(orientationDecisionRows(orientation), [
    {
      verdict: "candidate",
      subject: "fix(web): review upstream overlap",
      domain: "project-windows",
      decidedBy: "TODO",
    },
    {
      verdict: "keep",
      subject: "feat(web): keep fork behavior",
      domain: "workspace-files",
      decidedBy: "TODO",
    },
    {
      verdict: "retire",
      subject: "fix(server): use upstream behavior",
      domain: "fork-meta",
      decidedBy: "TODO",
    },
    {
      verdict: "partial",
      subject: "feat(desktop): retain one seam",
      domain: "custom-agents",
      decidedBy: "TODO",
    },
  ]);
});

it("refuses a rehearsal lane collision for the exact target and source", () => {
  const root = fixtureRoot();
  const oriented = report(root, {
    stage: "oriented",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
  });
  NodeFS.writeFileSync(oriented.reportPath, JSON.stringify(oriented));
  const runner = new FakeRunner();
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  runner.set(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/rehearse/v1.2.3-from-${C.slice(0, 12)}`],
    { status: 0 },
  );
  try {
    assert.throws(
      () => execute(["unblock-rehearse", "--report", oriented.reportPath], root, runner),
      /lane already exists/,
    );
    assert.isFalse(runner.calls.some(({ command }) => command === "wt"));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(oriented.reportPath), { recursive: true, force: true });
  }
});

it("installs a minted lane before it replays into it", () => {
  const root = fixtureRoot();
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-lane-"));
  const oriented = report(root, {
    stage: "oriented",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
  });
  NodeFS.writeFileSync(oriented.reportPath, JSON.stringify(oriented));
  const runner = new FakeRunner();
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  runner.set(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/rehearse/v1.2.3-from-${C.slice(0, 12)}`],
    { status: 1 },
  );
  runner.set(
    "wt",
    [
      "switch",
      "--create",
      `rehearse/v1.2.3-from-${C.slice(0, 12)}`,
      "--base",
      C,
      "--no-cd",
      "--format",
      "json",
      "--yes",
    ],
    { stdout: JSON.stringify({ worktree_path: worktree }) },
  );
  try {
    execute(["unblock-rehearse", "--report", oriented.reportPath], root, runner);
    const install = runner.calls.findIndex(
      ({ command, args }) => command === "vp" && args.join(" ") === "i",
    );
    const rebase = runner.calls.findIndex(
      ({ command, args }) => command === "git" && args.includes("rebase"),
    );
    assert.isAbove(install, -1);
    assert.isAbove(rebase, install);
    const call = runner.calls[install];
    assert.strictEqual(call?.cwd, worktree);
    assert.strictEqual(
      (call?.env?.PATH ?? "").split(NodePath.delimiter)[0],
      NodePath.join(worktree, "node_modules", ".bin"),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(oriented.reportPath), { recursive: true, force: true });
  }
});

it("names the in-flight commit and every conflicted path in the rehearsal stop", () => {
  assert.strictEqual(
    rehearsalConflictStop(
      "/tmp/report.json",
      "/tmp/record.md",
      { sha: C, subject: "fix(web): preserve scoped behavior" },
      ["apps/web/src/a.ts", "packages/shared/src/b.ts"],
    ),
    [
      "/tmp/report.json",
      `Stop. Rebase conflict in fix(web): preserve scoped behavior (${C.slice(0, 12)}).`,
      "Conflicted paths:",
      "  - apps/web/src/a.ts",
      "  - packages/shared/src/b.ts",
      "Resolve and stage non-generated files, complete every TODO row in /tmp/record.md, then rerun unblock-rehearse.",
      "",
    ].join("\n"),
  );
});

it("records successful generated conflict regeneration as an agent decision", () => {
  assert.deepInclude(
    completeGeneratedConflictRegeneration({
      commit: C,
      subject: "feat(web): generated lock drift",
      domain: "fork-meta",
      path: "pnpm-lock.yaml",
      class: "generated",
      resolution: "restore HEAD and regenerate",
      agentSafe: "pending regeneration",
      decidedBy: "TODO",
    }),
    {
      class: "generated",
      resolution: "restore HEAD and regenerate",
      agentSafe: "yes — regenerated by unblock-rehearse",
      decidedBy: "agent",
    },
  );
});

it("classifies a conflicted routeTree.gen.ts as generated and regenerates it instead of resolving by hand", () => {
  const root = fixtureRoot();
  const routeTree = NodePath.join(root, "apps", "web", "src", "routeTree.gen.ts");
  NodeFS.mkdirSync(NodePath.dirname(routeTree), { recursive: true });
  NodeFS.writeFileSync(routeTree, "export const routeTree = 1;\n");
  const git = (args: ReadonlyArray<string>): void => {
    NodeChildProcess.execFileSync("git", args, { cwd: root });
  };
  git(["config", "user.name", "test"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["add", "apps/web/src/routeTree.gen.ts"]);
  git(["commit", "--quiet", "-m", "base"]);
  git(["checkout", "--quiet", "-b", "other"]);
  NodeFS.writeFileSync(routeTree, "export const routeTree = 2;\n");
  git(["commit", "--quiet", "-am", "other"]);
  git(["checkout", "--quiet", "-"]);
  NodeFS.writeFileSync(routeTree, "export const routeTree = 3;\n");
  git(["commit", "--quiet", "-am", "ours"]);
  try {
    try {
      git(["merge", "--no-edit", "other"]);
    } catch {
      // conflicting edits: the merge stops with the generated path unmerged
    }
    const unmerged = NodeChildProcess.execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    assert.deepStrictEqual(unmerged, ["apps/web/src/routeTree.gen.ts"]);
    assert.deepStrictEqual(
      rehearsalConflictRows({ sha: C, subject: "conflict", domain: "fork-meta" }, unmerged, []).map(
        ({ path, class: klass, resolution }) => ({ path, class: klass, resolution }),
      ),
      [
        {
          path: "apps/web/src/routeTree.gen.ts",
          class: "generated",
          resolution: "restore HEAD and regenerate",
        },
      ],
    );
    const runner = new FakeRunner();
    regenerateGeneratedConflicts(runner, root, unmerged);
    assert.deepStrictEqual(
      runner.calls.map(({ command, args }) => [command, ...args]),
      [
        [
          "git",
          "-c",
          "core.commentChar=auto",
          "restore",
          "--source=HEAD",
          "--staged",
          "--worktree",
          "--",
          "apps/web/src/routeTree.gen.ts",
        ],
        ["vp", "run", "fork:regenerate-route-tree"],
        ["git", "-c", "core.commentChar=auto", "add", "apps/web/src/routeTree.gen.ts"],
      ],
    );
    // the same git moves the handoff models clear the conflict for real
    NodeChildProcess.execFileSync(
      "git",
      ["checkout", "HEAD", "--", "apps/web/src/routeTree.gen.ts"],
      { cwd: root },
    );
    NodeChildProcess.execFileSync("git", ["add", "apps/web/src/routeTree.gen.ts"], { cwd: root });
    assert.strictEqual(
      NodeChildProcess.execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      "",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("asks for nothing when the only conflict is the regenerated lockfile", () => {
  const stop = rehearsalConflictStop(
    "/tmp/report.json",
    "/tmp/record.md",
    { sha: C, subject: "chore(deps): bump upstream" },
    ["pnpm-lock.yaml"],
  );
  assert.strictEqual(
    stop,
    [
      "/tmp/report.json",
      `Stop. Rebase conflict in chore(deps): bump upstream (${C.slice(0, 12)}).`,
      "Conflicted paths:",
      "  - pnpm-lock.yaml (generated)",
      "Nothing to resolve or record. Rerun unblock-rehearse; it restores HEAD, regenerates the lockfile, and continues.",
      "",
    ].join("\n"),
  );
  assert.notInclude(stop, "TODO row");
  assert.notInclude(stop, "Resolve and stage");
  assert.strictEqual(
    rehearsalConflictStop(
      "/tmp/report.json",
      "/tmp/record.md",
      { sha: C, subject: "chore(deps): bump upstream" },
      ["pnpm-lock.yaml"],
      ["pnpm-lock.yaml"],
    ),
    [
      "/tmp/report.json",
      `Stop. Rebase conflict in chore(deps): bump upstream (${C.slice(0, 12)}).`,
      "Conflicted paths:",
      "  - pnpm-lock.yaml (generated; rerere's recorded resolution is discarded)",
      "Nothing to resolve or record. Rerun unblock-rehearse; it restores HEAD, regenerates the lockfile, and continues.",
      "",
    ].join("\n"),
  );
});

it("keeps the resolve-and-record stop when a generated path conflicts alongside a source file", () => {
  const stop = rehearsalConflictStop(
    "/tmp/report.json",
    "/tmp/record.md",
    { sha: C, subject: "fix(web): preserve scoped behavior" },
    ["pnpm-lock.yaml", "apps/web/src/a.ts"],
  );
  assert.include(
    stop,
    "Resolve and stage non-generated files, complete every TODO row in /tmp/record.md, then rerun unblock-rehearse.",
  );
  assert.include(stop, "  - pnpm-lock.yaml\n");
});

it("accepts an intentionally no-diff conflict resolution once the path is clean", () => {
  const path = "apps/desktop/src/preload.ts";

  assert.isTrue(conflictResolutionIsReady(path, new Set(), new Set(), new Set()));
  assert.isTrue(conflictResolutionIsReady(path, new Set([path]), new Set(), new Set()));
  assert.isFalse(conflictResolutionIsReady(path, new Set(), new Set([path]), new Set([path])));
  assert.isFalse(conflictResolutionIsReady(path, new Set(), new Set(), new Set([path])));
});

it("rejects a staged conflict path that still has unstaged edits", () => {
  const path = "apps/desktop/src/preload.ts";

  assert.isFalse(conflictResolutionIsReady(path, new Set([path]), new Set(), new Set([path])));
});

it("enables rerere without staging its reused resolutions", () => {
  assert.deepStrictEqual(rehearsalRebaseArgs(["rebase", B]), [
    "-c",
    "core.commentChar=auto",
    "-c",
    "diff.algorithm=histogram",
    "-c",
    "rerere.enabled=true",
    "-c",
    "rerere.autoupdate=false",
    "rebase",
    B,
  ]);
  assert.deepStrictEqual(
    identifyRerereResolvedPaths(
      ["apps/web/src/reused.ts", "apps/web/src/unresolved.ts"],
      ["apps/web/src/unresolved.ts"],
    ),
    ["apps/web/src/reused.ts"],
  );
});

it("drops commits that start empty from the trunk walk without touching the shared args", () => {
  // --no-keep-empty is startup-only: it is not valid on `rebase --skip`/`--continue` and is
  // wrong for the interactive autosquash, so it belongs to the walk's startup invocation and
  // must never leak into rehearsalRebaseArgs.
  const walk = walkRebaseArgs(B);
  assert.ok(walk.includes("--no-keep-empty"));
  assert.deepStrictEqual(rehearsalRebaseArgs(["rebase", B]), [
    "-c",
    "core.commentChar=auto",
    "-c",
    "diff.algorithm=histogram",
    "-c",
    "rerere.enabled=true",
    "-c",
    "rerere.autoupdate=false",
    "rebase",
    B,
  ]);
  assert.strictEqual(walk[walk.length - 1], B);
});

it("auto-classifies and stages rerere rows as mechanical agent decisions", () => {
  const root = fixtureRoot();
  const state = report(root, {
    stage: "conflicts",
    lane: { branch: "rehearse/v1.2.3", worktree: root },
    conflicts: [
      {
        commit: C,
        subject: "fix(web): preserve scoped behavior",
        domain: "fork-meta",
        path: "apps/web/src/reused.ts",
        class: "TODO",
        resolution: "review rerere's recorded resolution and stage",
        agentSafe: "TODO",
        decidedBy: "human",
      },
    ],
  });
  const runner = new FakeRunner();
  NodeFS.mkdirSync(NodePath.join(root, "apps", "web", "src"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "apps/web/src/reused.ts"), "resolved\n");
  try {
    const next = autoResolveConflicts(state, runner);
    assert.strictEqual(next.kind, "resolved");
    assert.deepInclude(next.kind === "resolved" ? next.report.conflicts[0] : undefined, {
      class: "mechanical",
      resolution: "rerere replay",
      agentSafe: "true",
      decidedBy: "agent",
    });
    assert.isDefined(
      runner.calls.find(
        ({ command, args }) =>
          command === "git" && args.join(" ").endsWith("add -- apps/web/src/reused.ts"),
      ),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

const conflictState = (root: string, path: string): SyncReport =>
  report(root, {
    stage: "conflicts",
    lane: { branch: "rehearse/v1.2.3", worktree: root },
    conflicts: [
      {
        commit: C,
        subject: "fix(web): preserve scoped behavior",
        domain: "fork-meta",
        path,
        class: "TODO",
        resolution: "review rerere's recorded resolution and stage",
        agentSafe: "TODO",
        decidedBy: "human",
      },
    ],
  });

const RERERE_REMAINING = [
  "-c",
  "core.commentChar=auto",
  "-c",
  "rerere.enabled=true",
  "rerere",
  "remaining",
] as const;

it("hands every row rerere did not replay to the outcome executor", () => {
  const root = fixtureRoot();
  const path = "apps/web/src/reused.ts";
  NodeFS.mkdirSync(NodePath.join(root, "apps", "web", "src"), { recursive: true });
  // Leftover markers, a path rerere still lists, a failing diff --check and a rerere that exits
  // nonzero all mean the same thing now: no reusable resolution, so the executor decides the row.
  NodeFS.writeFileSync(
    NodePath.join(root, path),
    "<<<<<<< ours\nresolved?\n=======\nother\n>>>>>>> theirs\n",
  );
  const state = conflictState(root, path);
  const cases: ReadonlyArray<(runner: FakeRunner) => void> = [
    () => {},
    (runner) => runner.set("git", [...RERERE_REMAINING], { stdout: `${path}\n` }),
    (runner) =>
      runner.set("git", ["-c", "core.commentChar=auto", "diff", "--check", "--", path], {
        status: 1,
        stderr: "whitespace error",
      }),
    (runner) => runner.set("git", [...RERERE_REMAINING], { status: 1, stderr: "rerere failed" }),
  ];
  try {
    for (const arrange of cases) {
      const runner = new FakeRunner();
      arrange(runner);
      // Only the fork moved at this seam, so the fork side stands.
      runner.set("git", ["show", `:1:${path}`], { stdout: "shared\n" });
      runner.set("git", ["show", `:2:${path}`], { stdout: "shared\n" });
      runner.set("git", ["show", `:3:${path}`], { stdout: "shared\nfork\n" });
      const resolved = autoResolveConflicts(state, runner);
      assert.strictEqual(resolved.kind, "resolved");
      assert.deepInclude(resolved.kind === "resolved" ? resolved.report.conflicts[0] : undefined, {
        class: "mechanical",
        resolution: "outcome executor: only the fork moved",
        agentSafe: "true",
        decidedBy: "agent",
      });
      assert.strictEqual(NodeFS.readFileSync(NodePath.join(root, path), "utf8"), "shared\nfork\n");
      NodeFS.writeFileSync(
        NodePath.join(root, path),
        "<<<<<<< ours\nresolved?\n=======\nother\n>>>>>>> theirs\n",
      );
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("stops the walk on the row the outcome executor declines, naming it and why", () => {
  const root = fixtureRoot();
  const path = "apps/web/src/reused.ts";
  NodeFS.mkdirSync(NodePath.join(root, "apps", "web", "src"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), "unresolved\n");
  const state = conflictState(root, path);
  const runner = new FakeRunner();
  runner.set("git", [...RERERE_REMAINING], { stdout: `${path}\n` });
  // No merge base on this path: an add/add or a rename, which stays a maintainer's shape.
  runner.set("git", ["show", `:1:${path}`], { status: 1, stderr: "no such path" });
  try {
    const outcome = autoResolveConflicts(state, runner);
    assert.strictEqual(outcome.kind, "unresolved");
    if (outcome.kind !== "unresolved") return;
    assert.strictEqual(outcome.rows[0]?.path, path);
    assert.include(outcome.rows[0]?.reason ?? "", "no common ancestor");
    assert.isFalse(runner.calls.some(({ args }) => args.includes("add")));
    assert.deepInclude(state.conflicts[0], { class: "TODO", decidedBy: "human" });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("has no resume verb: an in-flight report is picked up, not passed a flag", () => {
  const root = fixtureRoot();
  const state = report(root, { stage: "oriented", target: { tag: "v1.2.3", sha: B } });
  NodeFS.writeFileSync(state.reportPath, JSON.stringify(state));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  const stderr = withCapturedStderr(() => {
    assert.strictEqual(
      run(["unblock-auto", "--resume", "--report", state.reportPath], root, runner),
      2,
    );
  });
  try {
    assert.include(stderr, "invalid arguments after unblock-auto");
    assert.notInclude(SYNC_HELP, "--resume");
    // Nothing was listed: the walk refused the flag before it touched the trunk.
    assert.isFalse(runner.calls.some(({ args }) => args.includes("--show-toplevel")));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("stops on a lane it cannot replay rather than re-listing forever", () => {
  const root = fixtureRoot();
  const state = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: `rehearse/v1.2.3-from-${C.slice(0, 12)}`, worktree: root },
    installedHead: B,
    orientation: coherentOrientation,
  });
  NodeFS.writeFileSync(state.reportPath, JSON.stringify(state));
  NodeFS.writeFileSync(state.recordPath, renderRecord(state));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  setOrientationResponses(runner);
  // The only moved ref is the shared base: the walk leased it at A, and the live
  // merge-base now answers D, so the coherence gate has a real reason to stop.
  const movedBase = "d".repeat(40);
  runner.set("git", ["merge-base", C, B], { stdout: `${movedBase}\n` });
  try {
    let code = 0;
    const { output } = captureStdout(() => {
      const stderr = withCapturedStderr(() => {
        code = run(["unblock-auto", "--report", state.reportPath], root, runner);
      });
      assert.strictEqual(code, 2, stderr);
    });
    assert.include(output, "Stop (environment).");
    assert.include(output, "the trunk did not move");
    assert.notInclude(output, "restart: hyprws moved under the walk");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("re-lists from the moved trunk instead of asking for a restart", () => {
  const root = fixtureRoot();
  const state = report(root, {
    stage: "oriented",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
  });
  NodeFS.writeFileSync(state.reportPath, JSON.stringify(state));
  const runner = new FakeRunner();
  setListResponses(runner, root);
  setBotResponses(runner, "candidate");
  // The trunk moved under the in-flight report, so everything it measured is against a base
  // that is gone.
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${B}\n` });
  try {
    const { output } = captureStdout(() =>
      withCapturedStderr(() => {
        run(["unblock-auto", "--report", state.reportPath], root, runner);
      }),
    );
    assert.include(output, "restart: hyprws moved under the walk");
    assert.strictEqual(
      validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8"))).stage,
      "listed",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("discloses rerere reuse in the stop and conflict record row", () => {
  const commit = { sha: C, subject: "fix(web): preserve scoped behavior", domain: "fork-meta" };
  const conflicts = ["apps/web/src/reused.ts", "apps/web/src/unresolved.ts"];
  const rerereResolved = ["apps/web/src/reused.ts"];
  const stop = rehearsalConflictStop(
    "/tmp/report.json",
    "/tmp/record.md",
    commit,
    conflicts,
    rerereResolved,
  );
  assert.include(
    stop,
    "apps/web/src/reused.ts (rerere reused a recorded resolution; review before staging)",
  );
  assert.include(
    stop,
    "Review and stage rerere-resolved files; resolve and stage remaining non-generated files",
  );
  const reusedRow = rehearsalConflictRows(commit, conflicts, rerereResolved).find(
    ({ path }) => path === "apps/web/src/reused.ts",
  );
  assert.deepInclude(reusedRow, {
    path: "apps/web/src/reused.ts",
    class: "TODO",
    resolution: "review rerere's recorded resolution and stage",
    agentSafe: "TODO",
    decidedBy: "TODO",
  });
});

it("renders and parses the record schema including conflict judgement", () => {
  const root = fixtureRoot();
  const state = report(root, {
    stage: "conflicts",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    conflicts: [
      {
        commit: C,
        subject: "fix(web): keep behavior (#352)",
        domain: "fork-meta",
        path: "apps/web/src/a.ts",
        class: "TODO",
        resolution: "TODO",
        agentSafe: "TODO",
        decidedBy: "human",
      },
    ],
  });
  const rendered = renderRecord(state);
  assert.include(rendered, "## Header");
  assert.include(rendered, "## Conflicts");
  assert.include(rendered, "## Automerged overlap review");
  assert.include(rendered, "## Fork commits");
  assert.include(rendered, "## Silent seams");
  assert.include(rendered, "## Verification");
  assert.include(rendered, "## Grounding");
  const edited = rendered.replace(
    "| TODO | TODO | TODO |",
    "| seam-moved | preserve upstream hook | yes — tested |",
  );
  assert.deepInclude(parseConflictRows(edited), {
    commit: C.slice(0, 12),
    subject: "fix(web): keep behavior (#352)",
    domain: "fork-meta",
    path: "apps/web/src/a.ts",
    class: "seam-moved",
    resolution: "preserve upstream hook",
    agentSafe: "yes — tested",
    decidedBy: "human",
  });
  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("round-trips escaped pipes and backslashes in conflict cells", () => {
  const root = fixtureRoot();
  const conflict = {
    commit: C,
    subject: "fix(web): preserve a | b and \\q",
    domain: "fork-meta",
    path: "apps/web/src/a|b\\q.ts",
    class: "seam-moved" as const,
    resolution: "keep left | right and \\q",
    agentSafe: "yes | covered by C:\\tests",
    decidedBy: "agent" as const,
  };
  const rendered = renderRecord(
    report(root, {
      stage: "conflicts",
      conflicts: [conflict],
    }),
  );
  assert.include(
    rendered,
    "Escaped pipes are accepted in Subject, File, Resolution, and Agent-safe cells (`\\|`)",
  );
  assert.deepStrictEqual(parseConflictRows(rendered), [{ ...conflict, commit: C.slice(0, 12) }]);
  assert.throws(
    () => parseConflictRows(rendered.replace("keep left \\| right", "keep left \\q right")),
    /invalid conflict Resolution cell: unsupported escape \\q/,
  );
  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("allows a conflict stop's dirt at whichever stage the stop was recorded", () => {
  const root = fixtureRoot();
  const rows = [
    {
      commit: C,
      subject: "fix(web): preserve scoped behavior",
      domain: "fork-meta",
      path: "apps/web/src/reused.ts",
      class: "mechanical" as const,
      resolution: "kept both",
      agentSafe: "yes",
      decidedBy: "agent" as const,
    },
  ];
  const stopped = (stage: SyncReport["stage"], overrides: Partial<SyncReport["walk"]> = {}) =>
    report(root, {
      stage,
      conflicts: rows,
      walk: { stop: { reason: "conflict" as const, detail: "declined" }, ...overrides },
    });

  // The conflicts stage is the shape the allowance was written for.
  assert.deepStrictEqual(
    [...conflictStopDirtAllowance(stopped("conflicts"))],
    ["apps/web/src/reused.ts"],
  );
  // A conflict stop the additive phase raised sits at a later stage and its lane is dirty for the
  // same reason, so the stop reason is what earns the allowance.
  assert.deepStrictEqual(
    [
      ...conflictStopDirtAllowance(
        stopped("replayed", {
          additive: {
            pass: false,
            attempts: 1,
            findings: [
              { check: "readded", path: "apps/web/src/kept.ts", detail: "re-added upstream lines" },
            ],
            fixed: [],
          },
        }),
      ),
    ],
    ["apps/web/src/reused.ts", "apps/web/src/kept.ts"],
  );
  // No stop, no allowance: a fresh or finished lane stays strictly clean.
  assert.deepStrictEqual([...conflictStopDirtAllowance(report(root, { conflicts: rows }))], []);
  assert.deepStrictEqual(
    [
      ...conflictStopDirtAllowance(
        report(root, {
          stage: "conflicts",
          conflicts: rows,
          walk: { stop: { reason: "environment", detail: "no lane" } },
        }),
      ),
    ],
    [],
  );
});

it("distinguishes importer ownership drift from registry snapshot drift", () => {
  const base =
    "lockfileVersion: '9.0'\nimporters:\n  .:\n    specifiers: {}\nsnapshots:\n  a: old\n";
  assert.strictEqual(lockDriftClass(base, base), "none");
  assert.strictEqual(lockDriftClass(base, base.replace("a: old", "a: new")), "snapshots");
  assert.strictEqual(
    lockDriftClass(base, base.replace("specifiers: {}", "specifiers: { x: 1 }")),
    "importers",
  );
});

it("round-trips orientation verdicts outside conflicts and selects them for Gate 4", () => {
  const root = fixtureRoot();
  const orientationDecisions = orientationDecisionRows(
    [
      "  [candidate] `fix(web): review upstream overlap` (project-windows)",
      "  [keep] `feat(web): keep fork behavior` (workspace-files)",
      "  [retire] `fix(server): use upstream behavior` (fork-meta)",
      "  [partial] `feat(desktop): retain one seam` (custom-agents)",
    ].join("\n"),
  );
  const record = renderRecord(report(root, { orientationDecisions }));

  const conflicts = record.split("## Conflicts\n", 2)[1]?.split("\n## ", 1)[0] ?? "";
  assert.include(conflicts, "None.");
  assert.notInclude(conflicts, "orientation");
  assert.include(
    record,
    "| `fix(web): review upstream overlap` | project-windows | orientation: candidate; retire-candidate | TODO |",
  );
  assert.include(
    record,
    "| `feat(web): keep fork behavior` | workspace-files | orientation: keep | keep |",
  );
  assert.include(
    record,
    "| `fix(server): use upstream behavior` | fork-meta | orientation: retire | retire |",
  );
  assert.include(
    record,
    "| `feat(desktop): retain one seam` | custom-agents | orientation: partial | partial |",
  );

  const surface = decisionSurface(record);
  for (const subject of orientationDecisions.map(({ subject }) => subject)) {
    assert.include(surface, subject);
  }
  NodeFS.rmSync(root, { recursive: true, force: true });
});

// unblock-apply runs fork:upstream-refs over this record and posts it to a GitHub thread.
// Nothing the tool wrote may refuse the tool's own guard.
it("writes every item number into the record inside a code span", () => {
  const root = fixtureRoot();
  const state = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: "rehearse/v1.2.3", worktree: root },
    orientation: [
      "## Retire candidates",
      "",
      "  [candidate] `fix(web): supersede #4379 in the fork` (project-windows)",
      "",
      "## upstream-watch against v1.2.3",
      "",
      "  `#150` [ready] `zoom flash [\u{1F4E1}#110]`",
      "",
    ].join("\n"),
    orientationDecisions: orientationDecisionRows(
      "  [candidate] `fix(web): supersede #4379 in the fork` (project-windows)",
    ),
    verification: [{ command: "vp run --no-cache test", result: "passed" }],
  });
  try {
    assert.deepStrictEqual(findUpstreamReferences(renderRecord(state)), []);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("produces Gate 4 decisions structurally rather than with a typed rg command", () => {
  const record =
    "| Exact subject | Domain | Class summary | Action | Grounding claim |\n| --- | --- | --- | --- | --- |\n| `fix: one` | fork-meta | conflict; retire-candidate because upstream moved | retire | n/a |\n| `fix: two` | web | human | keep | claim |\nGrounding pending: desktop label";
  const surface = decisionSurface(record);
  assert.include(surface, "fix: one");
  assert.include(surface, "fix: two");
  assert.include(surface, "Grounding pending: desktop label");
});

it("requires a fresh review verdict for a nightly apply", () => {
  const root = fixtureRoot();
  const proposer = {
    iface: "pi",
    provider: "meta",
    model: "muse-spark",
    session: "walk-1",
  };
  const reviewer = {
    iface: "pi",
    provider: "meta",
    model: "muse-spark",
    session: "review-2",
  };
  const base = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3-nightly.20260904.1", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: `rehearse/nightly-from-${C.slice(0, 12)}`, worktree: root },
    installedHead: B,
    ciHead: B,
    proposedBy: proposer,
    verification: [{ command: "hyprws CI https://example.test/run/1", result: "passed" }],
  });
  try {
    const proposal = renderRecord(base);
    assert.throws(() => validateNightlyReview(proposal, base), /review is missing/);
    const evidence = {
      target: base.target!.tag,
      targetSha: B,
      blockingSha: A,
      expectedOld: C,
      installedHead: B,
      ciHead: B,
      laneBranch: base.lane!.branch,
      recordDigest: nightlyProposalDigest(proposal),
      inspected: NIGHTLY_REVIEW_EVIDENCE,
    };
    const reviewed: SyncReport = {
      ...base,
      nightlyReview: {
        status: "signed-off",
        proposer,
        reviewer,
        reviewedAt: "2026-09-04T10:00:00.000Z",
        evidence,
      },
    };
    const record = renderRecord(reviewed);
    validateNightlyReview(record, reviewed);
    assert.include(record, "Proposer: agent `pi/meta/muse-spark`, session `walk-1`");
    assert.include(record, "Reviewer: agent `pi/meta/muse-spark`, session `review-2`");
    for (const item of NIGHTLY_REVIEW_EVIDENCE) assert.include(record, `  - ${item}`);
    for (const rule of NIGHTLY_WITHHOLD_RULES) assert.include(record, `  - ${rule}`);

    // Any reviewer identity is evidence only; the only identity refusal is
    // a verdict from the proposing session itself.
    for (const otherReviewer of [
      { ...reviewer, iface: "claude", provider: "anthropic", model: "claude-opus-5" },
      { ...reviewer, iface: "codex", provider: "openai", model: "gpt-5.6-sol" },
      { ...reviewer, model: "another-model" },
    ]) {
      const other = {
        ...reviewed,
        nightlyReview: { ...reviewed.nightlyReview!, reviewer: otherReviewer },
      } satisfies SyncReport;
      validateNightlyReview(renderRecord(other), other);
    }
    assert.throws(
      () =>
        validateNightlyReview(record, {
          ...reviewed,
          nightlyReview: {
            ...reviewed.nightlyReview!,
            reviewer: { ...reviewer, session: proposer.session },
          },
        }),
      /shares the proposer's session/,
    );

    const botCarried = { ...base, botCarried: true } satisfies SyncReport;
    validateNightlyReview(renderRecord(botCarried), botCarried);
    const withheld: SyncReport = {
      ...reviewed,
      nightlyReview: {
        status: "withheld",
        proposer,
        reviewer,
        reviewedAt: "2026-09-04T10:00:00.000Z",
        reason: "fork intent is undefined",
      },
    };
    assert.throws(
      () => validateNightlyReview(renderRecord(withheld), withheld),
      /review was withheld/,
    );
    // A new seam verdict-row still voids the review: the count lives in
    // the bound half even though each summary is free prose.
    const changed = {
      ...reviewed,
      silentSeams: [{ path: "apps/web/src/a.ts", summary: "late change", touchesBehaviour: false }],
    } satisfies SyncReport;
    assert.throws(() => validateNightlyReview(renderRecord(changed), changed), /review is stale/);
    assert.throws(
      () => validateNightlyReview(record, changed),
      /review evidence is stale against the report/,
    );
    assert.throws(
      () =>
        validateNightlyReview(record, {
          ...reviewed,
          target: { tag: "v1.2.3", sha: B },
        }),
      /record target binding is stale/,
    );
    assert.throws(
      () =>
        validateNightlyReview(
          record.replace("- Reviewed at:", "- Unbound reviewer note\n- Reviewed at:"),
          reviewed,
        ),
      /reviewed provenance/,
    );
    // Free prose never enters the digest: a bare reference at sign-off,
    // wrapped in backticks afterwards, keeps the sign-off. A verdict-row
    // change still voids it.
    const seamed = {
      ...reviewed,
      silentSeams: [
        {
          path: "apps/web/src/a.ts",
          summary: "see RSI-Software/t3code-hyprws#650",
          touchesBehaviour: false,
        },
      ],
    } satisfies SyncReport;
    const { nightlyReview: _dropped, ...seamedProposal } = seamed;
    const seamedEvidence = {
      ...evidence,
      recordDigest: nightlyProposalDigest(renderRecord(seamedProposal)),
    };
    const seamedReview = {
      ...seamed,
      nightlyReview: { ...seamed.nightlyReview!, evidence: seamedEvidence },
    } satisfies SyncReport;
    const liveRecord = renderRecord(seamedReview);
    assert(liveRecord.includes("see RSI-Software/t3code-hyprws#650"), liveRecord.slice(-600));
    validateNightlyReview(liveRecord, seamedReview);
    const wrapped = liveRecord.replace(
      "see RSI-Software/t3code-hyprws#650",
      "see `RSI-Software/t3code-hyprws#650`",
    );
    assert.strictEqual(nightlyProposalDigest(wrapped), nightlyProposalDigest(liveRecord));
    validateNightlyReview(wrapped, seamedReview);
    // A moved lease still voids the review even though prose does not.
    const leaseChange = liveRecord.replace(
      `\`expected_old\`: \`${C}\``,
      `\`expected_old\`: \`${"d".repeat(40)}\``,
    );
    assert.throws(
      () => validateNightlyReview(leaseChange, seamedReview),
      /evidence is stale against the report/,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(base.reportPath), { recursive: true, force: true });
  }
});

it("binds runtime provenance to the active ghb host handoff", () => {
  const runner = new FakeRunner();
  runner.set("ghb", ["attest", "handoff"], {
    stdout: JSON.stringify({
      schema: "ghb.host-handoff.v1",
      host: {
        role: "host",
        iface: "claude",
        provider: "anthropic",
        model: "claude-opus-5",
        effort: "high",
        harness: "claude-code@2.1.259",
        session: "review-2",
      },
    }),
  });
  assert.deepStrictEqual(agentProvenance(runner, "/repo"), {
    iface: "claude",
    provider: "anthropic",
    model: "claude-opus-5",
    session: "review-2",
  });
  assert.deepInclude(runner.calls[0], {
    command: "ghb",
    args: ["attest", "handoff"],
    cwd: "/repo",
  });

  runner.set("ghb", ["attest", "handoff"], { stdout: "not json" });
  assert.throws(() => agentProvenance(runner, "/repo"), /invalid ghb handoff JSON/);
  runner.set("ghb", ["attest", "handoff"], {
    stdout: JSON.stringify({ schema: "ghb.host-handoff.v2", host: {} }),
  });
  assert.throws(() => agentProvenance(runner, "/repo"), /unsupported ghb handoff schema/);
});

it("asks a record for decisions and a go, never a login or a date", () => {
  const root = fixtureRoot();
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: "rehearse/v1.2.3", worktree: root },
    installedHead: B,
    orientationDecisions: orientationDecisionRows(
      "  [candidate] `feat(web): themed menus` (workspace-files)",
    ),
  });
  try {
    const rendered = renderRecord(checked);
    assert.notInclude(rendered, "Human sanity");
    // Every claim is the rendered default, so the surface asks for nothing else.
    assert.include(decisionSurface(rendered), "Stop. Obtain every decision and an explicit go.\n");
    assert.throws(() => validateSignedRecord(rendered, checked), /keep\/retire\/partial/);
    const decided = rendered.replace("| TODO |", "| retire |");
    // An action nobody signed is the rendered default, not a decision the walk may land on.
    assert.throws(() => validateSignedRecord(decided, checked), /records no decider/);
    validateSignedRecord(decided.replace("| TODO |", "| human |"), checked);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("reads a signed decision back through a row whose evidence quotes a pipe", () => {
  const root = fixtureRoot();
  const quoted = "| --- | --- |";
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: "rehearse/v1.2.3", worktree: root },
    installedHead: B,
    orientationDecisions: orientationDecisionRows(
      "  [candidate] `feat(web): themed menus` (workspace-files)",
    ),
    retireEvidence: [
      {
        subject: "feat(web): themed menus",
        commit: B,
        identifiers: [quoted],
        matches: [{ identifier: quoted, location: "docs/table.md:8" }],
      },
    ],
  });
  try {
    const rendered = renderRecord(checked);
    // A target-tree grep can match a Markdown separator, so the class summary carries pipes the
    // renderer escapes. Reading the row back on unescaped pipes only would shift every later
    // cell and leave the signed action in the wrong column.
    assert.include(rendered, "target-tree: \\| --- \\| --- \\| at docs/table.md:8");
    const decided = rendered.replace("| TODO |", "| keep |").replace("| TODO |", "| agent |");
    assert.include(decisionSurface(decided), "feat(web): themed menus");
    validateSignedRecord(decided, checked);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("reads only the decision cells someone signed", () => {
  const table = [
    "## Fork commits",
    "",
    "| Exact subject | Domain | Class summary | Action | Grounding claim | Decided by |",
    "| --- | --- | --- | --- | --- | --- |",
    "| `fix: signed` | fork-meta | orientation: candidate; retire-candidate | retire | n/a | human |",
    "| `fix: unsigned` | fork-meta | orientation: candidate; retire-candidate | retire | n/a | TODO |",
    "| `fix: undecided` | fork-meta | orientation: candidate; retire-candidate | TODO | n/a | TODO |",
    "",
    "## Silent seams",
  ].join("\n");
  assert.deepStrictEqual(filledDecisionCells(table), [
    { subject: "fix: signed", action: "retire", decidedBy: "human" },
  ]);
});

it("still asks for grounding when a row carries a claim", () => {
  const claimed =
    "| Exact subject | Domain | Class summary | Action | Grounding claim |\n| --- | --- | --- | --- | --- |\n| `fix: one` | fork-meta | orientation: candidate; retire-candidate | TODO | grounded in the desktop label |";
  assert.include(
    decisionSurface(claimed),
    "Stop. Obtain every decision, every grounding confirmation, and an explicit go.\n",
  );
  assert.include(
    decisionSurface(claimed.replace("grounded in the desktop label", NO_GROUNDING_CLAIM)),
    "Stop. Obtain every decision and an explicit go.\n",
  );
});

it("Gate 4 decides every orientation row and asks for nothing", () => {
  const root = fixtureRoot();
  const subject = "feat(web): scoped project windows";
  const rows = (
    verdict: "keep" | "retire" | "partial" | "candidate",
    decidedBy: "TODO" | "human" | "agent" | `inherited (${string})` = "TODO",
  ): SyncReport =>
    report(root, {
      orientationDecisions: [{ subject, domain: "fork-meta", verdict, decidedBy }],
    });
  try {
    // A ledger verdict is the human's answer already; the walk executes it and says so.
    for (const verdict of ["keep", "retire", "partial"] as const)
      assert.deepInclude(autoGateFour(rows(verdict)).orientationDecisions?.[0], {
        verdict,
        decidedBy: "human",
      });
    // An inherited verdict keeps naming the walk it came from.
    assert.deepInclude(autoGateFour(rows("keep", "inherited (v1.2.2)")).orientationDecisions?.[0], {
      decidedBy: "inherited (v1.2.2)",
    });
    // A candidate is the machine's own keep, and it never becomes a stop.
    assert.deepInclude(autoGateFour(rows("candidate")).orientationDecisions?.[0], {
      verdict: "candidate",
      action: "keep (mechanical seam)",
      decidedBy: "agent",
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("reads a fork commit's own identifiers out of its diff", () => {
  const diff = [
    "diff --git a/packages/contracts/src/window.ts b/packages/contracts/src/window.ts",
    "--- a/packages/contracts/src/window.ts",
    "+++ b/packages/contracts/src/window.ts",
    "@@ -0,0 +1,3 @@",
    "+export const ScopedProjectWindow = 1;",
    '+const message = "project window is already open";',
    '+const short = "tiny";',
    "diff --git a/apps/web/src/settings.json b/apps/web/src/settings.json",
    "+++ b/apps/web/src/settings.json",
    '+  "window.perProject": true,',
    '+  "name": "x",',
    "diff --git a/apps/web/src/window.test.ts b/apps/web/src/window.test.ts",
    "+++ b/apps/web/src/window.test.ts",
    '+it("opens one window per project", () => {});',
    "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
    "+++ b/pnpm-lock.yaml",
    "+  /some-package-name-that-is-long@1.0.0:",
    '+  resolution: "integrity-sha512-not-a-fork-identifier"',
  ].join("\n");
  assert.deepStrictEqual(forkCommitIdentifiers(diff), [
    "ScopedProjectWindow",
    "project window is already open",
    "window.perProject",
    "opens one window per project",
  ]);
});

it("keeps module specifiers and fixture data out of a fork commit's identifiers", () => {
  // Every one of these was harvested on the v0.0.41-nightly.20260910.1473 walk and then proved a
  // retirement against the dependency's own import line (RSI-Software/t3code-hyprws#750).
  const diff = [
    "diff --git a/apps/desktop/src/fork.ts b/apps/desktop/src/fork.ts",
    "+++ b/apps/desktop/src/fork.ts",
    '+import { parse } from "smol-toml";',
    '+import * as Effect from "effect/Effect";',
    '+import "@effect/vitest";',
    '+export { openWindow } from "./scoped-window.ts";',
    '+const mod = await import("node:child_process");',
    '+vi.mock("@effect/vitest", () => ({}));',
    '+const at = "2026-01-01T00:00:00.000Z";',
    '+const config = "/tmp/fable.toml";',
    '+const toml = `name = "fable"`;',
    '+const digits = "0000000000000000";',
    '+const real = "scoped project window";',
  ].join("\n");
  assert.deepStrictEqual(forkCommitIdentifiers(diff), ["scoped project window"]);
});

it("filters a retired middle commit without changing git-log record framing", () => {
  const original = "feat: first\n\x1e\nfix: retire me\n\x1e\nfeat: last\n\x1e\n";

  assert.strictEqual(
    filterRetiredMessagesForTest(original, new Set(["fix: retire me"])),
    "feat: first\n\x1e\nfeat: last\n\x1e\n",
  );
});

it("refuses a skip whose subject has no Retired row in the fork delta ledger", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-skip-ledger-"));
  try {
    NodeFS.mkdirSync(NodePath.join(root, "docs/internals"), { recursive: true });
    const ledger = [
      "## Retired",
      "",
      "| Fork commit | Domain | Upstream replacement | Retired at |",
      "| --- | --- | --- | --- |",
      "| fix: retired properly | thread-ordering | `upstream#1` | v1.0.0 |",
      "",
      "## Kept",
      "",
      "| Fork commit | Domain | Reason | Reviewed at |",
      "| --- | --- | --- | --- |",
      "|",
    ];
    // Keep the Kept table header-valid with one empty-ish row.
    ledger[ledger.length - 1] = "| fix: kept | thread-ordering | still wanted | v1.0.0 |";
    NodeFS.writeFileSync(
      NodePath.join(root, "docs/internals/fork-delta.md"),
      `${ledger.join("\n")}\n`,
    );
    // A recorded verdict without the ledger row is refused, loud, with the subject.
    assert.throws(
      () => assertRetiredInLedgerForTest(new Set(["fix: retire me"]), root),
      /refusing git rebase --skip: no Retired row in docs\/internals\/fork-delta\.md for fix: retire me/,
    );
    // The subject whose row a human wrote is allowed to skip.
    assertRetiredInLedgerForTest(new Set(["fix: retired properly"]), root);
    // A missing ledger fails closed for every subject.
    const empty = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-skip-noledger-"));
    try {
      assert.throws(
        () => assertRetiredInLedgerForTest(new Set(["fix: retire me"]), empty),
        /refusing git rebase --skip/,
      );
    } finally {
      NodeFS.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

/** A fixture upstream tree plus two fork commits: one retired upstream, one not. */
const retireFixture = (): { root: string; tag: string } => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-retire-"));
  const run = (...args: ReadonlyArray<string>): void => {
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    });
  };
  const write = (path: string, contents: string): void => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, path), contents);
  };
  run("init", "-b", "fixture");
  write("upstream.ts", "export const upstreamOnly = 1;\n");
  run("add", "-A");
  run("commit", "-m", "upstream: base");
  // Upstream grows the behaviour one fork commit also carries.
  write("upstream.ts", "export const upstreamOnly = 1;\nexport const SharedWindowScope = 2;\n");
  run("add", "-A");
  run("commit", "-m", "upstream: adopt scoped windows");
  run("tag", "v1.2.3");
  write("fork-absent.ts", "export const ForkOnlyHelper = 1;\n");
  run("add", "-A");
  run("commit", "-m", "feat: absent from the target tree");
  write("fork-present.ts", "export const SharedWindowScope = 2;\n");
  run("add", "-A");
  run("commit", "-m", "feat: present in the target tree");
  return { root, tag: "v1.2.3" };
};

it("tests retire candidates against the target tree instead of proximity", () => {
  const { root, tag } = retireFixture();
  const runner = new SystemRunner();
  const git = (...args: ReadonlyArray<string>): string =>
    runner.run("git", args, root).stdout.trim();
  const targetSha = git("rev-parse", `refs/tags/${tag}^{commit}`);
  const source = git("rev-parse", "HEAD");
  const decisions = [
    { subject: "feat: absent from the target tree", domain: "fork-meta" },
    { subject: "feat: present in the target tree", domain: "fork-meta" },
  ].map((row) => ({ ...row, verdict: "candidate" as const, decidedBy: "human" as const }));
  try {
    const evidence = collectRetireEvidence(
      runner,
      root,
      targetSha,
      { sharedBase: targetSha, source },
      decisions,
    );
    assert.deepStrictEqual(
      evidence.map(({ subject, matches }) => [subject, matches.length]),
      [
        ["feat: absent from the target tree", 0],
        ["feat: present in the target tree", 1],
      ],
    );
    assert.deepStrictEqual(evidence[1]?.matches[0], {
      identifier: "SharedWindowScope",
      location: "upstream.ts:2",
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

// RSI-Software/t3code-hyprws#688: an unscoped probe read roughly 35 of 40 rows as retire
// candidates on sightings like these, and the operator's per-row test stopped being run.
it("finds no retirement evidence in harness paths, prose, or a bare mention", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-retire-noise-"));
  const run = (...args: ReadonlyArray<string>): void => {
    NodeChildProcess.execFileSync("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    });
  };
  const write = (path: string, contents: string): void => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, path), contents);
  };
  run("init", "-b", "fixture");
  // The target tree names the fork's identifier three ways, none of which implement it.
  write(".agents/skills/notes/SKILL.md", "export const ForkOnlyHelper = 1;\n");
  write("docs/internals/notes.md", "export const ForkOnlyHelper = 1;\n");
  write("apps/web/src/x.ts", "// ForkOnlyHelper is what the fork calls this\n");
  run("add", "-A");
  run("commit", "-m", "upstream: base");
  run("tag", "v1.2.3");
  write("apps/web/src/fork.ts", "export const ForkOnlyHelper = 1;\n");
  run("add", "-A");
  run("commit", "-m", "feat: only the fork implements this");
  const runner = new SystemRunner();
  const git = (...args: ReadonlyArray<string>): string =>
    runner.run("git", args, root).stdout.trim();
  const targetSha = git("rev-parse", "refs/tags/v1.2.3^{commit}");
  try {
    const evidence = collectRetireEvidence(
      runner,
      root,
      targetSha,
      { sharedBase: targetSha, source: git("rev-parse", "HEAD") },
      [
        {
          subject: "feat: only the fork implements this",
          domain: "fork-meta",
          verdict: "candidate" as const,
          decidedBy: "human" as const,
        },
      ],
    );
    assert.deepStrictEqual(evidence[0]?.matches, []);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("Gate 4 keeps a candidate whether or not the target tree already carries it", () => {
  const root = fixtureRoot();
  const orientation = "  [candidate] `feat: candidate` (fork-meta)\n";
  const state = (matches: RetireEvidence["matches"]): SyncReport =>
    report(root, {
      orientation,
      orientationDecisions: orientationDecisionRows(orientation),
      retireEvidence: [
        { subject: "feat: candidate", commit: C, identifiers: ["ForkOnlyHelper"], matches },
      ],
    });
  try {
    const absent = state([]);
    assert.deepInclude(autoGateFour(absent).orientationDecisions?.[0], {
      verdict: "candidate",
      action: "keep (target tree absent)",
      decidedBy: "agent",
    });
    assert.include(renderRecord(absent), "retire-candidate; target-tree: absent");

    // Upstream carrying the same identifiers is evidence for the fork delta's retirement ledger,
    // not a stop: the walk keeps the commit, records the sighting, and lands the tag.
    const present = state([{ identifier: "ForkOnlyHelper", location: "apps/web/src/x.ts:14" }]);
    assert.deepInclude(autoGateFour(present).orientationDecisions?.[0], {
      verdict: "candidate",
      action: "keep (target tree present)",
      decidedBy: "agent",
    });
    assert.include(renderRecord(present), "target-tree: ForkOnlyHelper at apps/web/src/x.ts:14");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

const slice4Orientation = [
  "fork-sync gate 1 orientation",
  "",
  "target:       v0.0.38-nightly.20260831.1236@9b2d04317c68233782e0630464ac86d77d0686f3",
  "              nightly tag; the apply gate needs --allow-nightly, reachable from upstream/main",
  "source:       origin/hyprws@1f429a345f3846e42225786ce393ca004161d408",
  "shared base:  30175a8af04c0daa359652b5e8dc8230b40b462a",
  "mirror:       origin/main matches upstream/main at 5b7d72aad14e",
  "dependencies: node_modules is present",
  "",
  "## Feasibility",
  "",
  "2 of 5 upstream commits clean; first conflict `3958111 fix(preview): improve browser recording quality (#8839)`",
  "",
  "1 conflicting files:",
  "  - packages/contracts/src/settings.test.ts (1 hunks)",
  "",
  "## Automerged overlap",
  "",
  "32 upstream-changed, 511 fork-changed, 14 overlap (1 hard-conflict, 13 automerged)",
  "",
  "Automerged files are a semantic review surface, not proof the fork behavior survived:",
  "  - apps/desktop/src/ipc/methods/preview.ts",
  "  - apps/desktop/src/preview/Manager.test.ts",
  "  - apps/desktop/src/preview/Manager.ts",
  "  - apps/desktop/src/settings/DesktopClientSettings.test.ts",
  "  - apps/web/src/components/ChatView.tsx",
  "  - apps/web/src/components/chat/ChatComposer.tsx",
  "  - apps/web/src/components/chat/MessagesTimeline.tsx",
  "  - apps/web/src/components/settings/SettingsPanels.tsx",
  "  - apps/web/src/components/settings/settingsSearch.test.ts",
  "  - apps/web/src/components/settings/settingsSearch.ts",
  "  - packages/contracts/src/ipc.ts",
  "  - packages/contracts/src/settings.ts",
  "  - pnpm-lock.yaml",
  "",
  "## Retire candidates",
  "",
  "  [candidate] `feat(desktop): namespace previews by window` (project-windows)",
  "      behaviour-overlap: weak hunk overlap: apps/desktop/src/preview/Manager.test.ts@2075~2078, apps/desktop/src/preview/Manager.test.ts@2093-2099~2100-2104, apps/desktop/src/preview/Manager.ts@4160-4240~4199",
  "  [keep] `feat(terminal): attach thread terminals to the checkout's managed zmux session` (zmux-estate)",
  "      behaviour-overlap: weak hunk overlap: packages/contracts/src/settings.test.ts@52-69~69-88",
  "  [candidate] `feat(files): reveal ignored workspace files (#73)` (workspace-files)",
  "      behaviour-overlap: hard: packages/contracts/src/settings.test.ts (1 hunk)",
  "  [keep] `feat: New worktrunk thread mode replaces the Worktrunk hook switches` (worktrunk-hooks)",
  "      behaviour-overlap: weak hunk overlap: packages/contracts/src/settings.ts@940,0~937",
  "  [keep] `feat(web): add GitHub link destination controls (#178)` (github-issues)",
  "      behaviour-overlap: weak hunk overlap: packages/contracts/src/settings.test.ts@88-109~69-88",
  "  [candidate] `feat(web): open child work from the Agents panel` (custom-agents)",
  "      behaviour-overlap: weak hunk overlap: apps/web/src/components/chat/MessagesTimeline.tsx@229~227,0",
  "",
  "## upstream-watch against v0.0.38-nightly.20260831.1236",
  "",
  '  `#145` [waiting] `[📡#110] preview_open answers "open failed on client" when the reused tab cannot load the page`',
  "  `#154` [uncited] `[📡#110] Bulk thread deletion prompts for every orphaned worktree`",
  "  `#182` [waiting] `[📡#110] Repo-local skills are missing from Codex and Claude command menus`",
  "  `#206` [waiting] `[📥] play video uploads in place in the pull request Summary tab (review evidence without leaving the app)`",
  "  `#239` [ready] `[📥] hyprws CI Test job goes red on unchanged code from upstream's mobile diff highlighter test`",
  "  `#240` [uncited] `[📥] hyprws CI Test Server 2 job goes red then passes on rerun from upstream's ProviderRegistry re-probe test`",
  "  `#385` [pending-tag] `Claude model catalog moves to the remote manifest upstream; fork waits instead of patching [📡#110]`",
  "  `#414` [waiting] `Dead Claude adapter session leaves thread un-settleable until deleted [📥]`",
  "  `#415` [waiting] `Moved project folder fails every thread with a generic runtime error and cannot be repointed [📡#110]`",
  "",
  "## Stop",
  "",
  "Stop. This report is orientation, not permission to modify a ref.",
  "",
  "Show the human:",
  "  target:             v0.0.38-nightly.20260831.1236@9b2d04317c68233782e0630464ac86d77d0686f3",
  "  source:             origin/hyprws@1f429a345f3846e42225786ce393ca004161d408",
  "  shared base:        30175a8af04c0daa359652b5e8dc8230b40b462a",
  "  mirror:             origin/main matches upstream/main at 5b7d72aad14e",
  "  feasibility:        2 of 5 upstream commits clean; first conflict `3958111 fix(preview): improve browser recording quality (#8839)`",
  "  automerged overlap: 13 files",
  "  retire candidates:  6",
  "  upstream-watch:     9 open: 5 waiting, 2 uncited, 1 ready, 1 pending-tag",
  "",
  "Continue only after the human confirms the target.",
].join("\n");

it("Gate 4 carries the complete slice-4 orientation with a type-only silent seam", () => {
  const root = fixtureRoot();
  const state = report(root, {
    stage: "checked",
    installedHead: B,
    orientation: slice4Orientation,
    orientationDecisions: orientationDecisionRows(slice4Orientation),
    conflicts: [
      {
        commit: C,
        subject: "feat(files): reveal ignored workspace files (#73)",
        domain: "workspace-files",
        path: "packages/contracts/src/settings.test.ts",
        class: "mechanical",
        resolution: "rerere replay",
        agentSafe: "true",
        decidedBy: "agent",
      },
    ],
    silentSeams: [
      {
        path: "apps/desktop/src/preview/Manager.ts",
        summary: "return upstream DesktopPreviewRecordingSource",
        touchesBehaviour: false,
      },
    ],
  });
  try {
    const decided = autoGateFour(state);
    assert.lengthOf(
      decided.orientationDecisions?.filter(
        ({ verdict, action }) => verdict === "candidate" && action === "keep (mechanical seam)",
      ) ?? [],
      3,
    );
    const record = renderRecord(decided);
    assert.include(record, "[type]: return upstream DesktopPreviewRecordingSource");
    assert.include(record, "| keep (mechanical seam) |");
    validateSignedRecord(record, decided);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("silent seam evidence distinguishes type adaptation from behaviour", () => {
  assert.deepStrictEqual(parseSilentSeam("apps/a.ts=adapt upstream return type:type"), {
    path: "apps/a.ts",
    summary: "adapt upstream return type",
    touchesBehaviour: false,
  });
  const root = fixtureRoot();
  const typeOnly = report(root, {
    silentSeams: [
      { path: "apps/a.ts", summary: "adapt upstream return type", touchesBehaviour: false },
    ],
  });
  const behaviour = {
    ...typeOnly,
    silentSeams: [
      { path: "apps/a.ts", summary: "changed visible behavior", touchesBehaviour: true },
    ],
  };
  try {
    // A behaviour-touching seam is recorded, not a stop: the walk cannot ask, and the record and
    // the ledger row are what a maintainer reads afterwards.
    assert.include(renderRecord(typeOnly), "`apps/a.ts` [type]: adapt upstream return type");
    assert.include(renderRecord(behaviour), "`apps/a.ts` [behaviour]: changed visible behavior");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(typeOnly.reportPath), { recursive: true, force: true });
  }
});

it("re-reads the bot snapshot and refuses apply when its mode was restored to on", () => {
  const root = fixtureRoot();
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: "rehearse/v1.2.3", worktree: root },
    installedHead: B,
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  const runner = new FakeRunner();
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  setBotResponses(runner, "on");
  try {
    assert.throws(
      () =>
        execute(
          ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
          root,
          runner,
        ),
      /auto-rebase bot mode is on; pause it before continuing/,
    );
    // The lease probe reads origin/hyprws before the bot gets the floor; when
    // the lease is still live the bot complaint wins first. When no lease live
    // probe is kept, staleness first would have won.
    assert.deepStrictEqual(
      runner.calls.slice(0, 3).map(({ args }) => args),
      [["rev-parse", "origin/hyprws^{commit}"], modeArgs, runListArgs],
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("unblock-apply refuses a RUNNING bot with status 3", () => {
  const root = fixtureRoot();
  const checked = report(root, { stage: "checked" });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  const runner = new FakeRunner();
  runner.set("gh", modeArgs, { stdout: "candidate\n" });
  runner.set("gh", runListArgs, {
    stdout: JSON.stringify([{ ...lastRun, status: "in_progress", conclusion: null }]),
  });
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.strictEqual(
      run(
        ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
        root,
        runner,
      ),
      3,
    );
    assert.include(stderr, "bot run is in progress");
    assert.include(stderr, `report: ${checked.reportPath}\n`);
    assert.deepStrictEqual(
      runner.calls.slice(0, 2).map(({ args }) => args),
      [modeArgs, runListArgs],
    );
  } finally {
    process.stderr.write = original;
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

const stableCandidateFixture = (tag = "v1.0.0"): StableCandidate => ({
  tag,
  branch: `release/${tag}-hyprws`,
  sha: B,
  title: `Stable candidate ${tag}-hyprws`,
  marker: `<!-- hyprws-stable-candidate: ${tag}-hyprws -->`,
  label: "release",
  body: `snapshot for ${tag}`,
});

/**
 * A repository that already carries this candidate's issue, so a clean reconcile writes
 * nothing. `onRead` is where a test makes the reconcile fail.
 */
const stubGitHub = (candidate: StableCandidate, onRead: () => void = () => {}) => {
  const unreachable = (): never => {
    throw new Error("unexpected GitHub write");
  };
  const client: RebaseGitHubClient = {
    ensureBlockedLabel: unreachable,
    listBlockedIssues: unreachable,
    ensureHardFailureLabel: unreachable,
    listHardFailureIssues: unreachable,
    listReleaseIssues: () => {
      onRead();
      return [
        {
          number: 41,
          nodeId: "issue-41",
          state: "open",
          title: candidate.title,
          body: candidate.marker,
          issueType: "Notification 🔔",
        },
      ];
    },
    listIssueComments: unreachable,
    lookupIssueTypeId: unreachable,
    applyIssueType: unreachable,
    createIssue: unreachable,
    updateIssueBody: unreachable,
    createIssueComment: unreachable,
    updateIssueComment: unreachable,
    stableReleaseTagExists: () => false,
    closeIssue: unreachable,
  };
  return client;
};

it("names the snapshot branches it announced stable candidates from", () => {
  const candidate = stableCandidateFixture();
  const { output } = captureStdout(() =>
    announceStableCandidates([candidate], stubGitHub(candidate)),
  );
  assert.strictEqual(output, "stable candidates announced from origin/release/v1.0.0-hyprws\n");
});

it("reports a failed candidate announcement without voiding the apply it followed", () => {
  const candidate = stableCandidateFixture();
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const { output } = captureStdout(() =>
      announceStableCandidates(
        [candidate],
        stubGitHub(candidate, () => {
          throw new Error("issue list refused");
        }),
      ),
    );
    assert.strictEqual(output, "");
    assert.include(stderr, "stable candidate issues not reconciled: issue list refused");
    assert.include(stderr, "open their candidate issues by hand from origin/release/v1.0.0-hyprws");
  } finally {
    process.stderr.write = original;
  }
});

it("snapshots the tags between the pre-apply base and the gate tag before the leased push", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: root },
    installedHead: B,
    ciHead: B,
    orientation: coherentOrientation,
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  setOrientationResponses(runner);
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${B}\n` });
  runner.set(
    "git",
    ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { stdout: `${B}\trefs/heads/${branch}\n` },
  );
  runner.set("git", ["rev-parse", "v1.2.3^{commit}"], { stdout: `${B}\n` });
  runner.set("git", ["merge-base", C, B], { stdout: `${A}\n` });
  const ledger = ledgerFixture(root, checked.recordPath);
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const applied = execute(
      ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
      root,
      runner,
    );

    // The lane reads its own bases: the gate tag it lands on, and the upstream base the
    // pre-apply head sat on. A crossing it cannot enumerate is reported, never fatal.
    assert.strictEqual(applied.stage, "applied");
    assert.include(stderr, "crossed stable upstream tags not enumerated");
    const index = (match: (args: ReadonlyArray<string>) => boolean): number =>
      runner.calls.findIndex(({ command, args }) => command === "git" && match(args));
    const base = index((args) => args[0] === "merge-base" && args[1] === C && args[2] === B);
    const push = index((args) => args.includes(`--force-with-lease=refs/heads/hyprws:${C}`));
    assert.isAbove(base, 0);
    assert.isAbove(push, base);
  } finally {
    process.stderr.write = original;
    ledger.restore();
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("requires signed decisions and calls the existing sync gate before apply", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: root },
    installedHead: B,
    ciHead: B,
    orientation: coherentOrientation,
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  setOrientationResponses(runner);
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${B}\n` });
  runner.set(
    "git",
    ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { stdout: `${B}\trefs/heads/${branch}\n` },
  );
  runner.set(
    "gh",
    [
      "issue",
      "comment",
      "352",
      "-R",
      "RSI-Software/t3code-hyprws",
      "--body-file",
      checked.recordPath,
    ],
    { stdout: "https://example.test/comment\n" },
  );
  const ledger = ledgerFixture(root, checked.recordPath);
  try {
    const applied = execute(
      ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
      root,
      runner,
    );
    assert.strictEqual(applied.stage, "applied");
    const gate = runner.calls.find(
      ({ command, args }) => command === "vp" && args.includes("fork:sync-gate"),
    );
    assert.isDefined(gate);
    const push = runner.calls.find(
      ({ command, args }) => command === "git" && args.includes("push"),
    );
    assert.include(push?.args ?? [], `--force-with-lease=refs/heads/hyprws:${C}`);
    // The walk lane is local, so there is no remote rehearsal branch to publish or clean up.
    assert.isFalse(
      runner.calls.some(
        ({ command, args }) => command === "git" && args.join(" ").includes(`refs/heads/${branch}`),
      ),
    );
    assert.isFalse(
      runner.calls.some(({ args }) =>
        args.some((arg) => arg.includes("archive/hyprws-pre-rewrite")),
      ),
    );
  } finally {
    ledger.restore();
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("publishes the walk row and its outcomes before it reports applied", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: root },
    installedHead: B,
    ciHead: B,
    orientation: coherentOrientation,
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  setOrientationResponses(runner);
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${B}\n` });
  runner.set(
    "git",
    ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { stdout: `${B}\trefs/heads/${branch}\n` },
  );
  const ledger = ledgerFixture(root, checked.recordPath);
  try {
    const { output, result } = captureStdout(() =>
      execute(
        ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
        root,
        runner,
      ),
    );

    // The row reaches the published ref in this invocation, so the trunk the walk moved is
    // never a walk the ledger cannot show (RSI-Software/t3code-hyprws#664).
    const published = parseLedger(
      readBotRefFile(ledger.remote, CHURN_REF, CHURN_LEDGER_FILE) ?? "",
    );
    assert.deepStrictEqual(
      published.map(({ tag, before, after }) => ({ tag, before, after })),
      [{ tag: "v1.2.3", before: C, after: B }],
    );
    assert.strictEqual(result.walk?.ledger?.state, "published");
    // The retained apply receipt is what a later release binds its distribution to; without it
    // the release can only report `unknown`.
    const [summary] = summarizeOutcomes(readChurnState(root).outcomes);
    assert.strictEqual(summary?.appliedSha, B);
    assert.isBelow(output.indexOf("ledger: v1.2.3"), output.indexOf("applied: v1.2.3"));
    assert.include(output, `ledger: v1.2.3 row and outcomes on ${CHURN_REF}`);
  } finally {
    ledger.restore();
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("stops the walk on environment when the trunk moved and the ledger write cannot land", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: root },
    installedHead: B,
    ciHead: B,
    orientation: coherentOrientation,
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  setOrientationResponses(runner);
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${B}\n` });
  runner.set(
    "git",
    ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { stdout: `${B}\trefs/heads/${branch}\n` },
  );
  const ledger = ledgerFixture(root, checked.recordPath, { reachable: false });
  let stderr = "";
  const originalError = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const { output } = captureStdout(() =>
      assert.strictEqual(run(["unblock-auto", "--report", checked.reportPath], root, runner), 2),
    );
    // The trunk moved, so the stop names what it moved to and what the ledger still owes.
    assert.include(output, "Stop (environment).");
    assert.include(output, `hyprws is applied at ${B} and ${CHURN_REF} carries no row for v1.2.3`);
    assert.include(output, "- ledger: unpublished (churn row:");
    assert.notInclude(output, "applied:");
    const stopped = validateReport(JSON.parse(NodeFS.readFileSync(checked.reportPath, "utf8")));
    assert.strictEqual(stopped.walk?.ledger?.state, "unpublished");
    assert.strictEqual(stopped.walk?.stop?.reason, "environment");
    // A single retry, because a refused lease restores the local ref and the next attempt is
    // the same write against a re-read ref.
    assert.strictEqual(stderr.split("retrying the").length - 1, 1);
  } finally {
    process.stderr.write = originalError;
    ledger.restore();
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("walks past a stale mirror line when every leased ref still coheres", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: root },
    installedHead: B,
    ciHead: B,
    // Upstream pushed behind the carried mirror after orient rendered it; the
    // preflight declares mirror currency advisory for a tag-pinned walk, so
    // this stale line must not stop it.
    orientation: `mirror:       origin/main aaaaaaaaaaaa, upstream/main bbbbbbbbbbbb\n`,
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  setOrientationResponses(runner);
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${B}\n` });
  runner.set(
    "git",
    ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { stdout: `${B}\trefs/heads/${branch}\n` },
  );
  runner.set(
    "gh",
    [
      "issue",
      "comment",
      "352",
      "-R",
      "RSI-Software/t3code-hyprws",
      "--body-file",
      checked.recordPath,
    ],
    { stdout: "https://example.test/comment\n" },
  );
  const ledger = ledgerFixture(root, checked.recordPath);
  try {
    const { output, result: code } = captureStdout(() =>
      run(["unblock-auto", "--report", checked.reportPath], root, runner),
    );
    assert.strictEqual(code, 0);
    assert.notInclude(output, "Stop (environment).");
    assert.notInclude(output, "does not mirror upstream/main");
    assert.include(output, "applied: v1.2.3");
  } finally {
    ledger.restore();
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("appends the trunk's own missing row before it walks the next target", () => {
  const root = fixtureRoot();
  const applied = report(root, {
    stage: "applied",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: `rehearse/v1.2.3-from-${C.slice(0, 12)}`, worktree: root },
    installedHead: B,
    ciHead: B,
    orientation: coherentOrientation,
  });
  NodeFS.writeFileSync(applied.reportPath, JSON.stringify(applied));
  NodeFS.writeFileSync(applied.recordPath, renderRecord(applied));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${B}\n` });
  const ledger = ledgerFixture(root, applied.recordPath);
  try {
    const { output } = captureStdout(() =>
      assert.strictEqual(run(["unblock-auto", "--report", applied.reportPath], root, runner), 0),
    );
    assert.include(output, `ledger: appended the missing v1.2.3 row to ${CHURN_REF}`);
    assert.deepStrictEqual(
      parseLedger(readBotRefFile(ledger.remote, CHURN_REF, CHURN_LEDGER_FILE) ?? "").map(
        ({ tag }) => tag,
      ),
      ["v1.2.3"],
    );
  } finally {
    ledger.restore();
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(applied.reportPath), { recursive: true, force: true });
  }
});

it("unblock-auto prints the resume line after an apply refusal", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: root },
    installedHead: B,
    ciHead: B,
    orientation: coherentOrientation,
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  setOrientationResponses(runner);
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${B}\n` });
  runner.set(
    "git",
    ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { stdout: `${B}\trefs/heads/${branch}\n` },
  );
  runner.set("vp", ["run", "fork:upstream-refs", checked.recordPath], {
    status: 1,
    stderr: "apply refused",
  });
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.strictEqual(run(["unblock-auto", "--report", checked.reportPath], root, runner), 1);
    assert.include(stderr, "failed: vp run fork:upstream-refs");
    assert.include(stderr, `report: ${checked.reportPath}\n`);
    runner.set("vp", ["run", "fork:upstream-refs", checked.recordPath], { status: 0 });
    runner.set(
      "git",
      [
        "-c",
        "core.commentChar=auto",
        "push",
        `--force-with-lease=refs/heads/hyprws:${C}`,
        "origin",
        "HEAD:refs/heads/hyprws",
      ],
      { status: 1, stderr: "fixture leased push rejected" },
    );
    assert.strictEqual(run(["unblock-auto", "--report", checked.reportPath], root, runner), 1);
    assert.include(stderr, "leased apply refused");
    const bundle = JSON.parse(
      NodeFS.readFileSync(`${checked.reportPath}.outcome.json`, "utf8"),
    ) as { receipts: Array<{ kind: string; stage?: string; status?: string; detail?: string }> };
    assert.isTrue(
      bundle.receipts.some(
        (row) =>
          row.kind === "stage" &&
          row.stage === "apply" &&
          row.status === "failed" &&
          row.detail?.includes("fixture leased push rejected"),
      ),
    );
  } finally {
    process.stderr.write = original;
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("unblock-apply refuses when origin/hyprws moved", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: root },
    installedHead: B,
    ciHead: B,
    orientation: coherentOrientation,
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  setOrientationResponses(runner, A);
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${B}\n` });
  runner.set(
    "git",
    ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { stdout: `${B}\trefs/heads/${branch}\n` },
  );
  try {
    assert.throws(
      () =>
        execute(
          ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
          root,
          runner,
        ),
      /staleness: origin\/hyprws moved past the report's lease/,
    );
    assert.isFalse(runner.calls.some(({ command }) => command === "vp"));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("refuses a tampered rehearsal lane before apply or deletion", () => {
  const root = fixtureRoot();
  const tampered = report(root, {
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: "rehearse/not-the-bound-lane", worktree: root },
  });
  const runner = new FakeRunner();
  try {
    assert.throws(() => validateAutoLane(tampered, runner), /rehearsal lane mismatch/);
    assert.isFalse(runner.calls.some(({ args }) => args.includes("--delete")));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(tampered.reportPath), { recursive: true, force: true });
  }
});

it("binds a rewrite lane to its own from/origin naming", () => {
  const root = fixtureRoot();
  const rewrite = {
    from: "origin/prepared",
    fromSha: B,
    fromShort: B.slice(0, 12),
    originSha: C,
    originShort: C.slice(0, 12),
    base: A,
    baseToOriginCount: 201,
    baseToFromCount: 201,
    allowExtra: 0,
    allowPaths: [],
    originDigest: "d".repeat(64),
    fromFirstNDigest: "d".repeat(64),
    diffEmpty: true,
    proofs: [],
    archive: {
      ref: `refs/heads/archive/hyprws-pre-rewrite-${C.slice(0, 12)}`,
      sha: C,
    },
  };
  const bound = report(root, {
    kind: "rewrite",
    rewrite,
    lane: { branch: `rehearse/rewrite-${B.slice(0, 12)}-from-${C.slice(0, 12)}`, worktree: root },
  });
  const tampered = report(root, {
    kind: "rewrite",
    rewrite,
    lane: { branch: "rehearse/v1.2.3-from-cccccccccccc", worktree: root },
  });
  const runner = new FakeRunner();
  try {
    validateAutoLane(bound, runner);
    assert.throws(() => validateAutoLane(tampered, runner), /rehearsal lane mismatch/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(bound.reportPath), { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(tampered.reportPath), { recursive: true, force: true });
  }
});

it("renders a rewrite record the tag-pinned gate accepts", () => {
  const root = fixtureRoot();
  const rewrite = {
    from: "origin/prepared",
    fromSha: B,
    fromShort: B.slice(0, 12),
    originSha: C,
    originShort: C.slice(0, 12),
    base: A,
    baseTag: "v0.0.38-nightly.20260831.1236",
    archive: {
      ref: `refs/heads/archive/hyprws-pre-rewrite-${C.slice(0, 12)}`,
      sha: C,
    },
    baseToOriginCount: 204,
    baseToFromCount: 205,
    allowExtra: 1,
    allowPaths: ["docs/internals/fork-development.md"],
    originDigest: "d".repeat(64),
    fromFirstNDigest: "d".repeat(64),
    diffEmpty: true,
    proofs: [],
  };
  const checked = report(root, {
    stage: "checked",
    kind: "rewrite",
    source: { sha: C, expectedOld: C, sharedBase: A },
    rewrite,
    lane: { branch: `rehearse/rewrite-${B.slice(0, 12)}-from-${C.slice(0, 12)}`, worktree: root },
    rebasedHead: B,
    stackSize: 205,
  });
  const observed = {
    targetTag: "v0.0.38-nightly.20260831.1236",
    targetSha: A,
    expectedOld: C,
    rebasedHead: B,
    stackSize: "205",
  };
  try {
    const record = renderRecord(checked);
    assert.deepStrictEqual(inspectRecord(record, observed), []);
    assert.include(record, `- Ref: \`refs/heads/archive/hyprws-pre-rewrite-${C.slice(0, 12)}\``);
    assert.include(record, `- SHA: \`${C}\``);
    assert.include(record, "this archive remains as failed-attempt evidence");
    const verified = report(root, {
      ...checked,
      rewrite: {
        ...rewrite,
        archive: {
          ...rewrite.archive,
          verification: { observedSha: C, trunkOutcome: "failed" },
        },
      },
    });
    assert.strictEqual(
      nightlyProposalDigest(renderRecord(verified)),
      nightlyProposalDigest(record),
    );
    assert.strictEqual(
      validateReport(JSON.parse(JSON.stringify(verified))).rewrite?.archive?.sha,
      C,
    );
    const { baseTag: _baseTag, ...untagged } = rewrite;
    const withoutTag = report(root, { ...checked, rewrite: untagged });
    assert.deepStrictEqual(inspectRecord(renderRecord(withoutTag), observed), [
      `Target mismatch: record absent@${A}, checkout v0.0.38-nightly.20260831.1236@${A}`,
    ]);
    NodeFS.rmSync(NodePath.dirname(withoutTag.reportPath), { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(verified.reportPath), { recursive: true, force: true });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("pins the rewrite gate to the release tag at the fork base", () => {
  const root = fixtureRoot();
  const runner = new FakeRunner();
  runner.set("git", ["tag", "--points-at", A], {
    stdout: "hyprws-checkpoint\nv0.0.38-nightly.20260831.1236\n",
  });
  runner.set("git", ["tag", "--points-at", B], { stdout: "hyprws-checkpoint\n" });
  try {
    assert.strictEqual(baseReleaseTag(runner, root, A), "v0.0.38-nightly.20260831.1236");
    assert.throws(() => baseReleaseTag(runner, root, B), /no upstream release tag points at/);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("unblock-auto waits out a RUNNING bot that finishes, and fails loudly at the ceiling", () => {
  const root = fixtureRoot();
  const listed = report(root);
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  const runner = new FakeRunner();
  runner.set("gh", modeArgs, { stdout: "candidate\n" });
  // One short poll, then the run completes on the repoll: the walk waits
  // and then continues past the gate instead of refusing. No real sleep.
  runner.set("sleep", ["30"], { stdout: "" });
  runner.setSequence("gh", runListArgs, [
    { stdout: JSON.stringify([{ ...lastRun, status: "in_progress", conclusion: null }]) },
    { stdout: JSON.stringify([lastRun]) },
  ]);
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    // Past the bot gate, the listed report still needs a target the tracker
    // cannot supply here, so the walk stops on target selection rather than
    // on the bot. The point is the status and the absence of the refusal.
    const code = run(["unblock-auto", "--report", listed.reportPath], root, runner);
    assert.notStrictEqual(code, 3);
    assert.notInclude(stderr, "bot run is in progress");
    assert.isTrue(
      runner.calls.some(({ command, args }) => command === "sleep" && args[0] === "30"),
    );
  } finally {
    process.stderr.write = original;
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("records the push trigger on an applied report instead of dispatching", () => {
  const root = fixtureRoot();
  const applied = report(root, { stage: "applied", installedHead: B });
  NodeFS.writeFileSync(applied.reportPath, JSON.stringify(applied));
  const runner = new FakeRunner();
  try {
    assert.strictEqual(run(["unblock-auto", "--report", applied.reportPath], root, runner), 0);
    assert.isFalse(
      runner.calls.some(({ command, args }) => command === "gh" && args[0] === "workflow"),
    );
    assert.isFalse(runner.calls.some(({ command }) => command === "sleep"));
    const persisted = validateReport(JSON.parse(NodeFS.readFileSync(applied.reportPath, "utf8")));
    assert.deepStrictEqual(persisted.reconciliation, { trigger: "push", sha: B });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(applied.reportPath), { recursive: true, force: true });
  }
});

const withCapturedStderr = (effect: () => void): string => {
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    effect();
  } finally {
    process.stderr.write = original;
  }
  return stderr;
};

const withRunId = (runId: string | undefined, effect: () => void): void => {
  const original = process.env.GITHUB_RUN_ID;
  if (runId === undefined) delete process.env.GITHUB_RUN_ID;
  else process.env.GITHUB_RUN_ID = runId;
  try {
    effect();
  } finally {
    if (original === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = original;
  }
};

it("unblock-auto --bot-carried accepts the run that holds the lease", () => {
  const root = fixtureRoot();
  const listed = { ...report(root), botCarried: true };
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  const runner = new FakeRunner();
  runner.set("gh", modeArgs, { stdout: "on\n" });
  runner.set("gh", runListArgs, {
    stdout: JSON.stringify([
      { ...lastRun, status: "in_progress", conclusion: null, url: "https://example.test/runs/77" },
    ]),
  });
  try {
    // The bot gate passes, so the walk reaches the target selection it has no
    // orientation for and stops there rather than on the carrier check.
    const stderr = withCapturedStderr(() => {
      withRunId("77", () => {
        assert.notStrictEqual(
          run(["unblock-auto", "--report", listed.reportPath], root, runner),
          3,
        );
      });
    });
    assert.notInclude(stderr, "auto-rebase bot mode is on");
    assert.notInclude(stderr, "holds the lease");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("unblock-auto --bot-carried refuses when another run holds the lease", () => {
  const root = fixtureRoot();
  const listed = { ...report(root), botCarried: true };
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  const runner = new FakeRunner();
  runner.set("gh", modeArgs, { stdout: "on\n" });
  runner.set("gh", runListArgs, {
    stdout: JSON.stringify([
      { ...lastRun, status: "in_progress", conclusion: null, url: "https://example.test/runs/99" },
    ]),
  });
  try {
    const stderr = withCapturedStderr(() => {
      withRunId("77", () => {
        assert.strictEqual(run(["unblock-auto", "--report", listed.reportPath], root, runner), 3);
      });
    });
    assert.include(stderr, "another auto-rebase run holds the lease: https://example.test/runs/99");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("unblock-auto --bot-carried refuses outside the workflow", () => {
  const root = fixtureRoot();
  const listed = { ...report(root), botCarried: true };
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  const runner = new FakeRunner();
  setBotResponses(runner, "on");
  try {
    const stderr = withCapturedStderr(() => {
      withRunId(undefined, () => {
        assert.strictEqual(run(["unblock-auto", "--report", listed.reportPath], root, runner), 3);
      });
    });
    assert.include(stderr, "GITHUB_RUN_ID is unset");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("unblock-auto --bot-carried refuses to resume a human-lane report", () => {
  const root = fixtureRoot();
  const listed = report(root);
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
  const runner = new FakeRunner();
  setBotResponses(runner, "on");
  try {
    const stderr = withCapturedStderr(() => {
      withRunId("77", () => {
        assert.strictEqual(
          run(["unblock-auto", "--bot-carried", "--report", listed.reportPath], root, runner),
          2,
        );
      });
    });
    assert.include(stderr, "--bot-carried cannot continue a report the human lane started");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("lists a pinned target without requiring mirror currency", () => {
  const root = fixtureRoot();
  const reportPath = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-out-")),
    "report.json",
  );
  const runner = new FakeRunner();
  setListResponses(runner, root);
  setBotResponses(runner, "on");
  runner.set("gh", runListArgs, {
    stdout: JSON.stringify([
      { ...lastRun, status: "in_progress", conclusion: null, url: "https://example.test/runs/77" },
    ]),
  });
  try {
    // The carry pushes the mirror itself and upstream can advance behind it, so
    // the walk it pinned must not fail on a mirror it no longer matches. The
    // walk stops later for want of orientation; only the list step is asserted.
    withCapturedStderr(() => {
      captureStdout(() => {
        withRunId("77", () => {
          run(
            ["unblock-auto", "--bot-carried", "--target", "v1.2.3", "--report", reportPath],
            root,
            runner,
          );
        });
      });
    });
    assert.deepStrictEqual(runner.calls.find(({ command }) => command === "node")?.args, [
      "scripts/fork-preflight.ts",
      "--tag-pinned",
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(reportPath), { recursive: true, force: true });
  }
});

it("returns usage status for an unknown verb", () => {
  assert.strictEqual(run(["nope"], process.cwd(), new FakeRunner()), 2);
});

// The scan typechecks the replayed head, so a tree installed before the replay carried its
// manifests reads exactly like a fresh one. Ordering is the whole guarantee.
const replayedRun = (): {
  runner: FakeRunner;
  root: string;
  worktree: string;
  reportPath: string;
  branch: string;
} => {
  const root = fixtureRoot();
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-lane-"));
  const lock = "lockfileVersion: '9.0'\nimporters:\n  .:\n    specifiers: {}\n";
  NodeFS.writeFileSync(NodePath.join(worktree, "pnpm-lock.yaml"), lock);
  const messages = "feat: one\x1e";
  const branch = "rehearse/v1.2.3-from-cccccccccccc";
  const replayed = report(root, {
    stage: "replayed",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree },
    orientation: coherentOrientation,
    originalMessages: messages,
    originalCount: 1,
  });
  NodeFS.writeFileSync(replayed.reportPath, JSON.stringify(replayed));

  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  setOrientationResponses(runner);
  runner.set("git", ["-c", "core.commentChar=auto", "rev-list", "--count", `${B}..HEAD`], {
    stdout: "1\n",
  });
  runner.set(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "log",
      "--reverse",
      "--topo-order",
      "--format=%B%x1e",
      `${B}..HEAD`,
    ],
    { stdout: messages },
  );
  runner.set("git", ["-c", "core.commentChar=auto", "show", "HEAD:pnpm-lock.yaml"], {
    stdout: lock,
  });
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${A}\n` });
  runner.set(
    "git",
    ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { stdout: `${A}\trefs/heads/${branch}\n` },
  );
  return { runner, root, worktree, reportPath: replayed.reportPath, branch };
};

it("records the stack size a walk replays, per domain and shared file", () => {
  const root = fixtureRoot();
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-lane-"));
  const conflicted = report(root, {
    stage: "conflicts",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: "rehearse/v1.2.3-from-cccccccccccc", worktree },
    orientation: coherentOrientation,
    originalMessages: "feat: one\x1e",
    originalCount: 1,
  });
  NodeFS.writeFileSync(conflicted.reportPath, JSON.stringify(conflicted));
  NodeFS.writeFileSync(conflicted.recordPath, "## Conflicts\n\nNone.\n");
  const runner = new FakeRunner();
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  runner.set("git", rehearsal(["rev-list", "--count", `${B}..HEAD`]), { stdout: "1\n" });
  runner.set(
    "git",
    rehearsal(["log", "--reverse", "--topo-order", "--format=%B%x1e", `${B}..HEAD`]),
    { stdout: "feat: one\x1e" },
  );
  // The size read: the replayed series with its trailers, per-commit numstat with the
  // blank line git puts after the format header, and both net diffs.
  runner.set("git", rehearsal([...forkLogArguments(B, "HEAD")]), {
    stdout: `\x1e${A}\x1f${A.slice(0, 7)}\x1f2026-09-09T14:28:59+12:00\x1ffeat: one\x1fFork-Domain: zmux-estate\nFork-Tier: core\n\x1e`,
  });
  runner.set("git", rehearsal([...commitNumstatArguments([A])]), {
    stdout: `\x1e${A}\n\n3\t1\tapps/web/src/app.ts\n2\t0\tpackages/shared/src/upstream.ts\n`,
  });
  runner.set(
    "git",
    rehearsal(["-c", "core.quotePath=false", "diff", "--name-only", `${B}..HEAD`]),
    { stdout: "apps/web/src/app.ts\npackages/shared/src/upstream.ts\n" },
  );
  runner.set("git", ["-c", "core.quotePath=false", "diff", "--name-only", `${A}..${B}`], {
    stdout: "packages/shared/src/upstream.ts\n",
  });
  try {
    const replayed = execute(["unblock-rehearse", "--report", conflicted.reportPath], root, runner);
    assert.deepStrictEqual(replayed.walk?.size, {
      commits: 1,
      domains: [{ domain: "zmux-estate", commits: 1, added: 5, deleted: 1, shared: 1 }],
      sharedFiles: 1,
    });
    const summary = walkSummary(replayed);
    assert.include(summary, "- size: 1 fork commits across 1 domains, 1 shared file attributions");
    assert.include(summary, "  - zmux-estate: 1 commits, +5/-1, 1 shared");
    // The upstream half of the shared count is read in the repository, not the lane.
    const upstreamDiff = runner.calls.find(({ args }) => args.includes(`${A}..${B}`));
    assert.strictEqual(upstreamDiff?.cwd, root);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(conflicted.reportPath), { recursive: true, force: true });
  }
});

const setCiSuccess = (runner: FakeRunner, branch: string): void => {
  runner.set(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "hyprws-ci.yml",
      "--branch",
      branch,
      "--json",
      "databaseId,headSha,status,conclusion,url",
      "-R",
      "RSI-Software/t3code-hyprws",
    ],
    {
      stdout: JSON.stringify([
        {
          databaseId: 42,
          headSha: A,
          status: "completed",
          conclusion: "success",
          url: "https://example.test/runs/42",
        },
      ]),
    },
  );
};

const checkedRun = (
  silentSeam?: string,
): {
  runner: FakeRunner;
  root: string;
  worktree: string;
  reportPath: string;
  branch: string;
} => {
  const state = replayedRun();
  setCiSuccess(state.runner, state.branch);
  execute(
    [
      "unblock-check",
      "--report",
      state.reportPath,
      ...(silentSeam === undefined ? [] : ["--silent-seam", silentSeam]),
    ],
    state.root,
    state.runner,
  );
  return state;
};

const order = (runner: FakeRunner, command: string, args: ReadonlyArray<string>): number =>
  runner.calls.findIndex(
    (call) => call.command === command && call.args.join(" ") === args.join(" "),
  );

it("unblock-check persists explicit silent seam evidence", () => {
  const state = checkedRun("apps/desktop/src/preview/Manager.ts=adapt return type:type");
  try {
    const checked = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    assert.deepStrictEqual(checked.silentSeams, [
      {
        path: "apps/desktop/src/preview/Manager.ts",
        summary: "adapt return type",
        touchesBehaviour: false,
      },
    ]);
    assert.include(
      NodeFS.readFileSync(checked.recordPath, "utf8"),
      "`apps/desktop/src/preview/Manager.ts` [type]: adapt return type",
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("keeps distinct evidence once across check, refresh, check and auto resume", () => {
  const input = "apps/a.ts=adapt return type:type";
  const state = checkedRun(input);
  const observations = [
    parseSilentSeam(input),
    parseSilentSeam("apps/a.ts=adapt return type:behaviour"),
    parseSilentSeam("apps/a.ts=preserve focus:type"),
  ];
  try {
    const first = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    execute(["unblock-refresh", "--report", state.reportPath], state.root, state.runner);
    const checked = execute(
      [
        "unblock-check",
        "--report",
        state.reportPath,
        "--silent-seam",
        input,
        "--silent-seam",
        input,
        "--silent-seam",
        "apps/a.ts=adapt return type:behaviour",
        "--silent-seam",
        "apps/a.ts=preserve focus:type",
      ],
      state.root,
      state.runner,
    );
    assert.deepStrictEqual(checked.silentSeams, observations);
    assert.deepStrictEqual(checked.issue, first.issue);
    assert.deepStrictEqual(checked.target, first.target);
    assert.deepStrictEqual(
      parseSilentSeams(NodeFS.readFileSync(checked.recordPath, "utf8")),
      observations,
    );
    const installs = () =>
      state.runner.calls.filter((c) => c.command === "vp" && c.args[0] === "i").length;
    const beforeResume = installs();
    const resumed = captureStdout(() =>
      run(
        ["unblock-auto", "--report", state.reportPath, "--silent-seam", input],
        state.root,
        state.runner,
      ),
    );
    // A behaviour-touching silent seam is evidence, not a gate: the walk carries it and keeps going.
    assert.notStrictEqual(resumed.result, 2);
    assert.notInclude(resumed.output, "Gate 4 refusal");
    assert.strictEqual(installs(), beforeResume);
    const after = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    assert.deepStrictEqual(after.silentSeams, observations);
    assert.deepStrictEqual(
      parseSilentSeams(NodeFS.readFileSync(after.recordPath, "utf8")),
      observations,
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("retains the first observation object and distinguishes exact evidence tuples", () => {
  const first = {
    path: "a=b",
    summary: "c",
    touchesBehaviour: false,
    provenance: { source: "original" },
  };
  const other = { path: "a", summary: "b=c", touchesBehaviour: false };
  const duplicate = { ...first, provenance: { source: "retry" } };
  const result = uniqueSilentSeams([first, duplicate, other, first]);
  assert.strictEqual(result[0], first);
  assert.strictEqual(result[1], other);
  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(first.provenance, { source: "original" });
});

it("retries a failed check without accumulating evidence and normalizes old duplicates", () => {
  const input = "apps/a.ts=adapt return type:type";
  const state = checkedRun(input);
  try {
    const checked = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    // Legacy reports may already contain repeated observations; no history ledger is rewritten.
    NodeFS.writeFileSync(
      state.reportPath,
      JSON.stringify({ ...checked, silentSeams: [parseSilentSeam(input), parseSilentSeam(input)] }),
    );
    execute(["unblock-refresh", "--report", state.reportPath], state.root, state.runner);
    const before = NodeFS.readFileSync(state.reportPath, "utf8");
    const scan = ["run", "--no-cache", "fork:scan", "--target", "v1.2.3"];
    state.runner.set("vp", scan, { status: 1, stderr: "scan failed" });
    assert.throws(
      () =>
        execute(
          ["unblock-check", "--report", state.reportPath, "--silent-seam", input],
          state.root,
          state.runner,
        ),
      /scan failed/,
    );
    const failed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    assert.deepStrictEqual(failed.silentSeams, JSON.parse(before).silentSeams);
    state.runner.set("vp", scan, { status: 0 });
    const retried = execute(
      ["unblock-check", "--report", state.reportPath],
      state.root,
      state.runner,
    );
    assert.deepStrictEqual(retried.silentSeams, [parseSilentSeam(input)]);
    assert.deepStrictEqual(
      parseSilentSeams(NodeFS.readFileSync(retried.recordPath, "utf8")),
      retried.silentSeams,
    );
    assert.deepStrictEqual(retried.source, checked.source);
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("installs the replayed tree before the scan that typechecks it", () => {
  const { runner, root, worktree } = checkedRun();
  try {
    const install = order(runner, "vp", ["i"]);
    const scan = order(runner, "vp", ["run", "--no-cache", "fork:scan", "--target", "v1.2.3"]);
    assert.isAbove(install, -1);
    assert.isAbove(scan, install);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
  }
});

const rewriteReplayedRun = (
  baseTag: string | undefined,
): { runner: FakeRunner; root: string; worktree: string; reportPath: string; branch: string } => {
  const state = replayedRun();
  const branch = `rehearse/rewrite-${B.slice(0, 12)}-from-${C.slice(0, 12)}`;
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  const { target: _target, ...withoutTarget } = replayed as unknown as Record<string, unknown>;
  NodeFS.writeFileSync(
    state.reportPath,
    JSON.stringify({
      ...withoutTarget,
      kind: "rewrite",
      lane: { branch, worktree: state.worktree },
      rewrite: {
        from: "fix/lockfile-drift",
        fromSha: B,
        fromShort: B.slice(0, 12),
        originSha: C,
        originShort: C.slice(0, 12),
        base: A,
        ...(baseTag === undefined ? {} : { baseTag }),
        baseToOriginCount: 1,
        baseToFromCount: 1,
        allowExtra: 0,
        allowPaths: ["pnpm-lock.yaml"],
        originDigest: "d".repeat(64),
        fromFirstNDigest: "d".repeat(64),
        diffEmpty: true,
        proofs: [],
      },
    }),
  );
  state.runner.set(
    "git",
    ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { stdout: `${A}\trefs/heads/${branch}\n` },
  );
  setCiSuccess(state.runner, branch);
  return { ...state, branch };
};

it("refuses legacy rewrite checks without constructor provenance", () => {
  for (const tag of ["v0.0.38-nightly.20260831.1236", undefined]) {
    const state = rewriteReplayedRun(tag);
    try {
      assert.throws(
        () => execute(["unblock-check", "--report", state.reportPath], state.root, state.runner),
        /rewrite construction binding is stale/,
      );
      assert.isFalse(state.runner.calls.some(({ command }) => command === "vp"));
    } finally {
      NodeFS.rmSync(state.root, { recursive: true, force: true });
      NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    }
  }
});

/** A replayed walk whose in-lane repair covers one workspace. */
const repairingRun = (): ReturnType<typeof replayedRun> => {
  const state = replayedRun();
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  NodeFS.writeFileSync(
    state.reportPath,
    JSON.stringify({ ...replayed, touchedPaths: ["scripts/fork-sync.ts"] }),
  );
  return state;
};

it("stops the walk exactly twice: the lane cannot test, or the replay does not hold", () => {
  const cases = [
    {
      result: { status: 127, stderr: "vp: command not found" },
      reason: "environment",
      detail: "The lane cannot test",
    },
    {
      result: { status: 1, stderr: "scripts/fork-sync.ts(12,3): error TS2322" },
      reason: "conflict",
      detail: "The replayed resolutions do not hold",
    },
  ] as const;
  for (const { result, reason, detail } of cases) {
    const state = repairingRun();
    state.runner.set("vp", ["run", "--filter", "./scripts", "typecheck"], result);
    try {
      const { output } = captureStdout(() =>
        withCapturedStderr(() => {
          assert.strictEqual(
            run(["unblock-auto", "--report", state.reportPath], state.root, state.runner),
            2,
          );
        }),
      );
      assert.include(output, `Stop (${reason}). ${detail}`);
      assert.include(output, "vp run --filter ./scripts typecheck");
      const stopped = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
      assert.strictEqual(stopped.walk?.stop?.reason, reason);
      // The stop is on the report the workflow uploads and in the block the issue carries.
      assert.include(output, `- stop (${reason}):`);
      // Nothing applied: a stopped walk never pushes the trunk.
      assert.isFalse(
        state.runner.calls.some(({ args }) =>
          args.some((arg) => arg.startsWith("--force-with-lease=refs/heads/hyprws")),
        ),
      );
    } finally {
      NodeFS.rmSync(state.root, { recursive: true, force: true });
      NodeFS.rmSync(state.worktree, { recursive: true, force: true });
      NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
    }
  }
});

/** Trigger the replay stop of `repairingRun`, with an optional record file seeded beside it. */
const stoppedReplay = (
  seedRecord: boolean,
  fixtureLedger: boolean,
): {
  stderr: string;
  output: string;
  state: ReturnType<typeof repairingRun>;
  recordPath: string;
  restoreLedger?: (() => void) | undefined;
} => {
  const state = repairingRun();
  const recordPath = NodePath.join(NodePath.dirname(state.reportPath), "record.md");
  if (seedRecord)
    NodeFS.writeFileSync(
      recordPath,
      renderRecord(validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")))),
    );
  let restoreLedger: (() => void) | undefined;
  if (fixtureLedger) restoreLedger = ledgerFixture(state.root, recordPath).restore;
  state.runner.set("vp", ["run", "--filter", "./scripts", "typecheck"], {
    status: 1,
    stderr: "scripts/fork-sync.ts(12,3): error TS2322",
  });
  let stderr = "";
  const { output } = captureStdout(() => {
    stderr = withCapturedStderr(() => {
      assert.strictEqual(
        run(["unblock-auto", "--report", state.reportPath], state.root, state.runner),
        2,
      );
    });
  });
  return { stderr, output, state, recordPath, restoreLedger };
};

it("a stopped walk writes its own pending churn row for the stopped tag (#1023)", () => {
  const stopped = stoppedReplay(true, true);
  try {
    // The stop reaches the caller exactly as before the row write existed.
    assert.include(stopped.output, "Stop (conflict). The replayed resolutions do not hold");
    // The pending row reached the seeded ledger ref, bound to the stopped tag, with the elapsed
    // time the stop wrote into its own report.
    const ledger = parseLedger(
      readBotRefFile(stopped.state.root, CHURN_REF, CHURN_LEDGER_FILE) ?? "",
    );
    assert.deepStrictEqual(
      ledger.map((entry) => entry.tag),
      ["v1.2.3"],
    );
    assert.strictEqual(ledger[0]?.pending, true);
    assert.strictEqual(typeof ledger[0]?.elapsedMs, "number");
    assert.isTrue((ledger[0]?.elapsedMs ?? -1) >= 0);
  } finally {
    stopped.restoreLedger?.();
    NodeFS.rmSync(stopped.state.root, { recursive: true, force: true });
    NodeFS.rmSync(stopped.state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(stopped.state.reportPath), { recursive: true, force: true });
  }
});

it("a stop with no record names what the churn write looked for (#1023)", () => {
  const stopped = stoppedReplay(false, false);
  try {
    assert.include(stopped.output, "Stop (conflict). The replayed resolutions do not hold");
    // Not a swallowed failure: the note distinguishes "no record to write from" — naming the
    // path — from a write that ran and failed.
    assert.include(stopped.stderr, "churn row not written: no record to write from at ");
    assert.include(stopped.stderr, stopped.recordPath);
    assert.notInclude(stopped.stderr, "churn row write failed");
    const report = validateReport(
      JSON.parse(NodeFS.readFileSync(stopped.state.reportPath, "utf8")),
    );
    assert.strictEqual(report.walk?.stop?.reason, "conflict");
    assert.isUndefined(report.walk?.ledger);
  } finally {
    NodeFS.rmSync(stopped.state.root, { recursive: true, force: true });
    NodeFS.rmSync(stopped.state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(stopped.state.reportPath), { recursive: true, force: true });
  }
});

it("a failed churn write never changes the stop reason the caller sees (#1023)", () => {
  // The record exists, so the write runs — and the fixture root has no origin, so the leased
  // publish fails. The stop still surfaces with its own reason and its own exit path.
  const stopped = stoppedReplay(true, false);
  try {
    assert.include(stopped.output, "Stop (conflict). The replayed resolutions do not hold");
    assert.include(stopped.stderr, "churn row write failed; the stop reason is unchanged");
    assert.notInclude(stopped.stderr, "no record to write from");
    const report = validateReport(
      JSON.parse(NodeFS.readFileSync(stopped.state.reportPath, "utf8")),
    );
    assert.strictEqual(report.walk?.stop?.reason, "conflict");
    assert.include(report.walk?.stop?.detail ?? "", "The replayed resolutions do not hold");
  } finally {
    NodeFS.rmSync(stopped.state.root, { recursive: true, force: true });
    NodeFS.rmSync(stopped.state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(stopped.state.reportPath), { recursive: true, force: true });
  }
});

const REPAIRED = "e".repeat(40);
const REPAIR_SUBJECT = "chore(fork-sync): typecheck after v1.2.3";
/** The check's delta gate runs the tooling checkout's `fork-delta.ts` against the lane. */
const deltaGateCall = ({
  command,
  args,
}: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}): boolean =>
  command === "node" && (args[0] ?? "").endsWith("fork-delta.ts") && args.includes("--check");

const rehearsal = (args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "-c",
  "core.commentChar=auto",
  ...args,
];

it("attributes a repair to the domain that owns the files it rewrote", () => {
  const runner = new FakeRunner();
  const log = rehearsal(["log", "--format=%x1e%H%x1f%b%x1f", "--name-only", `${B}..HEAD`]);
  runner.set("git", log, {
    stdout:
      `\x1e${C}\x1fFork-Domain: project-windows\nFork-Tier: core\n\x1f\napps/desktop/src/window/DesktopWindow.ts\n` +
      `\x1e${A}\x1fFork-Domain: custom-agents\nFork-Tier: core\n\x1f\napps/web/src/agents/List.tsx\n`,
  });
  assert.strictEqual(
    repairDomain(runner, "/lane", B, ["apps/desktop/src/window/DesktopWindow.ts"]),
    "project-windows",
  );
  // Two domains say nothing about which one the repair belongs to, and a file no fork commit
  // owns says nothing at all, so both are the fork's own bookkeeping.
  assert.strictEqual(
    repairDomain(runner, "/lane", B, [
      "apps/desktop/src/window/DesktopWindow.ts",
      "apps/web/src/agents/List.tsx",
    ]),
    "fork-meta",
  );
  assert.strictEqual(
    repairDomain(runner, "/lane", B, ["packages/shared/src/upstream.ts"]),
    "fork-meta",
  );
});

/** A replayed walk whose repair pass leaves the worktree dirty. */
const dirtyRepairRun = (): ReturnType<typeof replayedRun> => {
  const state = repairingRun();
  // The dirt is the repair battery's, not the operator's: the check's seam commit reads the tree
  // clean at its gate, and the battery dirties it afterwards.
  state.runner.set("git", rehearsal(["status", "--porcelain"]), {
    stdout: " M scripts/fork-sync.ts\n",
  });
  state.runner.setSequence("git", rehearsal(["status", "--porcelain"]), [{ stdout: "" }]);
  state.runner.set("git", rehearsal(["diff", "--cached", "--name-only"]), {
    stdout: "scripts/fork-sync.ts\n",
  });
  state.runner.set(
    "git",
    rehearsal(["log", "--format=%x1e%H%x1f%s%x1f%b%x1f", "--name-only", `${B}..HEAD`]),
    {
      stdout: `\x1e${C}\x1ffeat(fork): owner\x1fFork-Domain: fork-meta\nFork-Tier: core\n\x1f\nscripts/fork-sync.ts\n`,
    },
  );
  state.runner.set("git", rehearsal(["show", "-s", "--format=%H%x1f%s", "HEAD"]), {
    stdout: `${REPAIRED}\x1ffixup! feat(fork): owner\n`,
  });
  // The installed-tree read still sees the replayed head; the guard after the repair sees the
  // commit the walk just appended.
  state.runner.setSequence("git", rehearsal(["rev-parse", "HEAD"]), [
    { stdout: `${A}\n` },
    { stdout: `${REPAIRED}\n` },
    { stdout: `${REPAIRED}\n` },
    { stdout: `${REPAIRED}\n` },
  ]);
  // The replay proof counts the fork series from the message log; the stack size the record
  // binds counts the head.
  state.runner.set("git", rehearsal(["rev-list", "--count", `${B}..HEAD`]), {
    stdout: "2\n",
  });
  return state;
};

it("commits what a repair rewrote as the walk's own attributable commit", () => {
  const state = dirtyRepairRun();
  try {
    const checked = execute(
      ["unblock-check", "--report", state.reportPath],
      state.root,
      state.runner,
    );
    const commits = state.runner.calls.filter(
      ({ command, args }) => command === "git" && args.includes("commit"),
    );
    assert.strictEqual(commits.length, 1);
    const [commit] = commits;
    assert.deepStrictEqual(commit?.args.slice(0, 5), [
      "-c",
      "core.commentChar=auto",
      "commit",
      "--no-verify",
      "-m",
    ]);
    // The walk signs its own commit rather than inheriting whoever ran the command.
    assert.strictEqual(commit?.env?.GIT_AUTHOR_NAME, "github-actions[bot]");
    assert.strictEqual(
      commit?.env?.GIT_AUTHOR_EMAIL,
      "41898282+github-actions[bot]@users.noreply.github.com",
    );
    assert.strictEqual(commit?.env?.GIT_COMMITTER_NAME, "github-actions[bot]");
    assert.strictEqual(
      commit?.env?.GIT_COMMITTER_EMAIL,
      "41898282+github-actions[bot]@users.noreply.github.com",
    );
    const message = commit?.args[5] ?? "";
    assert.strictEqual(message, "fixup! feat(fork): owner");
    assert.notInclude(message, "Fork-");
    assert.isTrue(state.runner.calls.some(({ args }) => args.includes("--autosquash")));
    // The ledger check runs again over the appended commit, in the lane, before the report closes.
    const deltaChecks = state.runner.calls.filter(deltaGateCall);
    assert.strictEqual(deltaChecks.length, 3);

    assert.isUndefined(checked.walk?.repairCommits);
    // What the apply publishes is the repaired head, and the record binds it.
    assert.strictEqual(checked.installedHead, REPAIRED);
    assert.strictEqual(checked.rebasedHead, REPAIRED);
    assert.strictEqual(checked.stackSize, 2);
    const record = NodeFS.readFileSync(checked.recordPath, "utf8");
    assert.deepStrictEqual(parseRepairCommits(record), []);

    // The apply gate accepts the appended commit and still refuses a fork commit that changed.
    const binding = {
      targetTag: "v1.2.3",
      targetSha: B,
      expectedOld: C,
      rebasedHead: REPAIRED,
      stackSize: "2",
    };
    assert.deepStrictEqual(inspectRecord(record, binding), []);
    assert.deepStrictEqual(inspectRecord(record, { ...binding, rebasedHead: A }), [
      `Rebased head mismatch: record ${REPAIRED}, checkout ${A}`,
    ]);
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("formats what the repair rewrote before it commits", () => {
  const state = dirtyRepairRun();
  try {
    execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    const order = state.runner.calls.filter(
      ({ command, args }) =>
        (command === "vp" && args[0] === "fmt") ||
        (command === "git" && (args.includes("add") || args.includes("commit"))),
    );
    const formatted = order.findIndex(({ command }) => command === "vp");
    assert.notStrictEqual(formatted, -1, "the repair commit ran no formatter");
    // The formatter reads exactly the paths the repair staged — the conflict-time format ran long
    // before these files were rewritten.
    assert.deepStrictEqual(order[formatted]?.args, [
      "fmt",
      "--no-error-on-unmatched-pattern",
      "scripts/fork-sync.ts",
    ]);
    // What it rewrote is re-staged and committed, not left behind for trunk's `vp check` to find.
    assert.isTrue(order.slice(formatted + 1).some(({ args }) => args.includes("add")));
    assert.isTrue(order.slice(formatted + 1).some(({ args }) => args.includes("commit")));
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("adds no commit when the repair pass rewrote nothing", () => {
  const state = repairingRun();
  try {
    const checked = execute(
      ["unblock-check", "--report", state.reportPath],
      state.root,
      state.runner,
    );
    assert.isFalse(
      state.runner.calls.some(({ command, args }) => command === "git" && args.includes("commit")),
    );
    assert.isUndefined(checked.walk?.repairCommits);
    assert.strictEqual(checked.installedHead, A);
    // A clean walk binds nothing: the report and record stay byte-identical to the rehearsal's.
    assert.isUndefined(checked.rebasedHead);
    assert.isUndefined(checked.stackSize);
    const record = NodeFS.readFileSync(checked.recordPath, "utf8");
    assert.deepStrictEqual(parseRepairCommits(record), []);
    assert.include(record, "## Repair commits\n\nNone.");
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

/** A replayed walk that arrives at the check with a hand-repaired, dirty lane (`--silent-seam`). */
const seamRepairedRun = (): ReturnType<typeof replayedRun> & { seamSha: string } => {
  const state = repairingRun();
  const seamSha = "d".repeat(40);
  // The lane is dirty when the check opens and the seam commit cleans it; the battery afterwards
  // sees a clean tree and adds nothing.
  state.runner.setSequence("git", rehearsal(["status", "--porcelain"]), [
    { stdout: " M apps/web/src/Fix.tsx\n" },
  ]);
  state.runner.set("git", rehearsal(["diff", "--cached", "--name-only"]), {
    stdout: "apps/web/src/Fix.tsx\n",
  });
  state.runner.set("git", rehearsal(["show", "-s", "--format=%H%x1f%s", "HEAD"]), {
    stdout: `${seamSha}\x1ffixup! feat: fork work\n`,
  });
  // The repaired path is owned by the replayed fork commit `feat: fork work` (sha C).
  state.runner.set(
    "git",
    rehearsal(["log", "--format=%x1e%H%x1f%s%x1f%b%x1f", "--name-only", `${B}..HEAD`]),
    {
      stdout: `\x1e${C}\x1ffeat: fork work\x1fFork-Domain: fork-meta\nFork-Tier: qol\n\x1f\napps/web/src/Fix.tsx\n`,
    },
  );
  state.runner.setSequence("git", rehearsal(["rev-parse", "HEAD"]), [
    { stdout: `${A}\n` },
    ...Array.from({ length: 6 }, () => ({ stdout: `${seamSha}\n` })),
  ]);
  // The proof counts the fork series (1) and then the head with the seam commit on it (2).
  state.runner.setSequence("git", rehearsal(["rev-list", "--count", `${B}..HEAD`]), [
    { stdout: "1\n" },
    { stdout: "2\n" },
  ]);
  return { ...state, seamSha };
};

it("commits a hand-repaired lane as a seam fixup before the additive proof runs", () => {
  const state = seamRepairedRun();
  try {
    const checked = execute(
      ["unblock-check", "--report", state.reportPath],
      state.root,
      state.runner,
    );
    const commits = state.runner.calls.filter(
      ({ command, args }) => command === "git" && args.includes("commit"),
    );
    // Exactly one commit, the seam's fixup, targeting the owning fork commit by subject.
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0]?.args[5], "fixup! feat: fork work");
    // The seam proof runs in the lane between the commit and the additive phase, with the
    // tooling checkout's fork-delta executed against the lane worktree.
    for (const call of state.runner.calls.filter(deltaGateCall))
      assert.strictEqual(call.cwd, state.worktree);
    const commitAt = state.runner.calls.findIndex(({ args }) => args.includes("commit"));
    const deltaChecks = state.runner.calls.filter(deltaGateCall);
    const seamProofAt = state.runner.calls.indexOf(deltaChecks[1]!);
    assert.isTrue(seamProofAt > commitAt, "the seam commit must precede its delta proof");
    assert.strictEqual(deltaChecks.length, 3);
    // The head binding follows the seam commit — the additive proof and every later guard read
    // the head that contains the operator's repairs. The fixup itself is filtered once
    // autosquash folds it into its owner.
    assert.isUndefined(checked.walk?.repairCommits);
    assert.isTrue(
      state.runner.calls.some(({ args }) => args.includes("--autosquash")),
      "the seam fixup produced no autosquash",
    );
    assert.strictEqual(checked.installedHead, state.seamSha);
    assert.strictEqual(checked.stage, "checked");
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("an ownerless seam path stops the walk and names the path", () => {
  const state = seamRepairedRun();
  // No fork commit in the stubbed stack touches the repaired path.
  state.runner.set(
    "git",
    rehearsal(["log", "--format=%x1e%H%x1f%s%x1f%b%x1f", "--name-only", `${B}..HEAD`]),
    { stdout: "" },
  );
  try {
    let detail = "";
    try {
      execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    } catch (error) {
      detail = String(
        (error as { failure?: { detail?: string } }).failure?.detail ?? (error as Error).message,
      );
    }
    assert.include(detail, "no fork commit in the replayed stack owns apps/web/src/Fix.tsx");
    assert.include(detail, "--seam-owner");
    assert.isFalse(
      state.runner.calls.some(({ args }) => args.includes("commit")),
      "an ownerless repair must refuse before any git mutation",
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("--seam-owner declares the owner of a path no fork commit touched", () => {
  const state = seamRepairedRun();
  // The stack's owner map is empty: the declared owner is the only resolution.
  state.runner.set(
    "git",
    rehearsal(["log", "--format=%x1e%H%x1f%s%x1f%b%x1f", "--name-only", `${B}..HEAD`]),
    { stdout: "" },
  );
  state.runner.set("git", rehearsal(["show", "-s", "--format=%s", C]), {
    stdout: "feat: fork work\n",
  });
  state.runner.set("git", rehearsal(["show", "-s", "--format=%B", C]), {
    stdout: "feat: fork work\n\nFork-Domain: fork-meta\nFork-Tier: qol\n",
  });
  state.runner.set("git", rehearsal(["show", "-s", "--format=%H%x1f%s", "HEAD"]), {
    stdout: `${state.seamSha}\x1ffixup! feat: fork work\n`,
  });
  try {
    const checked = execute(
      ["unblock-check", "--report", state.reportPath, "--seam-owner", `apps/web/src/Fix.tsx=${C}`],
      state.root,
      state.runner,
    );
    const commits = state.runner.calls.filter(
      ({ command, args }) => command === "git" && args.includes("commit"),
    );
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0]?.args[5], "fixup! feat: fork work");
    assert.strictEqual(checked.stage, "checked");
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("a fixup whose owner diff fails the delta stops the check after the autosquash", () => {
  const state = seamRepairedRun();
  // The gate and the seam proof pass while the repair is a transient fixup; the post-autosquash
  // proof reads the owner diff the walk will apply, and the stubbed wire-shape failure stops it.
  const deltaKey = toolingDeltaCheck().args;
  state.runner.setSequence("node", deltaKey, [
    { status: 0, stdout: "", stderr: "" },
    { status: 0, stdout: "", stderr: "" },
    { status: 1, stdout: "", stderr: "failed: owner diff violates the wire shape\n" },
  ]);
  try {
    let message = "";
    try {
      execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "fork-delta.ts --check");
    assert.include(message, "wire shape");
    // The failing proof ran after the autosquash, on the folded stack.
    const autosquashAt = state.runner.calls.findIndex(({ args }) => args.includes("--autosquash"));
    const failingDelta = state.runner.calls.filter(deltaGateCall)[2]!;
    assert.isTrue(
      state.runner.calls.indexOf(failingDelta) > autosquashAt,
      "the post-autosquash delta proof must follow the autosquash",
    );
    assert.strictEqual(
      validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8"))).stage,
      "replayed",
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("--seam-owner naming a sha that is not a fork commit in the stack is a UsageError", () => {
  const state = seamRepairedRun();
  const foreign = "f".repeat(40);
  state.runner.set("git", ["cat-file", "-e", `${foreign}^{commit}`], { status: 1 });
  try {
    assert.throws(
      () =>
        execute(
          [
            "unblock-check",
            "--report",
            state.reportPath,
            "--seam-owner",
            `apps/web/src/Fix.tsx=${foreign}`,
          ],
          state.root,
          state.runner,
        ),
      /is not a fork commit in/,
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("a rerun proves the replay through the fixups a stopped run left and folds them", () => {
  const state = repairingRun();
  const retained = "d".repeat(40);
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  NodeFS.writeFileSync(
    state.reportPath,
    JSON.stringify({
      ...replayed,
      walk: { repairCommits: [{ sha: retained, subject: "fixup! feat: one" }] },
    }),
  );
  // The lane carries the fixup after the replayed fork commit; the count proof must see through it.
  state.runner.set(
    "git",
    rehearsal(["log", "--reverse", "--topo-order", "--format=%B%x1e", `${B}..HEAD`]),
    { stdout: `feat: one\x1efixup! feat: one\n\x1e` },
  );
  try {
    const checked = execute(
      ["unblock-check", "--report", state.reportPath],
      state.root,
      state.runner,
    );
    assert.strictEqual(checked.stage, "checked");
    assert.isTrue(
      state.runner.calls.some(({ args }) => args.includes("--autosquash")),
      "the retained fixup produced no autosquash",
    );
    assert.isUndefined(checked.walk?.repairCommits);
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("the check runs a tracked fork test outside the touched workspaces", () => {
  const state = repairingRun();
  state.runner.set("git", rehearsal(["ls-files", "*.fork.test.ts", "*.fork.test.tsx"]), {
    stdout: "scripts/dev-desktop-task-graph.fork.test.ts\n",
  });
  try {
    const checked = execute(
      ["unblock-check", "--report", state.reportPath],
      state.root,
      state.runner,
    );
    assert.strictEqual(checked.stage, "checked");
    assert.isTrue(
      state.runner.calls.some(
        ({ command, args }) =>
          command === "vp" &&
          args[0] === "test" &&
          args.includes("dev-desktop-task-graph.fork.test.ts"),
      ),
      "the fork-owned test was never run",
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("a Fork-Repair commit's paths enter the formatter scope", () => {
  const state = repairingRun();
  const hand = "e".repeat(40);
  state.runner.set(
    "git",
    rehearsal(["log", "--format=%x1e%H%x1f%s%x1f%b%x1f", "--name-only", `${B}..HEAD`]),
    {
      stdout:
        `\x1e${hand}\x1fchore(fork): refresh workflow reviews for v1.2.3\x1f` +
        `Fork-Domain: fork-meta\nFork-Tier: qol\nFork-Repair: hand\n\x1f.github/fork-workflow-reviews.json\n`,
    },
  );
  try {
    execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    assert.isTrue(
      state.runner.calls.some(
        ({ command, args }) =>
          command === "vp" && args.includes(".github/fork-workflow-reviews.json"),
      ),
      "the hand repair's path was never formatted",
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("a clean lane runs no formatter pass and keeps the report byte-identical", () => {
  const state = repairingRun();
  state.runner.set("git", rehearsal(["ls-files", "*.fork.test.ts", "*.fork.test.tsx"]), {
    stdout: "",
  });
  try {
    const checked = execute(
      ["unblock-check", "--report", state.reportPath],
      state.root,
      state.runner,
    );
    assert.strictEqual(checked.stage, "checked");
    assert.isUndefined(
      state.runner.calls.find(({ command, args }) => command === "vp" && args[0] === "fmt"),
      "the check-level formatter ran on a clean lane",
    );
    // The battery and its recorded rows are exactly what a clean run always produced.
    // The battery rows are the walk's own full sequence, unchanged from a run before the
    // fork-test and formatter extensions: the new steps record nothing extra on a clean lane.
    assert.deepStrictEqual(
      checked.walk?.repairs?.map(({ command }) => command),
      [
        "vp run --no-cache fork:scan --target v1.2.3",
        // Derive the delta row the way the record does, so the expectation holds wherever the
        // repository is checked out.
        `node ${toolingDeltaCheck().args[0]} --check`,
        "vp run --filter ./scripts typecheck",
      ],
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("discovers an unrecorded fixup on the lane and folds it", () => {
  const state = repairingRun();
  const unrecorded = "d".repeat(40);
  // No `walk.repairCommits` names this fixup: a run stopped between committing the fixup and
  // writing the report. The check must still find it on the lane and autosquash it away.
  state.runner.set(
    "git",
    rehearsal(["log", "--format=%x1e%H%x1f%s%x1f%b%x1f", "--name-only", `${B}..HEAD`]),
    {
      stdout:
        `\x1e${unrecorded}\x1ffixup! feat: one\x1f\x1fscripts/fork-sync.ts\n` +
        `\x1e${A}\x1ffeat: one\x1f\x1fscripts/fork-sync.ts\n`,
    },
  );
  state.runner.set("git", rehearsal(["log", "--format=%s", `${B}..HEAD`]), {
    stdout: "feat: one\n",
  });
  try {
    const checked = execute(
      ["unblock-check", "--report", state.reportPath],
      state.root,
      state.runner,
    );
    assert.strictEqual(checked.stage, "checked");
    assert.isTrue(
      state.runner.calls.some(({ args }) => args.includes("--autosquash")),
      "the unrecorded fixup produced no autosquash",
    );
    assert.isUndefined(checked.walk?.repairCommits);
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("an orphan fixup on the lane stops the check naming it", () => {
  const state = repairingRun();
  const orphan = "d".repeat(40);
  state.runner.set(
    "git",
    rehearsal(["log", "--format=%x1e%H%x1f%s%x1f%b%x1f", "--name-only", `${B}..HEAD`]),
    {
      stdout:
        `\x1e${orphan}\x1ffixup! no such owner\x1f\x1fscripts/fork-sync.ts\n` +
        `\x1e${A}\x1ffeat: one\x1f\x1fscripts/fork-sync.ts\n`,
    },
  );
  try {
    assert.throws(
      () => execute(["unblock-check", "--report", state.reportPath], state.root, state.runner),
      /orphan fixup on the lane: "fixup! no such owner" has no owning fork commit/,
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("an autosquash that changes the tree stops the walk naming both trees", () => {
  const state = repairingRun();
  const retained = "d".repeat(40);
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  NodeFS.writeFileSync(
    state.reportPath,
    JSON.stringify({
      ...replayed,
      walk: { repairCommits: [{ sha: retained, subject: "fixup! feat: one" }] },
    }),
  );
  state.runner.setSequence("git", rehearsal(["rev-parse", "HEAD^{tree}"]), [
    { stdout: "1111111111111111111111111111111111111111\n" },
    { stdout: "2222222222222222222222222222222222222222\n" },
  ]);
  try {
    assert.throws(
      () => execute(["unblock-check", "--report", state.reportPath], state.root, state.runner),
      /the autosquashed lane's tree changed: tested 1{40}, landed 2{40}/,
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("an autosquash conflict aborts, restores the lane head, and names the paths", () => {
  const state = repairingRun();
  const retained = "d".repeat(40);
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  NodeFS.writeFileSync(
    state.reportPath,
    JSON.stringify({
      ...replayed,
      walk: { repairCommits: [{ sha: retained, subject: "fixup! feat: one" }] },
    }),
  );
  state.runner.setSequence(
    "git",
    rehearsal(["rev-parse", "HEAD"]),
    [...Array(8)].map(() => ({ stdout: `${A}\n` })),
  );
  state.runner.set("git", rehearsalRebaseArgs(["rebase", "--interactive", "--autosquash", B]), {
    status: 1,
    stderr: "could not apply abc123... feat: one\n",
  });
  state.runner.set("git", rehearsal(["diff", "--name-only", "--diff-filter=U"]), {
    stdout: "scripts/fork-sync.ts\n",
  });
  try {
    assert.throws(
      () => execute(["unblock-check", "--report", state.reportPath], state.root, state.runner),
      /autosquash rebase conflicted on scripts\/fork-sync\.ts; the lane was restored to/,
    );
    assert.isTrue(
      state.runner.calls.some(({ args }) => args.includes("--abort")),
      "the conflicted rebase was never aborted",
    );
    assert.isTrue(
      state.runner.calls.some(({ args }) => args.includes("reset") && args.includes("--hard")),
      "the lane head was never restored",
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("an owner shadowed by a same-subject newer commit refuses the repair", () => {
  const state = seamRepairedRun();
  // Two declared fork commits share the subject; the newer owns the repaired path, but the older
  // would still be the oldest subject match in the autosquash todo.
  const shadowed = "e".repeat(40);
  state.runner.set(
    "git",
    rehearsal(["log", "--format=%x1e%H%x1f%s%x1f%b%x1f", "--name-only", `${B}..HEAD`]),
    {
      stdout:
        `\x1e${C}\x1ffeat: fork work\x1fFork-Domain: fork-meta\nFork-Tier: qol\n\x1f\napps/web/src/Fix.tsx\n` +
        `\x1e${shadowed}\x1ffeat: fork work\x1fFork-Domain: fork-meta\nFork-Tier: qol\n\x1f\napps/web/src/Other.tsx\n`,
    },
  );
  try {
    let detail = "";
    try {
      execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    } catch (error) {
      detail = String(
        (error as { failure?: { detail?: string } }).failure?.detail ?? (error as Error).message,
      );
    }
    assert.include(detail, 'duplicated subject: "feat: fork work"');
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("a retained repair sha unreachable from HEAD is pruned and folds nothing", () => {
  const state = repairingRun();
  const dead = "d".repeat(40);
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  NodeFS.writeFileSync(
    state.reportPath,
    JSON.stringify({
      ...replayed,
      walk: { repairCommits: [{ sha: dead, subject: "fixup! feat: one" }] },
    }),
  );
  // The autosquash of the stopped run rewrote the sha out of existence.
  state.runner.set("git", ["cat-file", "-e", `${dead}^{commit}`], { status: 1 });
  try {
    const checked = execute(
      ["unblock-check", "--report", state.reportPath],
      state.root,
      state.runner,
    );
    assert.strictEqual(checked.stage, "checked");
    // The dead sha does not count toward the fixup gate: no autosquash, nothing reportable.
    assert.isFalse(
      state.runner.calls.some(({ args }) => args.includes("--autosquash")),
      "a dead retained sha must not trigger autosquash",
    );
    assert.isUndefined(checked.walk?.repairCommits);
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("stale --seam-owner flags on a clean tree are not a usage error", () => {
  const state = repairingRun();
  const foreign = "f".repeat(40);
  state.runner.set("git", ["cat-file", "-e", `${foreign}^{commit}`], { status: 1 });
  try {
    const checked = execute(
      [
        "unblock-check",
        "--report",
        state.reportPath,
        "--seam-owner",
        `apps/web/src/Gone.tsx=${foreign}`,
      ],
      state.root,
      state.runner,
    );
    assert.strictEqual(checked.stage, "checked");
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("re-checking a checked lane preserves the proposer and rebinds stale head bindings", () => {
  const state = repairingRun();
  try {
    const first = execute(
      ["unblock-check", "--report", state.reportPath],
      state.root,
      state.runner,
    );
    // Seed what only a first pass would have bound, as a nightly sign-off would have, plus head
    // bindings left stale by an earlier run's autosquash (the lane head it does not name).
    const seeded = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    NodeFS.writeFileSync(
      state.reportPath,
      JSON.stringify({
        ...seeded,
        proposedBy: { iface: "claude", provider: "anthropic", model: "test", session: "s1" },
        silentSeams: [
          { path: "apps/web/src/Kept.tsx", summary: "kept seam", touchesBehaviour: true },
        ],
        rebasedHead: "9".repeat(40),
        stackSize: 290,
      }),
    );
    const second = execute(
      [
        "unblock-check",
        "--report",
        state.reportPath,
        "--silent-seam",
        "apps/web/src/Kept.tsx=kept seam:behaviour",
      ],
      state.root,
      state.runner,
    );
    assert.strictEqual(second.stage, "checked");
    assert.strictEqual(second.installedHead, first.installedHead);
    assert.deepStrictEqual(second.proposedBy, {
      iface: "claude",
      provider: "anthropic",
      model: "test",
      session: "s1",
    });
    assert.deepStrictEqual(second.silentSeams, [
      { path: "apps/web/src/Kept.tsx", summary: "kept seam", touchesBehaviour: true },
    ]);
    const recordAfter = NodeFS.readFileSync(seeded.recordPath, "utf8");
    // The stale bindings follow the lane: head and recounted stack size, in report and record.
    assert.strictEqual(second.rebasedHead, first.installedHead);
    assert.strictEqual(second.stackSize, 1);
    assert.include(recordAfter, `- Rebased head: \`${first.installedHead}\``);
    assert.include(recordAfter, "- Stack size: `1` fork commits");
    assert.notInclude(recordAfter, "9".repeat(40));
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("a re-declared silent seam replaces its row by path and keeps the others", () => {
  const state = repairingRun();
  try {
    execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    const seeded = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    NodeFS.writeFileSync(
      state.reportPath,
      JSON.stringify({
        ...seeded,
        silentSeams: [
          { path: "apps/web/src/Old.tsx", summary: "old wording", touchesBehaviour: false },
          { path: "apps/web/src/Kept.tsx", summary: "kept seam", touchesBehaviour: true },
        ],
      }),
    );
    const checked = execute(
      [
        "unblock-check",
        "--report",
        state.reportPath,
        "--silent-seam",
        "apps/web/src/Old.tsx=new wording:type",
      ],
      state.root,
      state.runner,
    );
    assert.deepStrictEqual(checked.silentSeams, [
      { path: "apps/web/src/Kept.tsx", summary: "kept seam", touchesBehaviour: true },
      { path: "apps/web/src/Old.tsx", summary: "new wording", touchesBehaviour: false },
    ]);
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("a rewrite at checked is still refused", () => {
  const root = fixtureRoot();
  const rewrite = report(root, {
    stage: "checked",
    kind: "rewrite",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: `rehearse/v1.2.3-from-${C.slice(0, 12)}`, worktree: root },
  });
  NodeFS.writeFileSync(rewrite.reportPath, JSON.stringify(rewrite));
  const runner = new FakeRunner();
  try {
    assert.throws(
      () => execute(["unblock-check", "--report", rewrite.reportPath], root, runner),
      /unblock-check requires replayed state, got checked/,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(rewrite.reportPath), { recursive: true, force: true });
  }
});

it("a fold segment matching the stack more than once stops the walk", () => {
  const state = repairingRun();
  const retained = "d".repeat(40);
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  const segment = (onto: string) => ({
    from: "1".repeat(40),
    to: "2".repeat(40),
    onto,
    originalCount: 1,
    originalMessages: "x\x1e",
  });
  NodeFS.writeFileSync(
    state.reportPath,
    JSON.stringify({
      ...replayed,
      folds: [segment(C), segment(C), segment(C)],
      walk: { repairCommits: [{ sha: retained, subject: "fixup! feat: one" }] },
    }),
  );
  // Baseline `feat: one` followed by three identical `x` landings: any segment's single-message
  // block matches three positions, so relocation cannot tell them apart.
  state.runner.set(
    "git",
    rehearsal(["log", "--reverse", "--topo-order", "--format=%B%x1e", `${B}..HEAD`]),
    { stdout: `feat: one\x1ex\x1ex\x1ex\x1e` },
  );
  state.runner.set(
    "git",
    rehearsal(["log", "--reverse", "--topo-order", "--format=%H%x1f%B%x1e", `${B}..HEAD`]),
    {
      stdout: `${A}\x1ffeat: one\n\x1e${C}\x1fx\n\x1e${"4".repeat(40)}\x1fx\n\x1e${"5".repeat(40)}\x1fx\n\x1e`,
    },
  );
  try {
    let message = "";
    try {
      execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /matches the autosquashed stack more than once/);
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

/**
 * A real walk over real Git: an upstream history with a previous base and a tagged target, an old
 * trunk whose `feat: one` fork commit drifts, a bare origin carrying `hyprws` and the churn ref,
 * and a replayed lane. gh and vp are stubbed, so nothing leaves the machine and no install runs.
 * The drift shapes decide what the purely-additive check finds: a re-added upstream line repairs
 * and applies; a shrunk upstream test stops the walk.
 */
const ADDITIVE_TAG = "v1.2.3-nightly.20260831.2";

/** Real git in a fixture directory, for the tests to assert on the walk's outcome. */
const additiveGit = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, { cwd }).toString().trim();

class AdditiveWalkRunner {
  private readonly fake = new FakeRunner();
  private readonly real = new SystemRunner();
  run(
    command: string,
    args: ReadonlyArray<string>,
    cwd?: string,
    input?: string,
    env?: NodeJS.ProcessEnv,
  ): CommandResult {
    return command === "git"
      ? this.real.run(command, args, cwd ?? ".", input, env)
      : this.fake.run(command, args, cwd ?? ".", input, env);
  }
  set(...args: Parameters<FakeRunner["set"]>): void {
    this.fake.set(...args);
  }
}

const additiveWalkFixture = (
  drift: ReadonlyArray<readonly [string, string]>,
): {
  runner: AdditiveWalkRunner;
  root: string;
  lane: string;
  remote: string;
  reportPath: string;
  recordPath: string;
  branch: string;
  target: string;
  expectedOld: string;
  restoreLedger: () => void;
} => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-additive-root-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
    NodeChildProcess.execFileSync("git", args, { cwd, env }).toString().trim();
  const write = (directory: string, path: string, contents: string): void => {
    NodeFS.mkdirSync(NodePath.join(directory, NodePath.dirname(path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, path), contents);
  };
  git(root, "init", "-q", "-b", "fixture");
  git(root, "config", "user.name", "fixture");
  git(root, "config", "user.email", "fixture@example.test");
  write(
    root,
    ".github/workflows/hyprws-upstream-sync.yml",
    'on:\n  schedule:\n    - cron: "23 */4 * * *"\n',
  );
  // Previous upstream base.
  write(
    root,
    "apps/web/src/thing.ts",
    "export const keep = 1;\nexport const stale = () => {\n  return 1;\n};\n",
  );
  write(root, "apps/web/src/thing.test.ts", 'it("first", () => {});\nit("second", () => {});\n');
  write(root, "apps/server/src/persistence/Migrations/001_Base.ts", "export default 1;\n");
  write(
    root,
    "apps/server/src/persistence/Migrations.ts",
    [
      'import Migration0001 from "./Migrations/001_Base.ts";',
      "",
      "export const migrationEntries = [",
      '  [1, "Base", Migration0001],',
      "];",
      "",
    ].join("\n"),
  );
  write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "upstream: base");
  const previous = git(root, "rev-parse", "HEAD");
  // The old trunk: c0 plus the fork commit that will drift on the target.
  git(root, "checkout", "-q", "-b", "trunk");
  write(root, "apps/web/src/fork.ts", "export const forkOnly = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "feat: one");
  const expectedOld = git(root, "rev-parse", "HEAD");
  // The target: upstream deletes the stale hunk and grows tests, files and migrations.
  git(root, "checkout", "-q", "fixture");
  write(root, "apps/web/src/thing.ts", "export const keep = 1;\n");
  write(
    root,
    "apps/web/src/thing.test.ts",
    'it("first", () => {});\nit("second", () => {});\nit("third", () => {});\n',
  );
  write(root, "apps/web/src/gone.ts", "export const gone = 1;\n");
  write(root, "apps/server/src/persistence/Migrations/002_Upstream.ts", "export default 2;\n");
  write(
    root,
    "apps/server/src/persistence/Migrations.ts",
    [
      'import Migration0001 from "./Migrations/001_Base.ts";',
      'import Migration0002 from "./Migrations/002_Upstream.ts";',
      "",
      "export const migrationEntries = [",
      '  [1, "Base", Migration0001],',
      '  [2, "Upstream", Migration0002],',
      "];",
      "",
    ].join("\n"),
  );
  git(root, "add", "-A");
  git(root, "commit", "-m", "upstream: grow");
  git(root, "tag", ADDITIVE_TAG);
  const target = git(root, "rev-parse", "HEAD");
  // Bare origin: hyprws at the old trunk, plus the seeded churn ref.
  const remote = NodePath.join(root, "origin.git");
  git(root, "init", "-q", "--bare", remote);
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "origin", "trunk:refs/heads/hyprws");
  writeBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE, "[]\n", "churn: fixture");
  git(root, "push", "-q", "origin", `${CHURN_REF}:${CHURN_REF}`);
  git(root, "fetch", "-q", "origin");
  // The replayed lane: the target plus the drifted fork commit, clean, on its own branch.
  const lane = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-additive-lane-"));
  git(root, "clone", "-q", root, lane);
  const branch = `rehearse/${ADDITIVE_TAG}-from-${expectedOld.slice(0, 12)}`;
  git(lane, "checkout", "-q", "-B", branch, target);
  git(lane, "config", "user.name", "fixture");
  git(lane, "config", "user.email", "fixture@example.test");
  for (const [path, contents] of drift) write(lane, path, contents);
  git(lane, "add", "-A");
  git(lane, "commit", "-m", "feat: one\n\nFork-Domain: fork-meta\nFork-Tier: qol");
  git(lane, "remote", "set-url", "origin", remote);
  // The carried replayed report the walk picks up.
  const reportDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "fork-additive-report-"),
  );
  const reportPath = NodePath.join(reportDirectory, "report.json");
  const recordPath = NodePath.join(reportDirectory, "record.md");
  const replayed: SyncReport = validateReport({
    schemaVersion: 1,
    stage: "replayed",
    kind: "unblock",
    repositoryRoot: root,
    reportPath,
    recordPath,
    issue: { number: 352, blockingSha: previous, title: "blocked" },
    candidates: [{ tag: ADDITIVE_TAG, sha: target }],
    target: { tag: ADDITIVE_TAG, sha: target },
    source: { sha: expectedOld, expectedOld, sharedBase: previous },
    lane: { branch, worktree: lane },
    originalMessages: "feat: one\n\nFork-Domain: fork-meta\nFork-Tier: qol\u001e",
    originalCount: 1,
    orientation: coherentOrientation,
    conflicts: [],
    verification: [],
  } as unknown);
  NodeFS.writeFileSync(reportPath, JSON.stringify(replayed));
  const runner = new AdditiveWalkRunner();
  setBotResponses(runner as unknown as FakeRunner, "candidate");
  runner.set(
    "gh",
    ["issue", "comment", "352", "-R", "RSI-Software/t3code-hyprws", "--body-file", recordPath],
    { stdout: "https://example.test/comment\n" },
  );
  // The ledger write spawns real gh for the issue lookup, so shim it like ledgerFixture does.
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      'const record = require("node:fs").readFileSync(process.env.FAKE_RECORD_PATH, "utf8");',
      "process.stdout.write(",
      "  JSON.stringify({",
      "    body: process.env.FAKE_ISSUE_BODY,",
      '    url: "https://example.test/issue",',
      '    comments: [{ body: record, url: "https://example.test/record" }],',
      "  }),",
      ");",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  const previousRecord = process.env.FAKE_RECORD_PATH;
  const previousBody = process.env.FAKE_ISSUE_BODY;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_RECORD_PATH = recordPath;
  process.env.FAKE_ISSUE_BODY = [
    "## Sequential rebase census",
    "",
    "| File | Hunks | Fork commit | Domain |",
    "| --- | ---: | --- | --- |",
    "| `scripts/fork-sync.ts` | 1 | `1234567 feat(fork): walk identity` | fork-meta |",
  ].join("\n");
  return {
    runner,
    root,
    lane,
    remote,
    reportPath,
    recordPath,
    branch,
    target,
    expectedOld,
    restoreLedger: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousRecord === undefined) delete process.env.FAKE_RECORD_PATH;
      else process.env.FAKE_RECORD_PATH = previousRecord;
      if (previousBody === undefined) delete process.env.FAKE_ISSUE_BODY;
      else process.env.FAKE_ISSUE_BODY = previousBody;
    },
  };
};

it("repairs a re-added upstream line as an additive commit and applies", () => {
  const state = additiveWalkFixture([
    [
      "apps/web/src/thing.ts",
      "export const keep = 1;\nexport const stale = () => {\n  return 1;\n};\n",
    ],
    // A fork-only file keeps the owning commit non-empty once the additive fixup folds into it.
    ["apps/web/src/fork.ts", "export const forkOnly = 1;\n"],
  ]);
  try {
    const { output, result } = captureStdout(() =>
      run(["unblock-auto", "--report", state.reportPath], state.root, state.runner),
    );
    assert.strictEqual(result, 0);
    assert.include(output, `- additive: fixed on retry`);
    assert.include(
      output,
      `  - readded apps/web/src/thing.ts: re-adds 1 hunk(s) upstream deleted — consider keeping ours`,
    );
    assert.include(output, `applied: ${ADDITIVE_TAG}`);
    assert.include(output, "- ledger: published");
    const report = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    const additive = report.walk?.additive;
    assert.isDefined(additive);
    assert.strictEqual(additive?.pass, true);
    assert.strictEqual(additive?.attempts, 2);
    assert.deepStrictEqual(
      additive?.findings.map(({ check, path }) => ({ check, path })),
      [{ check: "readded", path: "apps/web/src/thing.ts" }],
    );
    // The additive fix was a fixup on the owning fork commit; once autosquash folds it, the
    // fixup no longer exists and nothing remains reportable.
    assert.isUndefined(report.walk?.repairCommits);
    assert.isDefined(additive?.commit);
    assert.isUndefined(report.walk?.stop);
    // The fix removed the re-add, and it folded into the owner's tree.
    assert.notInclude(
      NodeFS.readFileSync(NodePath.join(state.lane, "apps/web/src/thing.ts"), "utf8"),
      "export const stale = () => {",
    );
    const subjects = additiveGit(
      state.lane,
      "log",
      "--reverse",
      "--format=%s",
      `${state.target}..HEAD`,
    ).split("\n");
    assert.deepStrictEqual(subjects, ["feat: one"]);
    const message = additiveGit(state.lane, "show", "-s", "--format=%B", "HEAD");
    assert.include(message, "Fork-Domain: fork-meta");
    assert.include(message, "Fork-Tier: qol");
    // The leased trunk push published the folded head.
    assert.strictEqual(
      NodeChildProcess.execFileSync("git", ["rev-parse", "refs/heads/hyprws"], {
        cwd: state.remote,
      })
        .toString()
        .trim(),
      additiveGit(state.lane, "rev-parse", "HEAD"),
    );
    // The churn row carries the additive outcome; the folded fixup leaves no repair commit.
    const [row] = parseLedger(readBotRefFile(state.remote, CHURN_REF, CHURN_LEDGER_FILE) ?? "");
    assert.deepStrictEqual(row?.additive, { pass: true, attempts: 2, findings: 1 });
    assert.strictEqual(row?.repairCommits?.length ?? 0, 0);
  } finally {
    state.restoreLedger();
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.lane, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("stops the walk when the replay shrinks an upstream test file", () => {
  const state = additiveWalkFixture([
    ["apps/web/src/thing.test.ts", 'it("first", () => {});\nit("second", () => {});\n'],
  ]);
  try {
    const { output, result } = captureStdout(() =>
      run(
        ["unblock-auto", "--report", state.reportPath],
        state.root,
        state.runner as unknown as never,
      ),
    );
    assert.strictEqual(result, 2);
    assert.include(output, "Stop (conflict).");
    assert.include(output, "- additive: failed");
    assert.include(
      output,
      "  - tests apps/web/src/thing.test.ts: test declarations shrunk from 3 to 2",
    );
    assert.notInclude(output, "applied:");
    const report = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    const additive = report.walk?.additive;
    assert.isDefined(additive);
    assert.strictEqual(additive?.pass, false);
    assert.strictEqual(additive?.attempts, 2);
    assert.deepStrictEqual(additive?.fixed, []);
    assert.strictEqual(report.walk?.stop?.reason, "conflict");
    // Nothing was committed on the lane and nothing was pushed: the stop owns the walk.
    assert.deepStrictEqual(
      additiveGit(state.lane, "log", "--format=%s", `${state.target}..HEAD`).split("\n"),
      ["feat: one"],
    );
    assert.strictEqual(
      NodeChildProcess.execFileSync("git", ["rev-parse", "refs/heads/hyprws"], {
        cwd: state.remote,
      })
        .toString()
        .trim(),
      state.expectedOld,
    );
  } finally {
    state.restoreLedger();
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.lane, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("keeps the replay proof over the fork series when a repair is already appended", () => {
  const state = repairingRun();
  const repair =
    "Fork-Domain: fork-meta\nFork-Tier: bugfix\nFork-Upstreamable: no\nFork-Repair: v1.2.3\n";
  // A rerun sees the previous walk's repair commit on the lane. The fork series is unchanged, so
  // the proof passes; the count it compares excludes the walk's own commit.
  state.runner.set("git", rehearsal(["rev-list", "--count", `${B}..HEAD`]), { stdout: "2\n" });
  state.runner.set(
    "git",
    rehearsal(["log", "--reverse", "--topo-order", "--format=%B%x1e", `${B}..HEAD`]),
    { stdout: `feat: one\x1e\nchore(fork-sync): repair fmt after v1.2.3\n\n${repair}\x1e` },
  );
  try {
    assert.doesNotThrow(() =>
      execute(["unblock-check", "--report", state.reportPath], state.root, state.runner),
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("refuses a rewritten fork commit even with a repair appended", () => {
  const state = repairingRun();
  const repair =
    "Fork-Domain: fork-meta\nFork-Tier: bugfix\nFork-Upstreamable: no\nFork-Repair: v1.2.3\n";
  state.runner.set("git", rehearsal(["rev-list", "--count", `${B}..HEAD`]), { stdout: "2\n" });
  state.runner.set(
    "git",
    rehearsal(["log", "--reverse", "--topo-order", "--format=%B%x1e", `${B}..HEAD`]),
    { stdout: `feat: one, edited\x1e\nchore(fork-sync): repair fmt after v1.2.3\n\n${repair}\x1e` },
  );
  try {
    assert.throws(
      () => execute(["unblock-check", "--report", state.reportPath], state.root, state.runner),
      /replay commit messages changed/,
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("unblock-auto prints the resume line after a Gate 3 failure", () => {
  const state = replayedRun();
  state.runner.set("vp", ["run", "--no-cache", "fork:scan", "--target", "v1.2.3"], {
    status: 1,
    stderr: "scan failed",
  });
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.strictEqual(
      run(["unblock-auto", "--report", state.reportPath], state.root, state.runner),
      1,
    );
    assert.include(stderr, "failed: vp run --no-cache fork:scan --target v1.2.3");
    const bundle = JSON.parse(NodeFS.readFileSync(`${state.reportPath}.outcome.json`, "utf8")) as {
      receipts: Array<{ kind: string; stage?: string; status?: string; detail?: string }>;
    };
    assert.isTrue(
      bundle.receipts.some(
        (row) =>
          row.kind === "stage" &&
          row.stage === "verification" &&
          row.status === "failed" &&
          row.detail?.includes("scan failed"),
      ),
    );
    assert.include(stderr, `report: ${state.reportPath}\n`);
  } finally {
    process.stderr.write = original;
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("verifies the walk lane in place instead of waiting on a CI verdict", () => {
  const { runner, root, worktree, reportPath, branch } = checkedRun();
  try {
    const guards = runner.calls.filter(
      ({ command, args }) =>
        (command === "vp" && args[0] === "run" && args[1] === "--no-cache") ||
        (command === "node" && args[1] === "--check"),
    );
    assert.deepStrictEqual(
      guards.map(({ command, args }) => (command === "node" ? "fork:delta" : args[2])),
      ["fork:scan", "fork:delta"],
    );
    // No full battery in the lane, and nothing that waits on a remote verdict: the walk finishes
    // in one invocation, and trunk CI confirms after the apply.
    assert.isFalse(
      runner.calls.some(({ command, args }) => command === "vp" && args[0] === "check"),
    );
    assert.isFalse(
      runner.calls.some(
        ({ command, args }) =>
          command === "git" &&
          args.join(" ").endsWith(`push --force-with-lease origin HEAD:refs/heads/${branch}`),
      ),
    );
    assert.isFalse(runner.calls.some(({ command }) => command === "sleep"));

    const checked = validateReport(JSON.parse(NodeFS.readFileSync(reportPath, "utf8")));
    assert.strictEqual(checked.installedHead, A);
    assert.isUndefined(checked.ciHead);
    // What the lane verified is what the walk report carries.
    assert.deepStrictEqual(checked.walk?.repairs, checked.verification);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
  }
});

const SUBJECT = "feat(web): themed menus";

/** A replayed report whose decision surface carries one undecided candidate. */
const undecidedRun = (): ReturnType<typeof replayedRun> => {
  const state = replayedRun();
  setCiSuccess(state.runner, state.branch);
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  const next: SyncReport = {
    ...replayed,
    orientationDecisions: [
      { subject: SUBJECT, domain: "workspace-files", verdict: "candidate", decidedBy: "TODO" },
    ],
  };
  NodeFS.writeFileSync(state.reportPath, JSON.stringify(next));
  NodeFS.writeFileSync(next.recordPath, renderRecord(next));
  return state;
};

const signRecord = (recordPath: string, action: string, decidedBy: string): void => {
  const signed = NodeFS.readFileSync(recordPath, "utf8")
    .replace("| TODO |", `| ${action} |`)
    .replace("| TODO |", `| ${decidedBy} |`);
  NodeFS.writeFileSync(recordPath, signed);
};

it("preserves a report-only retire when refreshing rendered decision cells", () => {
  const root = fixtureRoot();
  const state = report(root, {
    orientationDecisions: [
      {
        subject: SUBJECT,
        domain: "workspace-files",
        verdict: "candidate",
        action: "keep (mechanical seam)",
        decidedBy: "agent",
      },
    ],
    recordDecisions: [
      { subject: "fix(web): absorbed fixture delta", action: "retire", decidedBy: "agent" },
    ],
  });
  NodeFS.writeFileSync(state.recordPath, renderRecord(state));
  try {
    assert.deepStrictEqual(preserveRecordDecisions(state).recordDecisions, [
      { subject: "fix(web): absorbed fixture delta", action: "retire", decidedBy: "agent" },
      { subject: SUBJECT, action: "keep (mechanical seam)", decidedBy: "agent" },
    ]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("carries a decision cell filled in the record through the regeneration a check performs", () => {
  const state = undecidedRun();
  const { recordPath } = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  try {
    signRecord(recordPath, "retire", "human");
    execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    const checked = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    assert.deepStrictEqual(checked.recordDecisions, [
      { subject: SUBJECT, action: "retire", decidedBy: "human" },
    ]);
    const row = NodeFS.readFileSync(recordPath, "utf8")
      .split("\n")
      .find((line) => line.startsWith(`| \`${SUBJECT}\` |`));
    assert.include(row ?? "", "| retire |");
    assert.include(row ?? "", "| human |");
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

// RSI-Software/t3code-hyprws#695: a refresh rebinds the head and the stack size. The decision
// cells are not a binding, they are the human's answer, and `unblock-check` already keeps them.
it("carries a decision cell filled in the record through the regeneration a refresh performs", () => {
  const state = undecidedRun();
  const { recordPath } = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  state.runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], {
    stdout: `${C}\n`,
  });
  try {
    signRecord(recordPath, "retire", "human");
    const { output } = captureStdout(() =>
      execute(["unblock-refresh", "--report", state.reportPath], state.root, state.runner),
    );
    const refreshed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    assert.deepStrictEqual(refreshed.recordDecisions, [
      { subject: SUBJECT, action: "retire", decidedBy: "human" },
    ]);
    const row = NodeFS.readFileSync(recordPath, "utf8")
      .split("\n")
      .find((line) => line.startsWith(`| \`${SUBJECT}\` |`));
    assert.include(row ?? "", "| retire |");
    assert.include(row ?? "", "| human |");
    assert.include(output, "Decision cells preserved: 1");
    assert.notInclude(output, "Decision cells dropped");
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("drops a filled decision cell whose subject left the replay, and names it", () => {
  const state = undecidedRun();
  const { recordPath } = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  state.runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], {
    stdout: `${C}\n`,
  });
  try {
    signRecord(recordPath, "retire", "human");
    // The subject leaves the replay: the rebound lane no longer carries the commit it was about.
    const withoutSubject = validateReport(
      JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")),
    );
    NodeFS.writeFileSync(
      state.reportPath,
      JSON.stringify({ ...withoutSubject, orientationDecisions: [] }),
    );
    const { output } = captureStdout(() =>
      execute(["unblock-refresh", "--report", state.reportPath], state.root, state.runner),
    );
    const record = NodeFS.readFileSync(recordPath, "utf8");
    assert.notInclude(record, `| \`${SUBJECT}\` |`);
    assert.include(output, "Decision cells preserved: 0");
    assert.include(output, "Decision cells dropped, subject no longer in the replay:");
    assert.include(output, `  - ${SUBJECT} (human)`);
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("surfaces each failing CI job with its last 40 failed-log lines verbatim", () => {
  const state = replayedRun();
  const runListArgs = [
    "run",
    "list",
    "--workflow",
    "hyprws-ci.yml",
    "--branch",
    state.branch,
    "--json",
    "databaseId,headSha,status,conclusion,url",
    "-R",
    "RSI-Software/t3code-hyprws",
  ];
  state.runner.set("gh", runListArgs, {
    stdout: JSON.stringify([
      {
        databaseId: 43,
        headSha: A,
        status: "completed",
        conclusion: "failure",
        url: "https://example.test/runs/43",
      },
    ]),
  });
  state.runner.set(
    "gh",
    ["run", "view", "43", "--json", "jobs", "-R", "RSI-Software/t3code-hyprws"],
    {
      stdout: JSON.stringify({
        jobs: [
          { name: "Check", conclusion: "failure" },
          { name: "Test", conclusion: "failure" },
          { name: "Test Server 1", conclusion: "success" },
        ],
      }),
    },
  );
  const linesFor = (job: string): string =>
    Array.from(
      { length: 45 },
      (_, index) => `${job}\tstep\t${job.toLowerCase()}-${String(index + 1).padStart(3, "0")}`,
    ).join("\n");
  state.runner.set(
    "gh",
    ["run", "view", "43", "--log-failed", "-R", "RSI-Software/t3code-hyprws"],
    { stdout: `${linesFor("Check")}\n${linesFor("Test")}\n` },
  );
  try {
    let message = "";
    try {
      waitForCiVerdict(state.runner, state.worktree, state.branch, A);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "hyprws CI failed: https://example.test/runs/43");
    assert.include(message, "Failing job: Check");
    assert.include(message, "Failing job: Test");
    assert.include(message, "Check\tstep\tcheck-006");
    assert.include(message, "Check\tstep\tcheck-045");
    assert.notInclude(message, "Check\tstep\tcheck-005");
    assert.notInclude(message, "Test Server 1");
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

const ESC = "\u001B";

/**
 * Captured from `hyprws CI` run 33986893347, the run in RSI-Software/t3code-hyprws#629. Its `Check`
 * job log is ANSI-bearing, carries long fork-ledger lines, and sits behind thousands of earlier
 * lines, so the excerpt has to survive colour, line length, and volume at once.
 */
const CAPTURED_CHECK_TAIL: ReadonlyArray<string> = [
  `${ESC}[0;32m✔${ESC}[0m ${ESC}[1;94mVITE+${ESC}[0m successfully installed!`,
  `  ${ESC}[1mGet started:${ESC}[0m`,
  "  pnpm-lock.yaml [original scope; 10 retained observation(s)] -> package manifest intent plus the pinned lockfile generator; never hand-merge generated dependency state; evidence: unknown: Different measurement method cannot establish absence of the retained identity.",
  "Cleaning up orphan processes",
];

const capturedJobLog = (job: string, oversized: boolean): string => {
  const stamp = (body: string): string => `${job}\tRun vp check\t2026-09-05T19:24:50.362Z ${body}`;
  const filler = Array.from({ length: 2000 }, (_, index) =>
    stamp(oversized ? "ledger row ".repeat(200) : `noise ${index}`),
  );
  return [
    ...filler,
    stamp("x".repeat(120_000)),
    ...(oversized ? [] : CAPTURED_CHECK_TAIL.map(stamp)),
  ].join("\n");
};

const failedVerdict = (
  state: ReturnType<typeof replayedRun>,
  jobs: ReadonlyArray<{ name: string; conclusion: string | null }>,
  overrides: {
    conclusion?: string | null;
    jobsResult?: Partial<CommandResult>;
    logResult?: Partial<CommandResult>;
  } = {},
): void => {
  state.runner.set(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "hyprws-ci.yml",
      "--branch",
      state.branch,
      "--json",
      "databaseId,headSha,status,conclusion,url",
      "-R",
      "RSI-Software/t3code-hyprws",
    ],
    {
      stdout: JSON.stringify([
        {
          databaseId: 43,
          headSha: A,
          status: "completed",
          conclusion: overrides.conclusion === undefined ? "failure" : overrides.conclusion,
          url: "https://example.test/runs/43",
        },
      ]),
    },
  );
  state.runner.set(
    "gh",
    ["run", "view", "43", "--json", "jobs", "-R", "RSI-Software/t3code-hyprws"],
    overrides.jobsResult ?? { stdout: JSON.stringify({ jobs }) },
  );
  state.runner.set(
    "gh",
    ["run", "view", "43", "--log-failed", "-R", "RSI-Software/t3code-hyprws"],
    overrides.logResult ?? {
      stdout: jobs
        .filter(({ conclusion }) => conclusion !== null && conclusion !== "success")
        .map(({ name }) => capturedJobLog(name, name !== "Check"))
        .join("\n"),
    },
  );
};

const withFailedVerdict = (
  jobs: ReadonlyArray<{ name: string; conclusion: string | null }>,
  overrides: Parameters<typeof failedVerdict>[2],
  body: (state: ReturnType<typeof replayedRun>, message: string) => void,
): void => {
  const state = replayedRun();
  failedVerdict(state, jobs, overrides);
  try {
    let message = "";
    try {
      // The unattended walk never waits on a remote verdict, so the CI diagnostics are read
      // straight off the unit the series rewrite and the stable lane still call.
      waitForCiVerdict(state.runner, state.worktree, state.branch, A);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    body(state, message);
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
};

it("bounds a large ANSI-bearing failed CI log to a readable excerpt", () => {
  withFailedVerdict(
    [
      { name: "Check", conclusion: "failure" },
      { name: "Test", conclusion: "failure" },
      { name: "Test Server 1", conclusion: "failure" },
      { name: "Test Server 2", conclusion: "success" },
    ],
    {},
    (_state, message) => {
      // The whole log is roughly 400 KB across three failed jobs, one line of it 120 000
      // characters wide. The diagnostic stays capped, colour-free, and readable regardless.
      assert.isBelow(message.length, 20_100);
      assert.notInclude(message, ESC);
      assert.include(message, "[line truncated]");
      assert.include(message, "[evidence truncated at 20000 characters]");
      assert.include(message, "hyprws CI failed: https://example.test/runs/43");
      assert.include(message, "run 43 concluded failure on the pushed head");
      assert.include(message, "failed jobs: Check, Test, Test Server 1");
      assert.include(message, "Failing job: Check (failure)");
      assert.include(message, "VITE+ successfully installed!");
      assert.include(message, "Cleaning up orphan processes");
      assert.notInclude(message, "Test Server 2");
    },
  );
});

it("fails the gate with what the run knows when the failed log cannot be read", () => {
  withFailedVerdict(
    [{ name: "Check", conclusion: "failure" }],
    { logResult: { status: 1, stderr: "failed to get run log: log not found" } },
    (_state, message) => {
      assert.include(message, "hyprws CI failed: https://example.test/runs/43");
      assert.include(message, "run 43 concluded failure on the pushed head");
      assert.include(message, "failed jobs: Check");
      assert.include(message, "failed job log unavailable");
      assert.include(message, "log not found");
    },
  );
});

it("fails the gate with what the run knows when the job list cannot be read", () => {
  withFailedVerdict(
    [{ name: "Check", conclusion: "failure" }],
    { jobsResult: { status: 1, stderr: "HTTP 502" } },
    (_state, message) => {
      assert.include(message, "hyprws CI failed: https://example.test/runs/43");
      assert.include(message, "run 43 concluded failure on the pushed head");
      assert.include(message, "failed job list unavailable");
      assert.include(message, "HTTP 502");
    },
  );
});

it("keeps a red run a failed gate when its log quotes a refusal phrase", () => {
  withFailedVerdict(
    [{ name: "Check", conclusion: "failure" }],
    {
      logResult: {
        stdout: "Check\tstep\tfatal: commit count changed while the bot run is in progress\n",
      },
    },
    (_state, message) => {
      assert.include(message, "commit count changed while the bot run is in progress");
    },
  );
});

for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", null])
  it(`treats a completed run concluded ${conclusion ?? "null"} as a failed gate`, () => {
    withFailedVerdict(
      [{ name: "Check", conclusion: "failure" }],
      { conclusion, logResult: { stdout: "Check\tstep\tlast line\n" } },
      (_state, message) => {
        assert.include(message, "hyprws CI failed: https://example.test/runs/43");
        assert.include(message, `run 43 concluded ${conclusion ?? "unknown"} on the pushed head`);
        assert.include(message, "Check\tstep\tlast line");
      },
    );
  });

it("treats a 45-minute CI wait timeout as a failed gate", () => {
  const state = replayedRun();
  state.runner.set(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "hyprws-ci.yml",
      "--branch",
      state.branch,
      "--json",
      "databaseId,headSha,status,conclusion,url",
      "-R",
      "RSI-Software/t3code-hyprws",
    ],
    { stdout: "[]" },
  );
  try {
    assert.throws(
      () => waitForCiVerdict(state.runner, state.worktree, state.branch, A),
      /hyprws CI timed out after 45 minutes/,
    );
    assert.lengthOf(
      state.runner.calls.filter(
        ({ command, args }) => command === "sleep" && args.join(" ") === "30",
      ),
      90,
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

const scrubbedGateEnv = {
  NODE_PATH: "/elsewhere/node_modules/.pnpm/node_modules",
  NPM_CONFIG_REGISTRY: "https://registry.example.test",
  VP_ENV_USE_EVAL_ENABLE: "1",
  VP_NODE_DIST_MIRROR: "https://node.example.test",
  VP_NODE_SKIP_SIGNATURE_VERIFY: "1",
  VP_NODE_VERSION: "24.20.0",
  npm_config_registry: "https://registry.example.test",
  npm_lifecycle_event: "fork:sync",
  ELECTRON_RUN_AS_NODE: "1",
};

it("scrubs package-manager, Vite+ bootstrap, and Electron state from Gate 3 checks", () => {
  assert.deepStrictEqual(
    gateVerificationEnv({ HOME: "/home/example", PATH: "/bin", ...scrubbedGateEnv }, "/lane"),
    {
      HOME: "/home/example",
      PATH: `${NodePath.join("/lane", "node_modules", ".bin")}${NodePath.delimiter}/bin`,
    },
  );

  const { runner, root, worktree } = checkedRun();
  try {
    const checks = runner.calls.filter(
      ({ command, args }) =>
        (command === "vp" &&
          (args[0] === "check" || (args[0] === "run" && args[1] !== undefined))) ||
        (command === "node" && args[1] === "--check"),
    );
    assert.lengthOf(checks, 2);
    for (const call of checks) {
      assert.isDefined(call.env);
      for (const key of Object.keys(scrubbedGateEnv)) {
        assert.notProperty(call.env, key);
      }
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
  }
});

// The failure this pins: the invoking checkout's `node_modules/.bin` resolves `vp` to its
// own shim, which exports that checkout's NODE_PATH, and the lane's test run then reads
// Vite+ out of a tree it never installed. Same verb, different verdict per invocation.
it("resolves every lane command out of the lane, never the invoking checkout", () => {
  const laneBin = NodePath.join("/lane", "node_modules", ".bin");
  assert.strictEqual(
    laneExecutablePath(
      ["/elsewhere/node_modules/.bin", "/usr/bin", laneBin, "/opt/tools/bin"].join(
        NodePath.delimiter,
      ),
      "/lane",
    ),
    [laneBin, "/usr/bin", "/opt/tools/bin"].join(NodePath.delimiter),
  );

  const { runner, root, worktree } = checkedRun();
  try {
    const laneCalls = runner.calls.filter(({ command }) => command === "vp");
    assert.isAbove(laneCalls.length, 0);
    for (const call of laneCalls) {
      assert.strictEqual(call.cwd, worktree);
      const path = (call.env?.PATH ?? "").split(NodePath.delimiter);
      assert.strictEqual(path[0], NodePath.join(worktree, "node_modules", ".bin"));
      for (const entry of path.slice(1)) assert.notInclude(entry, "node_modules");
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
  }
});

it("rewrite-rehearse waits out a running bot and then continues", () => {
  const root = fixtureRoot();
  const runner = new FakeRunner();
  runner.set("git", ["rev-parse", "--show-toplevel"], { stdout: `${root}\n` });
  runner.set("gh", modeArgs, { stdout: "candidate\n" });
  // No real sleep: one short poll, then the run completes on the repoll.
  runner.set("sleep", ["30"], { stdout: "" });
  runner.setSequence("gh", runListArgs, [
    { stdout: JSON.stringify([{ ...lastRun, status: "in_progress", conclusion: null }]) },
    { stdout: JSON.stringify([lastRun]) },
    { stdout: JSON.stringify([lastRun]) },
  ]);
  const from = "b".repeat(40);
  const origin = "c".repeat(40);
  const base = "a".repeat(40);
  runner.set("git", ["rev-parse", from], { stdout: `${from}\n` });
  runner.set("git", ["rev-parse", "origin/hyprws"], { stdout: `${origin}\n` });
  runner.set("git", ["merge-base", "upstream/main", "origin/hyprws"], { stdout: `${base}\n` });
  runner.set("git", ["merge-base", "upstream/main", from], { stdout: `${base}\n` });
  runner.set("git", ["tag", "--points-at", base], { stdout: "v0.0.38-nightly.20260831.1236\n" });
  runner.set("git", ["rev-list", "--count", `${base}..origin/hyprws`], { stdout: "199\n" });
  runner.set("git", ["rev-list", "--count", `${base}..${from}`], { stdout: "197\n" });
  runner.set(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "log",
      "--reverse",
      "--topo-order",
      "--format=%B%x1e",
      `${base}..origin/hyprws`,
    ],
    { stdout: "same\n" },
  );
  runner.set("git", ["rev-list", "--reverse", "--topo-order", `${base}..${from}`], {
    stdout: `${from}\n`,
  });
  runner.set(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "log",
      "--reverse",
      "--topo-order",
      "--format=%B%x1e",
      `${base}..${from}`,
    ],
    { stdout: "same\n" },
  );
  runner.set(
    "git",
    ["diff", "--name-only", from, "origin/hyprws", "--", ":!*.test.ts", ":!*.test.tsx"],
    { stdout: "" },
  );
  try {
    const { output } = captureStdout(() => {
      const code = run(["rewrite-rehearse", "--from", from, "--dry-run"], root, runner);
      assert.strictEqual(code, 3);
    });
    // The walk waited one poll instead of refusing, then continued past the
    // bot gate to the count proof, which still reports status 3.
    assert.include(
      output,
      "waiting for the auto-rebase bot run to finish: https://example.test/runs/1",
    );
    assert.include(output, "bot run finished; continuing");
    assert.lengthOf(
      runner.calls.filter(({ command, args }) => command === "sleep" && args[0] === "30"),
      1,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("rewrite-rehearse refuses a stale from via count proof", () => {
  const root = fixtureRoot();
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  const from = "b".repeat(40);
  const origin = "c".repeat(40);
  const base = "a".repeat(40);
  runner.set("git", ["rev-parse", "--show-toplevel"], { stdout: `${root}\n` });
  runner.set("git", ["rev-parse", from], { stdout: `${from}\n` });
  runner.set("git", ["rev-parse", "origin/hyprws"], { stdout: `${origin}\n` });
  runner.set("git", ["merge-base", "upstream/main", "origin/hyprws"], { stdout: `${base}\n` });
  runner.set("git", ["merge-base", "upstream/main", from], { stdout: `${base}\n` });
  runner.set("git", ["tag", "--points-at", base], { stdout: "v0.0.38-nightly.20260831.1236\n" });
  runner.set("git", ["rev-list", "--count", `${base}..origin/hyprws`], { stdout: "199\n" });
  runner.set("git", ["rev-list", "--count", `${base}..${from}`], { stdout: "197\n" });
  // Stub the two log calls
  runner.set(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "log",
      "--reverse",
      "--topo-order",
      "--format=%B%x1e",
      `${base}..origin/hyprws`,
    ],
    { stdout: "same\n" },
  );
  runner.set("git", ["rev-list", "--reverse", "--topo-order", `${base}..${from}`], {
    stdout: `${from}\n`,
  });
  runner.set(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "log",
      "--reverse",
      "--topo-order",
      "--format=%B%x1e",
      `${base}..${from}`,
    ],
    { stdout: "same\n" },
  );
  runner.set(
    "git",
    ["diff", "--name-only", from, "origin/hyprws", "--", ":!*.test.ts", ":!*.test.tsx"],
    { stdout: "" },
  );
  try {
    const code = run(["rewrite-rehearse", "--from", from, "--dry-run"], root, runner);
    assert.strictEqual(code, 3);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("rewrite-rehearse happy path writes a kind rewrite report", () => {
  const root = fixtureRoot();
  const from = "b".repeat(40);
  const origin = "c".repeat(40);
  const base = "a".repeat(40);
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  runner.set("git", ["rev-parse", "--show-toplevel"], { stdout: `${root}\n` });
  runner.set("git", ["rev-parse", from], { stdout: `${from}\n` });
  runner.set("git", ["rev-parse", "origin/hyprws"], { stdout: `${origin}\n` });
  runner.set("git", ["merge-base", "upstream/main", "origin/hyprws"], { stdout: `${base}\n` });
  runner.set("git", ["merge-base", "upstream/main", from], { stdout: `${base}\n` });
  runner.set("git", ["tag", "--points-at", base], { stdout: "v0.0.38-nightly.20260831.1236\n" });
  runner.set("git", ["rev-list", "--count", `${base}..origin/hyprws`], { stdout: "2\n" });
  runner.set("git", ["rev-list", "--count", `${base}..${from}`], { stdout: "2\n" });
  const same = "hello\x1e";
  runner.set(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "log",
      "--reverse",
      "--topo-order",
      "--format=%B%x1e",
      `${base}..origin/hyprws`,
    ],
    { stdout: same },
  );
  // fromFirstN path: list then log up to nth
  runner.set("git", ["rev-list", "--reverse", "--topo-order", `${base}..${from}`], {
    stdout: `1111111111111111111111111111111111111111\n${from}\n`,
  });
  runner.set(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "log",
      "--reverse",
      "--topo-order",
      "--format=%B%x1e",
      `${base}..${from}`,
    ],
    { stdout: same },
  );
  runner.set(
    "git",
    ["diff", "--name-only", from, "origin/hyprws", "--", ":!*.test.ts", ":!*.test.tsx"],
    { stdout: "" },
  );
  runner.set(
    "git",
    [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/rehearse/rewrite-${from.slice(0, 12)}-from-${origin.slice(0, 12)}`,
    ],
    { status: 1 },
  );
  const wtDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wt-"));
  runner.set(
    "wt",
    [
      "switch",
      "--create",
      `rehearse/rewrite-${from.slice(0, 12)}-from-${origin.slice(0, 12)}`,
      "--base",
      from,
      "--no-cd",
      "--format",
      "json",
      "--yes",
    ],
    { stdout: JSON.stringify({ worktree_path: wtDir }) },
  );
  runner.set(
    "git",
    [
      "push",
      "--force-with-lease",
      "origin",
      `HEAD:refs/heads/rehearse/rewrite-${from.slice(0, 12)}-from-${origin.slice(0, 12)}`,
    ],
    { stdout: "" },
  );
  // need issue list fallback: return empty so rewrite uses dummy issue
  runner.set(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "rebase-blocked",
      "-R",
      "RSI-Software/t3code-hyprws",
      "--json",
      "number,title,body",
    ],
    { stdout: "[]" },
  );
  let out = "";
  const orig = process.stdout.write;
  process.stdout.write = ((c: string | Uint8Array) => {
    out += c.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = run(["rewrite-rehearse", "--from", from, "--dry-run"], root, runner);
    assert.strictEqual(code, 0);
    assert.include(out, "pass: commit count");
    // Find the written report via captured output path (last line is report path)
    const lines = out.trim().split("\n");
    const reportPath = lines[lines.length - 1]?.trim() ?? "";
    // report should exist at that path
    if (reportPath.endsWith("report.json") && NodeFS.existsSync(reportPath)) {
      const rpt = validateReport(JSON.parse(NodeFS.readFileSync(reportPath, "utf8")));
      assert.strictEqual((rpt as unknown as { kind: string }).kind, "rewrite");
    }
  } finally {
    process.stdout.write = orig;
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(wtDir, { recursive: true, force: true });
  }
});

it("carries a human verdict from the churn ledger into the rendered record as inherited", () => {
  const root = fixtureRoot();
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-carry-"));
  const recordPath = NodePath.join(directory, "record.md");
  const reportPath = NodePath.join(directory, "report.json");
  const previousTag = "v0.0.38-nightly.20260901.1245";
  const subject = "feat(web): inherit this verdict";
  const domain = "project-windows";
  // Direct render test without reading the live ledger: verify the rendering contract.
  try {
    const fakeReport = {
      schemaVersion: 1 as const,
      stage: "oriented" as const,
      repositoryRoot: root,
      reportPath,
      recordPath,
      issue: { number: 389, blockingSha: "a".repeat(40), title: "blocked" },
      candidates: [{ tag: "v0.0.39", sha: "b".repeat(40) }],
      target: { tag: "v0.0.39", sha: "b".repeat(40) },
      source: { sha: "c".repeat(40), expectedOld: "c".repeat(40), sharedBase: "a".repeat(40) },
      conflicts: [],
      verification: [],
      orientationDecisions: [
        { subject, domain, verdict: "candidate", decidedBy: "TODO" },
      ] as unknown as ReadonlyArray<import("./fork-sync-state.ts").OrientationDecisionRow>,
      inheritedVerdicts: [
        { subject, domain, action: "retire", decidedBy: "human", sourceTag: previousTag },
      ],
      retireEvidence: [],
    } as unknown as import("./fork-sync-state.ts").SyncReport;
    const rendered = renderRecord(fakeReport);
    // Must be inherited and visibly distinct.
    assert.include(rendered, `| \`${subject}\` |`);
    assert.include(rendered, "inherited from v0.0.38-nightly.20260901.1245");
    assert.include(rendered, "inherited (v0.0.38-nightly.20260901.1245)");
    assert.include(rendered, "| retire |");
    // Must not render as TODO for the carried subject
    const line = rendered.split("\n").find((l) => l.includes(subject)) ?? "";
    assert.notInclude(line, "| TODO |");
    // Fresh candidate without inherited verdict remains TODO
    const freshSubject = "feat(web): fresh candidate";
    const freshReport = {
      ...fakeReport,
      orientationDecisions: [
        { subject: freshSubject, domain, verdict: "candidate", decidedBy: "TODO" },
      ] as unknown as ReadonlyArray<import("./fork-sync-state.ts").OrientationDecisionRow>,
      inheritedVerdicts: [],
    } as unknown as import("./fork-sync-state.ts").SyncReport;
    const freshRendered = renderRecord(freshReport);
    const freshLine = freshRendered.split("\n").find((l) => l.includes(freshSubject)) ?? "";
    assert.include(freshLine, "| TODO |");
    // Ledger contract: only human decisions are carried
    const { humanVerdictsBySubject } =
      require("./fork-churn-ledger.ts") as typeof import("./fork-churn-ledger.ts");
    const onlyHuman = humanVerdictsBySubject([
      {
        tag: previousTag,
        before: "a".repeat(40),
        after: "b".repeat(40),
        recordUrl: "https://example.test/record",
        conflicts: [],
        decisions: [
          { subject, domain, verdict: "retire", decidedBy: "human" },
          { subject: "feat(web): agent decided", domain, verdict: "keep", decidedBy: "agent" },
        ],
        censusFiles: [{ path: "apps/web/a.ts", hunks: 1, commit: "abc1234", domain }],
      },
    ]);
    assert.isTrue(onlyHuman.has(subject));
    assert.isFalse(onlyHuman.has("feat(web): agent decided"));
    // Inherited decider is distinguishable from human: parse keeps the string.
    const { parseDecisionRows } =
      require("./fork-sync-state.ts") as typeof import("./fork-sync-state.ts");
    const parsed = parseDecisionRows(rendered);
    assert.strictEqual(
      parsed.find((r) => r.subject === subject)?.decidedBy,
      "inherited (v0.0.38-nightly.20260901.1245)",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

// RSI-Software/t3code-hyprws#388: the next session discovers it only when every
// verb names the staleness and the restart path slotted. The green Gate 3 in
// session N must void visibly on any movement of hyprws, with the old/new SHA
// and the trash line for the orphaned rehearsal.
it("names the staleness and trash when any verb runs on a voided report", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-test-"));
  const report = (stage: "replayed" | "checked") =>
    ({
      schemaVersion: 1 as const,
      stage,
      repositoryRoot: root,
      reportPath:
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-report-")) + "/report.json",
      recordPath:
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-report-")) + "/record.md",
      issue: { number: 352, blockingSha: A, title: "blocked" },
      candidates: [{ tag: "v1.2.3", sha: B }],
      bot: { mode: "candidate" as const, lastRun: null, nextFire: "2026-09-02T08:23:00.000Z" },
      target: { tag: "v1.2.3", sha: B },
      source: { sha: C, expectedOld: C, sharedBase: A },
      lane: { branch, worktree },
      conflicts: [],
      verification: [],
      ...(stage === "replayed"
        ? { originalMessages: "msg", originalCount: 1 }
        : { installedHead: B, ciHead: B, orientation: coherentOrientation }),
    }) as unknown as SyncReport;
  for (const stage of ["replayed", "checked"] as const) {
    const rep = report(stage);
    NodeFS.writeFileSync(rep.reportPath, JSON.stringify(rep));
    NodeFS.writeFileSync(rep.recordPath, renderRecord(rep));
    const runner = new FakeRunner();
    runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${A}\n` });
    setBotResponses(runner, "candidate");
    try {
      const verb = stage === "replayed" ? "unblock-check" : "unblock-apply";
      const args =
        stage === "replayed"
          ? [verb, "--report", rep.reportPath]
          : [verb, "--report", rep.reportPath, "--record", rep.recordPath];
      let message = "";
      try {
        execute(args, root, runner);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assert.match(message, /staleness: origin\/hyprws moved past the report's lease/);
      assert.match(message, /report leased at c+/);
      assert.match(message, /origin\/hyprws is now a+/);
      assert.match(message, /the walk re-lists from the moved trunk/);
      assert.match(message, /fold rule in docs\/operations\/fork-sync\.md/);
      assert.match(message, new RegExp(`trash ${worktree.replace(/[\\/]/g, (c) => `\\${c}`)}`));
      assert.match(message, /orphaned/);
      // Do NOT emit an rm command.
      assert.isFalse(runner.calls.some(({ args }) => args.join(" ").includes(" rm ")));
      assert.isFalse(
        runner.calls.some(({ args }) => args.join(" ").includes(" trash") && args.includes("rm")),
      );
    } finally {
      NodeFS.rmSync(NodePath.dirname(rep.reportPath), { recursive: true, force: true });
      NodeFS.rmSync(NodePath.dirname(rep.recordPath), { recursive: true, force: true });
    }
  }
  NodeFS.rmSync(worktree, { recursive: true, force: true });
  NodeFS.rmSync(root, { recursive: true, force: true });
});

/**
 * A `conflicts` walk holds its lane but never replayed, so its lease must survive linear trunk
 * movement too (RSI-Software/t3code-hyprws#665): the fold notice names rehearse-then-fold instead
 * of voiding, non-linear movement still voids, and a lane-less stage still voids even on linear
 * movement. `classifyTrunkMovement` runs real git, so the linear case uses real commits.
 */
it("a conflicts lane folds linear trunk movement instead of voiding", () => {
  const root = fixtureRoot();
  NodeChildProcess.execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: root });
  const commit = (file: string, content: string): string => {
    NodeFS.writeFileSync(NodePath.join(root, file), content);
    NodeChildProcess.execFileSync("git", ["add", file], { cwd: root });
    NodeChildProcess.execFileSync("git", ["commit", "--quiet", "-m", file], { cwd: root });
    return NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
      .toString()
      .trim();
  };
  const sharedBase = commit("base.txt", "base\n");
  const target = commit("target.txt", "target\n");
  NodeChildProcess.execFileSync("git", ["reset", "--quiet", "--hard", sharedBase], { cwd: root });
  const frontier = commit("frontier.txt", "frontier\n");
  const live = commit("landing.txt", "landing\n");

  const rep = report(root, {
    stage: "conflicts",
    target: { tag: "v1.2.3", sha: target },
    source: { sha: frontier, expectedOld: frontier, sharedBase },
    lane: { branch: `rehearse/v1.2.3-from-${frontier.slice(0, 12)}`, worktree: root },
  });
  NodeFS.writeFileSync(rep.reportPath, JSON.stringify(rep));
  NodeFS.writeFileSync(rep.recordPath, renderRecord(rep));
  const runner = new FakeRunner();
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${live}\n` });
  try {
    const { output } = captureStdout(() => {
      try {
        execute(["unblock-rehearse", "--report", rep.reportPath], root, runner);
      } catch (error) {
        if (!/replay binding is incomplete/.test(error instanceof Error ? error.message : ""))
          throw error;
      }
    });
    // The lease refusal is gone and the notice names rehearse-then-fold; the run proceeds past
    // the lease and stops at the replay binding it cannot fake, which is the point.
    assert.match(output, /fold: origin\/hyprws advanced to .* past lease /);
    assert.include(output, "rehearse to `replayed` with `vp run fork:sync unblock-rehearse`");
    assert.include(output, "then `vp run fork:sync unblock-fold` folds it into the candidate");
    assert.notInclude(output, "staleness:");
  } finally {
    NodeFS.rmSync(NodePath.dirname(rep.reportPath), { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(rep.recordPath), { recursive: true, force: true });
  }
  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("a conflicts lane still voids on non-linear trunk movement", () => {
  const root = fixtureRoot();
  const rep = report(root, {
    stage: "conflicts",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: `rehearse/v1.2.3-from-${C.slice(0, 12)}`, worktree: root },
    originalMessages: "msg",
    originalCount: 1,
  });
  NodeFS.writeFileSync(rep.reportPath, JSON.stringify(rep));
  NodeFS.writeFileSync(rep.recordPath, renderRecord(rep));
  const runner = new FakeRunner();
  // Movement to A off a C frontier cannot fold (C is not an ancestor of A).
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${A}\n` });
  try {
    let message = "";
    try {
      execute(["unblock-rehearse", "--report", rep.reportPath], root, runner);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /staleness: origin\/hyprws moved past the report's lease/);
    assert.match(message, /the walk re-lists from the moved trunk/);
  } finally {
    NodeFS.rmSync(NodePath.dirname(rep.reportPath), { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(rep.recordPath), { recursive: true, force: true });
  }
  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("an oriented walk without a lane still voids on linear trunk movement", () => {
  const root = fixtureRoot();
  NodeChildProcess.execFileSync("git", ["config", "user.name", "test"], { cwd: root });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: root });
  const commit = (file: string, content: string): string => {
    NodeFS.writeFileSync(NodePath.join(root, file), content);
    NodeChildProcess.execFileSync("git", ["add", file], { cwd: root });
    NodeChildProcess.execFileSync("git", ["commit", "--quiet", "-m", file], { cwd: root });
    return NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
      .toString()
      .trim();
  };
  const sharedBase = commit("base.txt", "base\n");
  const target = commit("target.txt", "target\n");
  NodeChildProcess.execFileSync("git", ["reset", "--quiet", "--hard", sharedBase], { cwd: root });
  const frontier = commit("frontier.txt", "frontier\n");
  const live = commit("landing.txt", "landing\n");

  const rep = report(root, {
    stage: "oriented",
    target: { tag: "v1.2.3", sha: target },
    source: { sha: frontier, expectedOld: frontier, sharedBase },
  });
  NodeFS.writeFileSync(rep.reportPath, JSON.stringify(rep));
  NodeFS.writeFileSync(rep.recordPath, renderRecord(rep));
  const runner = new FakeRunner();
  // The movement itself is linear; only the missing lane keeps the void.
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${live}\n` });
  try {
    let message = "";
    try {
      execute(["unblock-rehearse", "--report", rep.reportPath], root, runner);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /staleness: origin\/hyprws moved past the report's lease/);
    assert.notInclude(message, "fold:");
  } finally {
    NodeFS.rmSync(NodePath.dirname(rep.reportPath), { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(rep.recordPath), { recursive: true, force: true });
  }
  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("does not refuse when origin/hyprws is still at the leased SHA", () => {
  const root = fixtureRoot();
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: `rehearse/v1.2.3-from-${C.slice(0, 12)}`, worktree: root },
    installedHead: B,
    ciHead: B,
    orientation: coherentOrientation,
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  // Make every guard the apply reads stay on the report: lease is still live,
  // orientation coheres (source C / shared A), and the lane lives where the
  // report bound it.
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  setBotResponses(runner, "candidate");
  setOrientationResponses(runner, C, B, A);
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${B}\n` });
  runner.set(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${checked.lane!.branch}`,
    ],
    { stdout: `${B}\trefs/heads/${checked.lane!.branch}\n` },
  );
  // The record is signed (checked has no decisions), so the only refusal
  // that remains would be the staleness one — which should be silent here.
  runner.set("git", ["status", "--porcelain"], { stdout: "" });
  const ledger = ledgerFixture(root, checked.recordPath);
  // Stub the gate — the full tree read does not exercise its branches here; the
  // staleness is the _last_ guard before push, so any non-staleness refusal
  // proves the lease was correctly read as live.
  try {
    let staleness = false;
    try {
      execute(
        ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
        root,
        runner,
      );
    } catch (e) {
      if (/staleness: origin\/hyprws moved/.test(String(e))) staleness = true;
    }
    assert.isFalse(staleness, "staleness refusal must be silent when hyprws has not moved");
  } finally {
    ledger.restore();
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("renders the lease boundary and what movement voids it in the checked stop", () => {
  const root = fixtureRoot();
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: `rehearse/v1.2.3-from-${C.slice(0, 12)}`, worktree: root },
    installedHead: B,
    ciHead: B,
  });
  try {
    const record = renderRecord(checked);
    assert.include(
      record,
      `Lease: report leased at \`${C}\` (origin/hyprws) — a linear landing folds at \`vp run fork:sync unblock-fold\``,
    );
    assert.include(record, "movement that cannot fold voids this rehearsal");
    assert.include(
      record,
      "Stop. Lease boundary: a linear landing folds at `unblock-fold`; movement that cannot fold past the lease above voids this green rehearsal.",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

const RETIRE_SUBJECT = "fix(web): superseded upstream";
const RETIRE_KEEP_SUBJECT = "feat(web): keep fork behavior";
const retireReplay = (): {
  runner: FakeRunner;
  root: string;
  worktree: string;
  reportPath: string;
  branch: string;
} => {
  const state = replayedRun();
  setCiSuccess(state.runner, state.branch);
  const fullMessages = `${RETIRE_SUBJECT}\nFork-Domain: fork-meta\n\x1e${RETIRE_KEEP_SUBJECT}\nFork-Domain: web\n\x1e`;
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  const next: SyncReport = {
    ...replayed,
    originalMessages: fullMessages,
    originalCount: 2,
    orientationDecisions: [
      { subject: RETIRE_SUBJECT, domain: "fork-meta", verdict: "candidate", decidedBy: "TODO" },
    ],
  };
  NodeFS.writeFileSync(state.reportPath, JSON.stringify(next));
  NodeFS.writeFileSync(next.recordPath, renderRecord(next));
  return state;
};

it("a recorded retire verdict drops the commit from the replay and verifies as retired, not partial", () => {
  const state = retireReplay();
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  const retired: SyncReport = {
    ...replayed,
    recordDecisions: [{ subject: RETIRE_SUBJECT, action: "retire", decidedBy: "human" }],
  };
  NodeFS.writeFileSync(state.reportPath, JSON.stringify(retired));
  signRecord(retired.recordPath, "retire", "human");
  const filteredMessages = `${RETIRE_KEEP_SUBJECT}\nFork-Domain: web\n\x1e`;
  state.runner.set("git", ["-c", "core.commentChar=auto", "rev-list", "--count", `${B}..HEAD`], {
    stdout: "1\n",
  });
  state.runner.set(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "log",
      "--reverse",
      "--topo-order",
      "--format=%B%x1e",
      `${B}..HEAD`,
    ],
    { stdout: filteredMessages },
  );
  try {
    execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    const checked = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    assert.deepStrictEqual(checked.recordDecisions, [
      { subject: RETIRE_SUBJECT, action: "retire", decidedBy: "human" },
    ]);
    assert.include(NodeFS.readFileSync(checked.recordPath, "utf8"), `| \`${RETIRE_SUBJECT}\` |`);
    assert.include(NodeFS.readFileSync(checked.recordPath, "utf8"), "| retire |");
    // The retire row is an enactment, not a downgrade to partial.
    assert.notInclude(NodeFS.readFileSync(checked.recordPath, "utf8"), "| partial |");
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("reads a previous walk's repair on trunk as part of the baseline, not as a shrunk stack", () => {
  const state = retireReplay();
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  // A repair the last walk appended is an ordinary trunk commit by the time this walk reads its
  // baseline. The lane's proof drops repairs, so a baseline that keeps them counts one commit the
  // replay can never produce and halts a walk that is entirely healthy.
  const withRepair: SyncReport = {
    ...replayed,
    originalMessages:
      `${RETIRE_SUBJECT}\nFork-Domain: fork-meta\n\x1e` +
      "chore(fork-sync): repair fmt after v1.2.2\nFork-Domain: fork-meta\nFork-Repair: v1.2.2\n\x1e" +
      `${RETIRE_KEEP_SUBJECT}\nFork-Domain: web\n\x1e`,
    originalCount: 3,
    recordDecisions: [{ subject: RETIRE_SUBJECT, action: "retire", decidedBy: "human" }],
  };
  NodeFS.writeFileSync(state.reportPath, JSON.stringify(withRepair));
  signRecord(withRepair.recordPath, "retire", "human");
  state.runner.set("git", ["-c", "core.commentChar=auto", "rev-list", "--count", `${B}..HEAD`], {
    stdout: "1\n",
  });
  state.runner.set(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "log",
      "--reverse",
      "--topo-order",
      "--format=%B%x1e",
      `${B}..HEAD`,
    ],
    { stdout: `${RETIRE_KEEP_SUBJECT}\nFork-Domain: web\n\x1e` },
  );
  try {
    execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    const checked = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
    assert.strictEqual(checked.stage, "checked");
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("retire enacts exactly one subject: other count or message changes still fail", () => {
  const keptMessages = `${RETIRE_KEEP_SUBJECT}\nFork-Domain: web\n\x1e`;
  // Extra drop beyond the one retired commit -> count still throws
  {
    const s = retireReplay();
    try {
      const replayed = validateReport(JSON.parse(NodeFS.readFileSync(s.reportPath, "utf8")));
      const retired: SyncReport = {
        ...replayed,
        recordDecisions: [{ subject: RETIRE_SUBJECT, action: "retire", decidedBy: "human" }],
      };
      NodeFS.writeFileSync(s.reportPath, JSON.stringify(retired));
      signRecord(retired.recordPath, "retire", "human");
      s.runner.set("git", ["-c", "core.commentChar=auto", "rev-list", "--count", `${B}..HEAD`], {
        stdout: "0\n",
      });
      s.runner.set(
        "git",
        [
          "-c",
          "core.commentChar=auto",
          "log",
          "--reverse",
          "--topo-order",
          "--format=%B%x1e",
          `${B}..HEAD`,
        ],
        { stdout: "" },
      );
      assert.throws(
        () => execute(["unblock-check", "--report", s.reportPath], s.root, s.runner),
        /replay commit count changed/,
      );
    } finally {
      NodeFS.rmSync(s.root, { recursive: true, force: true });
      NodeFS.rmSync(s.worktree, { recursive: true, force: true });
      NodeFS.rmSync(NodePath.dirname(s.reportPath), { recursive: true, force: true });
    }
  }
  // Same count but wrong message -> messages still throw
  {
    const s = retireReplay();
    try {
      const replayed = validateReport(JSON.parse(NodeFS.readFileSync(s.reportPath, "utf8")));
      const retired: SyncReport = {
        ...replayed,
        recordDecisions: [{ subject: RETIRE_SUBJECT, action: "retire", decidedBy: "human" }],
      };
      NodeFS.writeFileSync(s.reportPath, JSON.stringify(retired));
      signRecord(retired.recordPath, "retire", "human");
      s.runner.set("git", ["-c", "core.commentChar=auto", "rev-list", "--count", `${B}..HEAD`], {
        stdout: "1\n",
      });
      s.runner.set(
        "git",
        [
          "-c",
          "core.commentChar=auto",
          "log",
          "--reverse",
          "--topo-order",
          "--format=%B%x1e",
          `${B}..HEAD`,
        ],
        { stdout: "feat(web): tampered\n\x1e" },
      );
      assert.throws(
        () => execute(["unblock-check", "--report", s.reportPath], s.root, s.runner),
        /replay commit messages changed/,
      );
    } finally {
      NodeFS.rmSync(s.root, { recursive: true, force: true });
      NodeFS.rmSync(s.worktree, { recursive: true, force: true });
      NodeFS.rmSync(NodePath.dirname(s.reportPath), { recursive: true, force: true });
    }
  }
  // No retire at all: any count change still throws (pre-existing guard)
  {
    const s = replayedRun();
    try {
      s.runner.set("git", ["-c", "core.commentChar=auto", "rev-list", "--count", `${B}..HEAD`], {
        stdout: "0\n",
      });
      s.runner.set(
        "git",
        [
          "-c",
          "core.commentChar=auto",
          "log",
          "--reverse",
          "--topo-order",
          "--format=%B%x1e",
          `${B}..HEAD`,
        ],
        { stdout: "" },
      );
      assert.throws(
        () => execute(["unblock-check", "--report", s.reportPath], s.root, s.runner),
        /replay commit count changed/,
      );
    } finally {
      NodeFS.rmSync(s.root, { recursive: true, force: true });
      NodeFS.rmSync(s.worktree, { recursive: true, force: true });
      NodeFS.rmSync(NodePath.dirname(s.reportPath), { recursive: true, force: true });
    }
  }
  void keptMessages;
});

const REPLAY_LOG_ARGS = [
  "-c",
  "core.commentChar=auto",
  "log",
  "--reverse",
  "--topo-order",
  "--format=%B%x1e",
  `${B}..HEAD`,
];

// The two rewrites `git rebase` applies to a stored message, both measured on the live stack:
// a `%B` captured without its trailing newline comes back with one, and a blank run before the
// trailers collapses to a single blank line.
const DRIFTED_ORIGINAL_MESSAGES =
  "feat(web): add sidebar group membership actions\nFork-Domain: project-windows\nFork-Tier: core" +
  "\x1e\n" +
  "fix(server): reconcile managed sessions after branch changes\n\n\nFork-Domain: fork-meta\nFork-Tier: bugfix\n" +
  "\x1e";

const CLEANED_REPLAY_MESSAGES =
  "feat(web): add sidebar group membership actions\nFork-Domain: project-windows\nFork-Tier: core\n" +
  "\x1e\n" +
  "fix(server): reconcile managed sessions after branch changes\n\nFork-Domain: fork-meta\nFork-Tier: bugfix\n" +
  "\x1e";

const driftedReplay = (
  replayedMessages: string,
): { runner: FakeRunner; root: string; worktree: string; reportPath: string; branch: string } => {
  const state = replayedRun();
  setCiSuccess(state.runner, state.branch);
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  const next: SyncReport = {
    ...replayed,
    originalMessages: DRIFTED_ORIGINAL_MESSAGES,
    originalCount: 2,
  };
  NodeFS.writeFileSync(next.reportPath, JSON.stringify(next));
  NodeFS.writeFileSync(next.recordPath, renderRecord(next));
  state.runner.set("git", ["-c", "core.commentChar=auto", "rev-list", "--count", `${B}..HEAD`], {
    stdout: "2\n",
  });
  state.runner.set("git", REPLAY_LOG_ARGS, { stdout: replayedMessages });
  return state;
};

it("accepts git's own message cleanup on replay but not an edited trailer", () => {
  {
    const s = driftedReplay(CLEANED_REPLAY_MESSAGES);
    try {
      execute(["unblock-check", "--report", s.reportPath], s.root, s.runner);
      assert.strictEqual(
        validateReport(JSON.parse(NodeFS.readFileSync(s.reportPath, "utf8"))).stage,
        "checked",
      );
    } finally {
      NodeFS.rmSync(s.root, { recursive: true, force: true });
      NodeFS.rmSync(s.worktree, { recursive: true, force: true });
      NodeFS.rmSync(NodePath.dirname(s.reportPath), { recursive: true, force: true });
    }
  }
  // Normalization moves whitespace only: a trailer whose value changed is still a changed message.
  {
    const s = driftedReplay(
      CLEANED_REPLAY_MESSAGES.replace("Fork-Tier: bugfix", "Fork-Tier: core"),
    );
    try {
      assert.throws(
        () => execute(["unblock-check", "--report", s.reportPath], s.root, s.runner),
        /replay commit messages changed/,
      );
    } finally {
      NodeFS.rmSync(s.root, { recursive: true, force: true });
      NodeFS.rmSync(s.worktree, { recursive: true, force: true });
      NodeFS.rmSync(NodePath.dirname(s.reportPath), { recursive: true, force: true });
    }
  }
});

const finishedRebaseLane = (): {
  runner: FakeRunner;
  root: string;
  worktree: string;
  gitDir: string;
  state: SyncReport;
} => {
  const root = fixtureRoot();
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-lane-"));
  const gitDir = NodePath.join(worktree, ".git");
  NodeFS.mkdirSync(gitDir, { recursive: true });
  const state = report(root, {
    stage: "conflicts",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: "rehearse/v1.2.3-from-cccccccccccc", worktree },
    originalMessages: "feat: one\x1e",
    originalCount: 1,
    conflicts: [
      {
        commit: C,
        subject: "fix(web): preserve scoped behavior",
        domain: "fork-meta",
        path: "apps/web/src/a.ts",
        class: "seam-moved",
        resolution: "preserve upstream hook",
        agentSafe: "yes — tested",
        decidedBy: "human",
      },
    ],
  });
  NodeFS.writeFileSync(state.reportPath, JSON.stringify(state));
  NodeFS.writeFileSync(state.recordPath, renderRecord(state));
  const runner = new FakeRunner();
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "--git-dir"], {
    stdout: `${gitDir}\n`,
  });
  runner.set("git", ["-c", "core.commentChar=auto", "rev-list", "--count", `${B}..HEAD`], {
    stdout: "1\n",
  });
  runner.set("git", REPLAY_LOG_ARGS, { stdout: "feat: one\x1e" });
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${A}\n` });
  return { runner, root, worktree, gitDir, state };
};

// A worker that dies between `git rebase --continue` and the replayed write leaves a finished
// rebase behind, and `--continue` can only answer `No rebase in progress?` from there.
it("verifies a rehearsal whose rebase already finished instead of continuing it", () => {
  const { runner, root, worktree, state } = finishedRebaseLane();
  try {
    execute(["unblock-rehearse", "--report", state.reportPath], root, runner);
    assert.strictEqual(
      validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8"))).stage,
      "replayed",
    );
    assert.isFalse(runner.calls.some(({ args }) => args.includes("rebase")));
    assert.isTrue(
      runner.calls.some(({ args }) =>
        args.join(" ").includes(`merge-base --is-ancestor ${B} HEAD`),
      ),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("refuses a lane that holds no rebase and no replayed stack either", () => {
  const { runner, root, worktree, state } = finishedRebaseLane();
  runner.set("git", ["-c", "core.commentChar=auto", "rev-list", "--count", `${B}..HEAD`], {
    stdout: "0\n",
  });
  try {
    assert.throws(
      () => execute(["unblock-rehearse", "--report", state.reportPath], root, runner),
      /no rebase is in progress and the lane does not hold the replayed stack: it holds 0 commits, expected 1/,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("continues the rebase whenever its state directory is still there", () => {
  const { runner, root, worktree, gitDir, state } = finishedRebaseLane();
  NodeFS.mkdirSync(NodePath.join(gitDir, "rebase-merge"), { recursive: true });
  try {
    execute(["unblock-rehearse", "--report", state.reportPath], root, runner);
    assert.isTrue(
      runner.calls.some(
        ({ command, args }) => command === "git" && args.join(" ").endsWith("rebase --continue"),
      ),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("neutralises the comment char on every rehearsal git call, not one shell", () => {
  const { runner, root, worktree } = checkedRun();
  try {
    const rehearsal = runner.calls.filter(
      (call) => call.command === "git" && call.cwd === worktree,
    );
    assert.isAbove(rehearsal.length, 3);
    for (const call of rehearsal) {
      assert.deepStrictEqual(call.args.slice(0, 2), ["-c", "core.commentChar=auto"]);
      assert.strictEqual(call.env?.GIT_CONFIG_COUNT, "1");
      assert.strictEqual(call.env?.GIT_CONFIG_KEY_0, "core.commentChar");
      assert.strictEqual(call.env?.GIT_CONFIG_VALUE_0, "auto");
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
  }
});

it("pins histogram diff on every rehearsal rebase", () => {
  assert.include(rehearsalRebaseArgs(["rebase", B]).join(" "), "diff.algorithm=histogram");
  assert.deepStrictEqual(rehearsalRebaseArgs(["rebase", B]).slice(0, 4), [
    "-c",
    "core.commentChar=auto",
    "-c",
    "diff.algorithm=histogram",
  ]);
});

it("strips the completed gate 1 stop from the record's automerged overlap review", () => {
  const root = fixtureRoot();
  const orientation = [
    "## Automerged overlap",
    "  - a.ts",
    "",
    "## Stop",
    "",
    "Continue only after the human confirms the target.",
  ].join("\n");
  const state = report(root, {
    orientation,
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: `rehearse/v1.2.3-from-${C.slice(0, 12)}`, worktree: root },
    stage: "checked",
    installedHead: C,
  });
  try {
    const record = renderRecord(state);
    assert.include(record, "## Automerged overlap");
    assert.notInclude(record, "Continue only after the human confirms the target");
    assert.notInclude(record, "## Stop");
    // orientation helpers still parse the full orientation
    const { orientationReviewSection, orientationTouchedPaths } = require("./fork-sync-state.ts");
    assert.deepStrictEqual(orientationTouchedPaths(orientation), ["a.ts"]);
    assert.notInclude(orientationReviewSection(orientation), "Continue only");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("accepts repeated --silent-seam on unblock-check", () => {
  const root = fixtureRoot();
  const lane = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-lane-"));
  NodeFS.mkdirSync(NodePath.join(lane, "node_modules", ".bin"), { recursive: true });
  const state = report(root, {
    stage: "replayed",
    target: { tag: "v1.2.3", sha: B },
    lane: { branch: `rehearse/v1.2.3-from-${C.slice(0, 12)}`, worktree: lane },
    rebasedHead: C,
  });
  NodeFS.writeFileSync(state.reportPath, JSON.stringify(state));
  // Make pnpm-lock.yaml readable via git show HEAD:pnpm-lock.yaml
  NodeFS.mkdirSync(NodePath.join(lane, ".git"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(lane, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\\n");
  // Directly test the parsing layer: parseVerbArgs allows repeatable --silent-seam.
  const { parseVerbArgs } = require("./fork-sync-state.ts");
  const parsed = parseVerbArgs([
    "unblock-check",
    "--report",
    state.reportPath,
    "--silent-seam",
    "a.ts=first:type",
    "--silent-seam",
    "b.ts=second:behaviour",
  ]);
  const raw = parsed.values.get("--silent-seam") ?? "";
  assert.include(raw, "a.ts=first:type");
  assert.include(raw, "b.ts=second:behaviour");
  const seams = raw.split("\n").filter(Boolean);
  assert.lengthOf(seams, 2);
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  NodeFS.rmSync(lane, { recursive: true, force: true });
});

it("accepts --silent-seam on unblock-auto", () => {
  const { parseVerbArgs } = require("./fork-sync-state.ts");
  const parsed = parseVerbArgs([
    "unblock-auto",
    "--report",
    "/tmp/report.json",
    "--silent-seam",
    "a.ts=fix:type",
  ]);
  assert.strictEqual(parsed.values.get("--silent-seam"), "a.ts=fix:type");
  // Also verify unblockAuto acceptOnly allows it (no throw via execute with missing report still validates verb)
  const runner = new FakeRunner();
  runner.set("git", ["rev-parse", "--show-toplevel"], { stdout: "/tmp\n" });
  // The verb parsing itself should not reject the flag
  const { values } = parsed;
  // assertOnly is tested indirectly via unblockAuto; just check parse passed
  assert.isTrue(values.has("--silent-seam"));
});

it("unblock-refresh invalidates stale checked evidence and records generated provenance", async () => {
  const root = fixtureRoot();
  const lane = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-lane-"));
  // init a git repo in lane so rev-parse HEAD works
  NodeChildProcess.execFileSync("git", ["init", "-b", "main"], { cwd: lane });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: lane });
  NodeChildProcess.execFileSync("git", ["config", "user.name", "t"], { cwd: lane });
  NodeFS.writeFileSync(NodePath.join(lane, "base.txt"), "base");
  NodeChildProcess.execFileSync("git", ["add", "."], { cwd: lane });
  NodeChildProcess.execFileSync("git", ["commit", "-m", "base"], { cwd: lane });
  // The lane's target is a real commit, so the refresh can rebind the stack size against it.
  const baseHead = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: lane })
    .toString()
    .trim();
  NodeFS.writeFileSync(NodePath.join(lane, "file.txt"), "v1");
  NodeChildProcess.execFileSync("git", ["add", "."], { cwd: lane });
  NodeChildProcess.execFileSync("git", ["commit", "-m", "init"], { cwd: lane });
  const firstHead = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: lane })
    .toString()
    .trim();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const proposer = {
    iface: "codex",
    provider: "openai",
    model: "gpt-5.6-sol",
    session: "walk-1",
  };
  const generatedConflict = {
    commit: C,
    subject: "feat(web): generated lock drift",
    domain: "fork-meta",
    path: "pnpm-lock.yaml",
    class: "generated" as const,
    resolution: "restore HEAD and regenerate",
    agentSafe: "yes — regenerated by unblock-rehearse",
    decidedBy: "TODO" as const,
  };
  const silentSeams = [
    { path: "apps/web/src/a.ts", summary: "retained adapter", touchesBehaviour: true },
  ];
  const state = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: baseHead },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: lane },
    rebasedHead: firstHead,
    stackSize: 7,
    installedHead: firstHead,
    ciHead: firstHead,
    conflicts: [generatedConflict],
    silentSeams,
    proposedBy: proposer,
    nightlyReview: {
      status: "withheld",
      proposer,
      reviewer: { ...proposer, session: "review-1" },
      reviewedAt: "2026-09-04T00:00:00.000Z",
      reason: "old head",
    },
    verification: [{ command: "hyprws CI https://example.test/runs/old", result: "passed" }],
  });
  NodeFS.writeFileSync(state.reportPath, JSON.stringify(state));
  // Simulate a lane rewrite (amend)
  NodeFS.writeFileSync(NodePath.join(lane, "file.txt"), "v2");
  NodeChildProcess.execFileSync("git", ["add", "."], { cwd: lane });
  NodeChildProcess.execFileSync("git", ["commit", "--amend", "--no-edit"], { cwd: lane });
  const secondHead = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: lane })
    .toString()
    .trim();
  assert.notEqual(firstHead, secondHead);
  const runner = new SystemRunner();
  const refreshed = execute(["unblock-refresh", "--report", state.reportPath], root, runner);
  assert.strictEqual(refreshed.stage, "replayed");
  assert.strictEqual(refreshed.rebasedHead, secondHead);
  // The head and the stack size are one binding; a refresh that moved only the head would publish
  // a record the apply gate reads as disagreeing with its own checkout.
  assert.strictEqual(refreshed.stackSize, 1);
  assert.isUndefined(refreshed.installedHead);
  assert.isUndefined(refreshed.ciHead);
  assert.deepStrictEqual(refreshed.verification, []);
  assert.isUndefined(refreshed.proposedBy);
  assert.isUndefined(refreshed.nightlyReview);
  assert.deepStrictEqual(refreshed.silentSeams, silentSeams);
  assert.deepInclude(refreshed.conflicts[0], {
    ...generatedConflict,
    decidedBy: "agent",
  });
  const record = NodeFS.readFileSync(refreshed.recordPath, "utf8");
  assert.include(record, secondHead);
  assert.include(record, "- Stack size: `1` fork commits");
  assert.include(
    record,
    "| generated | restore HEAD and regenerate | yes — regenerated by unblock-rehearse | agent |",
  );
  assert.notInclude(record, "hyprws CI https://example.test/runs/old");
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(lane, { recursive: true, force: true });
  NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
});

const decision = (overrides: Partial<WalkDecision> = {}): WalkDecision => ({
  kind: "conflict",
  subject: "a".repeat(64),
  outcome: "manual",
  decidedBy: "human",
  tag: "v0.0.1-nightly.20260901.1",
  recordedAt: "2026-09-07T03:14:15.926Z",
  ...overrides,
});

// The seam key is git's own diff3 hunk split, so these run real git rather than a fake.
it("keys a seam by content, not by position or whitespace", () => {
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-seam-"));
  try {
    const base = "ctx\nold\nctx2\n";
    const ours = "ctx\nupstream\nctx2\n";
    const theirs = "ctx\nfork\nctx2\n";
    const runner = new SystemRunner();
    const key = seamKey(runner, worktree, { path: "p.txt", base, ours, theirs });
    assert.isDefined(key);
    // The same seam one line lower in every side keeps its key.
    const shifted = seamKey(runner, worktree, {
      path: "p.txt",
      base: `lead\n${base}`,
      ours: `lead\n${ours}`,
      theirs: `lead\n${theirs}`,
    });
    assert.strictEqual(shifted, key);
    // A conflict-free merge has no seam to name.
    assert.isNull(seamKey(runner, worktree, { path: "p.txt", base, ours: base, theirs }));
    // A different conflict on the same path is a different seam.
    const changed = seamKey(runner, worktree, {
      path: "p.txt",
      base,
      ours: "ctx\nupstream two\nctx2\n",
      theirs,
    });
    assert.notEqual(changed, key);
  } finally {
    NodeFS.rmSync(worktree, { recursive: true, force: true });
  }
});

it("round-trips decision records through the rendered record", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-decisions-"));
  try {
    const records: ReadonlyArray<WalkDecision> = [
      decision(),
      decision({
        kind: "stop",
        subject: "scripts/seam.txt",
        path: "scripts/seam.txt",
        outcome: "conflict",
      }),
      decision({
        decidedBy: "rerere",
        from: "v0.0.1-nightly.20260801.1",
      }),
      decision({
        kind: "retire",
        subject: "add fork telemetry",
        outcome: "retired",
        decidedBy: "machine",
      }),
      decision({ subject: "weird | subject", path: "pa|th\\x" }),
    ];
    const reportPath = NodePath.join(root, "report.json");
    const recordPath = NodePath.join(root, "record.md");
    const report = validateReport({
      schemaVersion: 1,
      stage: "conflicts",
      kind: "unblock",
      repositoryRoot: root,
      reportPath,
      recordPath,
      issue: { number: 662, blockingSha: A, title: "blocked" },
      candidates: [{ tag: decision().tag, sha: A }],
      target: { tag: decision().tag, sha: A },
      source: { sha: A, expectedOld: A, sharedBase: A },
      conflicts: [],
      verification: [],
      decisions: records,
    } as unknown);
    const parsed = parseDecisionRecords(renderRecord(report));
    assert.deepStrictEqual(parsed.map(walkDecisionIdentity), records.map(walkDecisionIdentity));
    // Rendering the parse of a render is the same record: no drift across a save/load cycle.
    assert.deepStrictEqual(
      parseDecisionRecords(renderRecord({ ...report, decisions: parsed })).map(
        walkDecisionIdentity,
      ),
      records.map(walkDecisionIdentity),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("requires well-formed walk decisions and appends without duplicating", () => {
  assert.throws(() => requireWalkDecisions([{ kind: "nope" }], "walkDecisions"));
  assert.throws(() => requireWalkDecisions([{ ...decision(), recordedAt: "yesterday" }], "rows"));
  const first = decision();
  const carried = appendDecision([first], decision({ from: "t0" }));
  // Re-deriving the carried decision replaces it instead of appending a second record.
  const rows = appendDecision(carried, decision({ from: "t0" }));
  assert.deepStrictEqual(rows.map(walkDecisionIdentity), carried.map(walkDecisionIdentity));
  assert.strictEqual(
    decisionLine(first),
    `- \`${"a".repeat(64)}\` (conflict, manual, human, 2026-09-07T03:14:15.926Z)`,
  );
});

it("keeps a pending stopped walk out of the census snapshot set", () => {
  const pendingRow = {
    tag: "t1",
    before: A,
    after: A,
    recordUrl: "https://example.test/r1",
    conflicts: [],
    decisions: [],
    censusFiles: [{ path: "scripts/seam.txt", hunks: 1, commit: A, domain: "fork-meta" }],
    walkDecisions: [decision()],
    pending: true,
  };
  const ledger = parseLedger(JSON.stringify([pendingRow]));
  assert.deepStrictEqual(
    ledger.map((row) => row.pending),
    [true],
  );
  // A snapshot describes a landed stack, and a stopped walk landed nothing: its census cannot
  // extend a run even though the document now lists the walk itself.
  assert.deepStrictEqual(censusChurn([ledger[0]!]).hotPaths, []);
});

it("lists a pending stopped walk in hot seams and the rendered walks table", () => {
  const conflict = {
    path: "scripts/seam.txt",
    commit: A,
    subject: "feat: seam",
    domain: "fork-meta",
    class: "human",
    resolution: "resolved by hand",
    decidedBy: "human",
  };
  const pendingRow = {
    tag: "t1",
    before: A,
    after: A,
    recordUrl: "https://example.test/r1",
    conflicts: [conflict],
    decisions: [],
    censusFiles: [{ path: "scripts/seam.txt", hunks: 1, commit: A, domain: "fork-meta" }],
    walkDecisions: [decision()],
    pending: true,
  };
  const finishedRow = { ...pendingRow, tag: "t2", pending: undefined };
  const ledger = parseLedger(JSON.stringify([pendingRow, finishedRow]));
  assert.deepStrictEqual(
    ledger.map((row) => row.pending),
    [true, undefined],
  );
  assert.deepStrictEqual(ledger[1]?.walkDecisions?.map(walkDecisionIdentity), [
    walkDecisionIdentity(decision()),
  ]);
  // A seam that stops a walk repeatedly is hot by definition, so the stopped walk's conflict
  // counts, and the walks table renders the stop in the Range cell.
  assert.strictEqual(hotSeams([ledger[0]!]).length, 1);
  assert.strictEqual(hotSeams([ledger[1]!]).length, 1);
  const document = renderMarkdown([ledger[0]!], "");
  assert.include(document, "scripts/seam.txt");
  assert.include(document, "\u2192 **stopped**");
});

const RECORD_SHIM = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const state = process.env.FIXTURE_STATE;
const body = fs.readFileSync(process.env.FIXTURE_ISSUE_BODY, "utf8");
const commentsFile = path.join(state, "comments.json");
const comments = fs.existsSync(commentsFile) ? JSON.parse(fs.readFileSync(commentsFile, "utf8")) : [];
const issueUrl = "https://example.test/issues/662";
if (argv[0] === "issue" && argv[1] === "list") {
  process.stdout.write(JSON.stringify([{ number: 662, title: "blocked", body }]));
} else if (argv[0] === "issue" && argv[1] === "view") {
  if (argv.includes("--comments")) process.stdout.write("comments\\n");
  else process.stdout.write(JSON.stringify({ body, url: issueUrl, comments }));
} else if (argv[0] === "issue" && argv[1] === "comment") {
  const file = argv.indexOf("--body-file");
  const inline = argv.indexOf("--body");
  const text = file !== -1 ? fs.readFileSync(argv[file + 1], "utf8") : argv[inline + 1];
  const commentUrl = issueUrl + "#issuecomment-" + (comments.length + 1);
  comments.push({ url: commentUrl, body: text });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(commentsFile, JSON.stringify(comments));
  process.stdout.write(commentUrl + "\\n");
} else {
  process.stdout.write("[]\\n");
}
`;

const TOOL_SHIM = `#!${process.execPath}
const fs = require("node:fs");
const script = process.argv[2] ?? "";
if (script.endsWith("fork-orient.ts")) {
  process.stdout.write(fs.readFileSync(process.env.FIXTURE_ORIENT, "utf8"));
}
process.exit(0);
`;

/**
 * One temp remote, two consecutive tags: the whole shape RSI-Software/t3code-hyprws#662 is about.
 * Tag A's walk stops `conflict` on a seam the outcome executor may not decide; the human resolves
 * it by hand and `record-decisions` saves the resolution to the shared rerere ref plus a pending
 * ledger row; the tag B walk then applies with zero stops, resolving the seam from the record.
 */
it("never asks twice: a hand-resolved seam resolves from the record on the next tag", () => {
  const git = (args: ReadonlyArray<string>, cwd: string): string =>
    NodeChildProcess.execFileSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })
      .toString()
      .trim();
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-record-"));
  const remote = NodePath.join(root, "remote.git");
  const bin = NodePath.join(root, "bin");
  const previous: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HYPRWS_AUTO_REBASE: process.env.HYPRWS_AUTO_REBASE,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    FIXTURE_STATE: process.env.FIXTURE_STATE,
    FIXTURE_ISSUE_BODY: process.env.FIXTURE_ISSUE_BODY,
    FIXTURE_ORIENT: process.env.FIXTURE_ORIENT,
  };
  try {
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(bin, "gh"), RECORD_SHIM, { mode: 0o755 });
    NodeFS.writeFileSync(NodePath.join(bin, "vp"), TOOL_SHIM, { mode: 0o755 });
    NodeFS.writeFileSync(NodePath.join(bin, "node"), TOOL_SHIM, { mode: 0o755 });
    git(["init", "-q", "-b", "main"], root);
    git(["config", "user.name", "test"], root);
    git(["config", "user.email", "test@example.invalid"], root);
    NodeFS.mkdirSync(NodePath.join(root, ".github", "workflows"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(root, ".github", "workflows", "hyprws-upstream-sync.yml"),
      'on:\n  schedule:\n    - cron: "23 */4 * * *"\n',
    );
    NodeFS.writeFileSync(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    NodeFS.mkdirSync(NodePath.join(root, "scripts"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "scripts/fixture-seam.txt"), "l1\nshared\nl3\n");
    NodeFS.writeFileSync(NodePath.join(root, "scripts/fixture-keep-both.ts"), "k1\n");
    git(["add", "."], root);
    git(["commit", "-q", "-m", "u0 base"], root);
    const blockingSha = git(["rev-parse", "HEAD"], root);
    git(["branch", "upstream/main"], root);
    NodeFS.writeFileSync(NodePath.join(root, "scripts/fixture-seam.txt"), "l1\nFORK\nl3\n");
    NodeFS.appendFileSync(NodePath.join(root, "scripts/fixture-keep-both.ts"), "FORK-KEEP\n");
    git(["add", "."], root);
    git(
      [
        "commit",
        "-q",
        "-m",
        "feat(fork): fixture seam\n\nFork-Domain: fork-meta\nFork-Tier: core\n",
      ],
      root,
    );
    git(["checkout", "-q", "upstream/main"], root);
    NodeFS.writeFileSync(NodePath.join(root, "scripts/fixture-seam.txt"), "l1\nUPSTREAM\nl3\n");
    NodeFS.appendFileSync(NodePath.join(root, "scripts/fixture-keep-both.ts"), "UP-KEEP\n");
    git(["commit", "-aqm", "u1 upstream"], root);
    git(["tag", "v0.0.1-nightly.20260901.1"], root);
    NodeFS.writeFileSync(NodePath.join(root, "scripts/fixture-seam.txt"), "l0\nl1\nUPSTREAM\nl3\n");
    NodeFS.appendFileSync(NodePath.join(root, "scripts/fixture-keep-both.ts"), "UP-KEEP-2\n");
    git(["commit", "-aqm", "u2 upstream"], root);
    git(["tag", "v0.0.1-nightly.20260902.1"], root);
    git(["checkout", "-q", "main"], root);
    git(["init", "-q", "--bare", remote], root);
    git(["remote", "add", "origin", remote], root);
    git(["push", "-q", "origin", "main:refs/heads/hyprws"], root);
    git(["fetch", "-q", "origin"], root);
    writeBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE, "[]\n", "churn: fixture");
    NodeChildProcess.execFileSync("git", ["push", "-q", remote, `${CHURN_REF}:${CHURN_REF}`], {
      cwd: root,
    });
    const issueBody = NodePath.join(root, "issue-body.md");
    NodeFS.writeFileSync(
      issueBody,
      [
        "Blocked.",
        `<!-- blocking-sha:${blockingSha} -->`,
        "",
        "## Sequential rebase census",
        "",
        "<!-- prettier-ignore -->",
        "| File | Hunks | Fork commit | Domain |",
        "| --- | ---: | --- | --- |",
        "| `scripts/fixture-seam.txt` | 1 | `abcdef12345 feat(fork): fixture seam` | fork-meta |",
        "",
      ].join("\n"),
    );
    const orientation = NodePath.join(root, "orientation.txt");
    NodeFS.writeFileSync(
      orientation,
      [
        `mirror:  origin/main matches upstream/main at ${blockingSha.slice(0, 12)}`,
        "",
        "## Automerged overlap",
        "",
        "None.",
        "",
      ].join("\n"),
    );
    process.env.PATH = `${bin}:${previous.PATH ?? ""}`;
    process.env.FIXTURE_STATE = NodePath.join(root, "gh-state");
    process.env.FIXTURE_ISSUE_BODY = issueBody;
    process.env.FIXTURE_ORIENT = orientation;
    process.env.HYPRWS_AUTO_REBASE = "on";
    process.env.GITHUB_RUN_ID = "424242";
    const runner = new SystemRunner();
    const tagA = "v0.0.1-nightly.20260901.1";
    const tagB = "v0.0.1-nightly.20260902.1";

    // Tag A: the walk stops on the seam the executor declines.
    let stopCode = 0;
    const stoppedWalk = captureStdout(() =>
      withCapturedStderr(() => {
        stopCode = run(["unblock-auto", "--target", tagA, "--bot-carried"], root, runner);
      }),
    );
    assert.strictEqual(stopCode, 2, stoppedWalk.output);
    const reportPath = /^(\S+\/report\.json)$/m.exec(stoppedWalk.output)?.[1] ?? "";
    const stopped = validateReport(JSON.parse(NodeFS.readFileSync(reportPath, "utf8")));
    assert.strictEqual(stopped.stage, "conflicts");
    assert.strictEqual(stopped.walk?.stop?.reason, "conflict");
    // The walk mints its lane in its own tmpdir; only its path is read here, never deleted.
    const lane = stopped.lane?.worktree ?? "";
    assert.match(lane, /^\/tmp\//);
    // The declined row carries its seam key; the executor's keep-both row is decided and only the
    // declined seam reaches the human.
    const seamRow = stopped.conflicts.find((row) => row.path === "scripts/fixture-seam.txt");
    assert.isDefined(seamRow?.seamKey);
    assert.strictEqual(seamRow?.agentSafe, "TODO");
    const keepBothRow = stopped.conflicts.find(
      (row) => row.path === "scripts/fixture-keep-both.ts",
    );
    assert.strictEqual(keepBothRow?.agentSafe, "true");
    assert.isDefined(
      (stopped.decisions ?? []).find(
        (row) => row.outcome === "keep-both" && row.decidedBy === "machine",
      ),
    );

    // The human resolves the seam by hand in the lane, then records it.
    NodeFS.writeFileSync(NodePath.join(lane, "scripts/fixture-seam.txt"), "l1\nRESOLVED\nl3\n");
    git(["add", "scripts/fixture-seam.txt"], lane);
    const recorded = execute(
      ["record-decisions", "--report", reportPath, "--tag", tagA],
      root,
      runner,
    );
    const humanDecision = (recorded.decisions ?? []).find(
      (row) =>
        row.kind === "conflict" &&
        row.decidedBy === "human" &&
        row.outcome === "manual" &&
        row.path === "scripts/fixture-seam.txt",
    );
    assert.strictEqual(humanDecision?.subject, seamRow?.seamKey);
    assert.strictEqual(humanDecision?.outcome, "manual");
    assert.strictEqual(humanDecision?.tag, tagA);
    // The shared cache advanced on origin and carries the human's resolution.
    const rerereListing = git(["ls-tree", "-r", RERERE_REF], remote);
    const postimageSha =
      /^100644 blob ([0-9a-f]{40})\t.+postimage$/m.exec(rerereListing)?.[1] ?? "";
    assert.notEqual(postimageSha, "");
    assert.include(git(["cat-file", "blob", postimageSha], remote), "RESOLVED");
    // The ledger carries one pending row with the human decision.
    const ledgerAfterRecord = parseLedger(
      readBotRefFile(remote, CHURN_REF, CHURN_LEDGER_FILE) ?? "",
    );
    assert.strictEqual(ledgerAfterRecord.length, 1);
    assert.strictEqual(ledgerAfterRecord[0]?.pending, true);
    assert.strictEqual(ledgerAfterRecord[0]?.tag, tagA);
    assert.strictEqual(
      ledgerAfterRecord[0]?.walkDecisions?.filter(
        (row) =>
          row.kind === "conflict" && row.decidedBy === "human" && row.subject === seamRow?.seamKey,
      ).length,
      1,
    );

    // Tag B: forget the local cache, restore it from the ref exactly as the carry does, and walk.
    // The same seam conflicts again one line lower; the record must answer it.
    NodeFS.rmSync(NodePath.join(root, ".git", "rr-cache"), { recursive: true, force: true });
    assert.strictEqual(carryRun(["rerere-restore"], root), 0);
    let applyCode = 0;
    const appliedWalk = captureStdout(() =>
      withCapturedStderr(() => {
        applyCode = run(["unblock-auto", "--target", tagB, "--bot-carried"], root, runner);
      }),
    );
    assert.strictEqual(applyCode, 0, appliedWalk.output);
    const appliedReportPath = /^(\S+\/report\.json)$/m.exec(appliedWalk.output)?.[1] ?? "";
    const applied = validateReport(JSON.parse(NodeFS.readFileSync(appliedReportPath, "utf8")));
    assert.strictEqual(applied.stage, "applied");
    assert.isUndefined(applied.walk?.stop);
    // Zero stops: rerere replayed the human resolution and the record names where it came from.
    const rerereDecision = (applied.decisions ?? []).find(
      (row) => row.decidedBy === "rerere" && row.subject === seamRow?.seamKey,
    );
    assert.strictEqual(rerereDecision?.from, tagA);
    assert.strictEqual(rerereDecision?.outcome, "manual");
    assert.isDefined(
      (applied.decisions ?? []).find(
        (row) => row.decidedBy === "machine" && row.outcome === "keep-both",
      ),
    );
    // The applied row carries both records; across both rows the seam has exactly one human and
    // one rerere decision.
    const ledgerAfter = parseLedger(readBotRefFile(remote, CHURN_REF, CHURN_LEDGER_FILE) ?? "");
    assert.deepStrictEqual(ledgerAfter.map((row) => row.tag).toSorted(), [tagA, tagB]);
    const rowB = ledgerAfter.find((row) => row.tag === tagB);
    assert.isUndefined(rowB?.pending);
    assert.strictEqual(
      rowB?.walkDecisions?.filter(
        (row) =>
          row.subject === seamRow?.seamKey && row.decidedBy === "rerere" && row.from === tagA,
      ).length,
      1,
    );
    const seamRecords = ledgerAfter
      .flatMap((row) => row.walkDecisions ?? [])
      .filter((row) => row.subject === seamRow?.seamKey);
    assert.deepStrictEqual(seamRecords.map((row) => row.decidedBy).toSorted(), ["human", "rerere"]);
    assert.strictEqual(git(["rev-parse", "refs/heads/hyprws"], remote), applied.installedHead);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Deletion guard: the only path this test removes is its own mkdtemp root, asserted to sit
    // directly under the OS temp directory. Lane and report directories are minted by the walk in
    // their own tmpdirs — leave them as strays rather than delete any derived path.
    if (
      root.startsWith(`${NodeOS.tmpdir()}${NodePath.sep}`) &&
      NodeFS.existsSync(root) &&
      NodeFS.realpathSync(root).startsWith(NodeFS.realpathSync(NodeOS.tmpdir()))
    )
      NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The stop-1 shape of RSI-Software/t3code-hyprws#876: a conflict-stop report whose declined row is
 * still all TODO. `record-decisions` must upgrade the row from the hand resolution, write the
 * pending ledger row, and — on a rerun of the same report — reuse the persisted record URL instead
 * of posting a second comment.
 */
it("record-decisions resolves the declined row and never comments twice (#876)", () => {
  const root = fixtureRoot();
  const lane = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-lane-"));
  NodeChildProcess.execFileSync("git", ["init", "--quiet", "-b", "rehearse/v0.0.42"], {
    cwd: lane,
  });
  NodeChildProcess.execFileSync("git", ["config", "user.name", "test"], { cwd: lane });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: lane,
  });
  const declinedPath = "apps/web/seam.ts";
  NodeFS.mkdirSync(NodePath.join(lane, "apps/web"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(lane, declinedPath), "resolved by hand\n");
  NodeChildProcess.execFileSync("git", ["add", declinedPath], { cwd: lane });
  const stopped = report(root, {
    stage: "conflicts",
    target: { tag: "v0.0.42", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch: "rehearse/v0.0.42", worktree: lane },
    orientation: "mirror: origin/main matches upstream/main at a1b2c3d",
    conflicts: rehearsalConflictRows(
      { sha: A, subject: "feat(fork): move the seam", domain: "web" },
      [declinedPath],
      [],
    ),
    walk: {
      startedAt: "2026-09-12T00:00:00.000Z",
      stop: { reason: "conflict", detail: "The outcome executor cannot produce a result." },
    },
  });
  NodeFS.writeFileSync(stopped.reportPath, JSON.stringify(stopped));
  const fixture = ledgerFixture(root, stopped.recordPath);
  const runner = new FakeRunner();
  runner.set(
    "gh",
    ["issue", "comment", "352", "-R", REPOSITORY, "--body-file", stopped.recordPath],
    { stdout: "https://example.test/record#issuecomment-1\n" },
  );
  try {
    const recorded = execute(
      ["record-decisions", "--report", stopped.reportPath, "--tag", "v0.0.42"],
      root,
      runner,
    );
    // The declined row reads resolved, not TODO, everywhere the record shows it.
    const row = recorded.conflicts.find((entry) => entry.path === declinedPath);
    assert.strictEqual(row?.class, "human");
    assert.strictEqual(row?.resolution, "resolved by hand in the lane");
    assert.strictEqual(row?.agentSafe, "no");
    assert.strictEqual(row?.decidedBy, "human");
    const recordRow = parseConflictRows(NodeFS.readFileSync(stopped.recordPath, "utf8")).find(
      (entry) => entry.path === declinedPath,
    );
    assert.strictEqual(recordRow?.class, "human");
    assert.strictEqual(recordRow?.resolution, "resolved by hand in the lane");
    assert.strictEqual(recordRow?.agentSafe, "no");
    assert.strictEqual(recordRow?.decidedBy, "human");
    // The pending append reached refs/fork/churn as a pending row for the stopped tag.
    const ledger = parseLedger(readBotRefFile(fixture.remote, CHURN_REF, CHURN_LEDGER_FILE) ?? "");
    assert.deepStrictEqual(
      ledger.map((entry) => entry.tag),
      ["v0.0.42"],
    );
    assert.strictEqual(ledger[0]?.pending, true);
    assert.lengthOf(ledger[0]?.conflicts.filter((entry) => entry.path === declinedPath) ?? [], 1);
    assert.lengthOf(
      runner.calls.filter((call) => call.command === "gh"),
      1,
    );
    // A rerun reuses the persisted record URL: no second comment, and the row stays singular.
    runner.calls.length = 0;
    execute(["record-decisions", "--report", stopped.reportPath, "--tag", "v0.0.42"], root, runner);
    assert.lengthOf(
      runner.calls.filter((call) => call.command === "gh"),
      0,
    );
    const ledgerAfter = parseLedger(
      readBotRefFile(fixture.remote, CHURN_REF, CHURN_LEDGER_FILE) ?? "",
    );
    assert.deepStrictEqual(
      ledgerAfter.map((entry) => entry.tag),
      ["v0.0.42"],
    );
  } finally {
    fixture.restore();
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(lane, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(stopped.reportPath), { recursive: true, force: true });
  }
});

/**
 * The walk reads the prior tag's record for retire decisions after rerere replays a recorded
 * human resolution (RSI-Software/t3code-hyprws#876). A stop's record carries fork-commit rows
 * whose Action cell is still TODO; the retire-only reader must tolerate them, not hard-fail.
 */
it("retire decisions tolerate the TODO Action cells a stop's record carries", () => {
  const root = fixtureRoot();
  const declinedSubject = "fix(desktop): project windows keep Settings, PRs, and Usage in-window";
  const stopped = report(root, {
    stage: "conflicts",
    target: { tag: "v0.0.42", sha: B },
    conflicts: [
      {
        commit: A,
        subject: declinedSubject,
        domain: "project-windows",
        path: "apps/web/src/routes/settings.tsx",
        class: "human",
        resolution: "resolved by hand in the lane",
        agentSafe: "no",
        decidedBy: "human",
      },
    ],
  });
  NodeFS.mkdirSync(NodePath.dirname(stopped.recordPath), { recursive: true });
  NodeFS.writeFileSync(stopped.recordPath, renderRecord(stopped));
  const record = NodeFS.readFileSync(stopped.recordPath, "utf8");
  // The record really does carry the undecidable row the walk used to choke on.
  assert.include(record, `\`${declinedSubject}\``);
  assert.include(record, "| TODO |");
  // The retire-only read tolerates it and names nothing retired from it.
  assert.deepStrictEqual([...retiredSubjectsForTest(stopped)], []);
});

describe("resumed conflict-stop lane cleanliness (#694)", () => {
  const declinedPath = "apps/web/src/components/ThreadTerminalDrawer.tsx";
  const laneBranch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;

  /** A report sitting exactly where the walk's conflict stop left it: lane mid-replay, one TODO row. */
  const stoppedReport = (root: string): SyncReport => {
    const rows = rehearsalConflictRows(
      { sha: A, subject: "feat(upstream): moved the drawer", domain: "web" },
      [declinedPath],
      [],
    );
    return report(root, {
      stage: "conflicts",
      target: { tag: "v1.2.3", sha: B },
      source: { sha: C, expectedOld: C, sharedBase: A },
      lane: { branch: laneBranch, worktree: root },
      orientation: "mirror: origin/main matches upstream/main at a1b2c3d",
      conflicts: rows,
      walk: {
        startedAt: "2026-09-09T00:00:00.000Z",
        stop: { reason: "conflict", detail: "The outcome executor cannot produce a result." },
      },
    });
  };
  /** Join NUL-separated `--porcelain -z` records the way git writes them. */
  const runnerWithStatus = (...entries: ReadonlyArray<string>): FakeRunner => {
    const runner = new FakeRunner();
    runner.set("git", ["-c", "core.commentChar=auto", "status", "--porcelain", "-z"], {
      stdout: `${entries.join("\0")}\0`,
    });
    return runner;
  };
  const cleanup = (root: string, reportPath: string): void => {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(reportPath), { recursive: true, force: true });
  };

  it("resumes when the only dirt is the staged path the conflict stop named", () => {
    const root = fixtureRoot();
    const stopped = stoppedReport(root);
    try {
      validateAutoLane(stopped, runnerWithStatus(`M  ${declinedPath}`));
    } finally {
      cleanup(root, stopped.reportPath);
    }
  });

  it("refuses dirt outside the paths the stop named, and names it", () => {
    const root = fixtureRoot();
    const stopped = stoppedReport(root);
    try {
      assert.throws(
        () =>
          validateAutoLane(
            stopped,
            runnerWithStatus(`M  ${declinedPath}`, " M scripts/fork-sync.ts"),
          ),
        /rehearsal lane worktree is not clean: scripts\/fork-sync\.ts/,
      );
    } finally {
      cleanup(root, stopped.reportPath);
    }
  });

  it("keeps a fresh walk's lane strictly clean when no conflict stop is standing", () => {
    const root = fixtureRoot();
    const fresh = { ...stoppedReport(root), walk: {} };
    try {
      assert.throws(
        () => validateAutoLane(fresh, runnerWithStatus(`M  ${declinedPath}`)),
        /rehearsal lane worktree is not clean/,
      );
    } finally {
      cleanup(root, fresh.reportPath);
    }
  });

  it("keeps an environment stop strict even at the conflicts stage", () => {
    const root = fixtureRoot();
    const stopped = {
      ...stoppedReport(root),
      walk: {
        startedAt: "2026-09-09T00:00:00.000Z",
        stop: { reason: "environment" as const, detail: "the lane cannot test" },
      },
    };
    try {
      assert.throws(
        () => validateAutoLane(stopped, runnerWithStatus(`M  ${declinedPath}`)),
        /rehearsal lane worktree is not clean/,
      );
    } finally {
      cleanup(root, stopped.reportPath);
    }
  });

  it("resumes the fill-then-resume order: a proven row's staged resolution is allowed dirt", () => {
    const root = fixtureRoot();
    const stopped = stoppedReport(root);
    const proven = {
      ...stopped,
      conflicts: stopped.conflicts.map((row) => ({
        ...row,
        resolution: "keep ours",
        agentSafe: "true",
        decidedBy: "human" as const,
      })),
    };
    try {
      validateAutoLane(proven, runnerWithStatus(`M  ${declinedPath}`));
    } finally {
      cleanup(root, stopped.reportPath);
    }
  });

  it("stops the resumed auto walk on the conflict while the decision row is still TODO", () => {
    const root = fixtureRoot();
    const stopped = stoppedReport(root);
    NodeFS.writeFileSync(stopped.reportPath, JSON.stringify(stopped));
    NodeFS.writeFileSync(stopped.recordPath, renderRecord(stopped));
    const runner = new FakeRunner();
    setBotResponses(runner, "candidate");
    setOrientationResponses(runner);
    try {
      // The auto path reaches the record check inside unblockRehearse, which the resumed
      // walkOnce loop calls before it continues the rebase — so an unclassified seam takes the
      // walk's own conflict stop before anything replays. It is a row a human owns, not a crash
      // (RSI-Software/t3code-hyprws#747).
      assert.throws(
        () => execute(["unblock-auto", "--report", stopped.reportPath], root, runner),
        /walk stopped at a retained conflict/,
      );
      const written = JSON.parse(
        NodeFS.readFileSync(stopped.reportPath, "utf8"),
      ) as unknown as SyncReport;
      assert.strictEqual(written.walk?.stop?.reason, "conflict");
      assert.include(written.walk?.stop?.detail ?? "", "The conflict handoff is incomplete:");
      assert.include(written.walk?.stop?.detail ?? "", `${declinedPath}: record row still on TODO`);
      assert.isFalse(runner.calls.some(({ args }) => args.includes("--continue")));
      assert.isFalse(runner.calls.some(({ args }) => args.includes("--skip")));
    } finally {
      cleanup(root, stopped.reportPath);
    }
  });

  it("pairs a rename record with its original path instead of counting it as dirt", () => {
    const root = fixtureRoot();
    const stopped = stoppedReport(root);
    try {
      validateAutoLane(
        stopped,
        runnerWithStatus(`R  ${declinedPath}`, "apps/web/src/components/Drawer.tsx"),
      );
    } finally {
      cleanup(root, stopped.reportPath);
    }
  });
});

describe("fold report model (RSI-Software/t3code-hyprws#920)", () => {
  const foldSource = {
    sha: A,
    sharedBase: "0".repeat(40),
    expectedOld: B,
  };
  type FoldSegmentOverride = Partial<NonNullable<SyncReport["folds"]>[number]>;
  const foldSegment = (
    overrides: FoldSegmentOverride = {},
  ): NonNullable<SyncReport["folds"]>[number] => ({
    from: "1".repeat(40),
    to: "2".repeat(40),
    onto: "3".repeat(40),
    originalCount: 2,
    originalMessages: "feat(a): one\nfix(b): two",
    ...overrides,
  });
  const folded = (root: string, folds: NonNullable<SyncReport["folds"]>): SyncReport =>
    report(root, {
      stage: "checked",
      source: foldSource,
      target: { tag: "v1.2.3", sha: C },
      lane: { branch: "rehearse/v1.2.3-from-aaaaaaaaaaaa", worktree: root },
      rebasedHead: "4".repeat(40),
      baseCheckedHead: "5".repeat(40),
      folds,
    });

  it("renders zero-fold records exactly like unfolded records and parses them back foldless", () => {
    const root = fixtureRoot();
    const plain = report(root, {
      stage: "checked",
      source: foldSource,
      target: { tag: "v1.2.3", sha: C },
    });
    const empty = { ...plain, folds: [] };
    assert.strictEqual(renderRecord(plain), renderRecord(empty));
    const record = renderRecord(plain);
    assert.include(record, `- Source: \`origin/hyprws@${B}\``);
    assert.notInclude(record, "Source incorporated");
    assert.notInclude(record, "## Folds");
    assert.strictEqual(parseFoldRecordHeader(record), undefined);
    assert.strictEqual(parseFoldSection(record), undefined);
  });

  it("round-trips a record with one fold through the header and Folds section", () => {
    const root = fixtureRoot();
    const folds = [foldSegment()];
    const record = renderRecord(folded(root, folds));
    const header = parseFoldRecordHeader(record)!;
    assert.deepStrictEqual(header, {
      originalSource: A,
      incorporatedSource: B,
      baseCheckedHead: "5".repeat(40),
      finalHead: "4".repeat(40),
    });
    const rows = parseFoldSection(record)!;
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(rows[0], {
      from: "1".repeat(40),
      to: "2".repeat(40),
      onto: "3".repeat(40),
      originalCount: 2,
      messagesDigest: foldMessagesDigest(folds[0]!.originalMessages),
      repairCommits: [],
    });
    assert.deepStrictEqual(restoreFoldSegments(folds, rows), folds);
    // parseRecord still reads the conflict tables of a folded record untouched.
    const parsed = parseRecord(record);
    assert.deepStrictEqual(parsed.conflicts, []);
  });

  it("round-trips two folds, including repair-commit subjects with escaped pipes", () => {
    const root = fixtureRoot();
    const folds = [
      foldSegment({
        checkedHead: "6".repeat(40),
        repairCommits: [{ sha: "7".repeat(40), subject: "fix: keep a | pipe and a \\ slash" }],
      }),
      foldSegment({
        from: "8".repeat(40),
        to: "9".repeat(40),
        onto: "6".repeat(40),
        replayedHead: "a".repeat(40),
        originalCount: 1,
        originalMessages: "feat(c): three",
      }),
    ];
    const record = renderRecord(folded(root, folds));
    const rows = parseFoldSection(record)!;
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows[1], {
      from: "8".repeat(40),
      to: "9".repeat(40),
      onto: "6".repeat(40),
      replayedHead: "a".repeat(40),
      originalCount: 1,
      messagesDigest: foldMessagesDigest("feat(c): three"),
      repairCommits: [],
    });
    assert.strictEqual(rows[0]!.repairCommits[0]!.subject, "fix: keep a | pipe and a \\ slash");
    assert.deepStrictEqual(restoreFoldSegments(folds, rows), folds);
  });

  it("refuses a record whose fold chain no longer matches the report", () => {
    const root = fixtureRoot();
    const folds = [foldSegment()];
    const record = renderRecord(folded(root, folds));
    const rows = parseFoldSection(record)!;
    assert.throws(
      () => restoreFoldSegments([{ ...folds[0]!, originalMessages: "feat(z): different" }], rows),
      /does not match the report/,
    );
    assert.throws(() => restoreFoldSegments([], rows), /does not match the report/);
  });

  it("validates fold fields on the report and keeps existing foldless reports valid", () => {
    const root = fixtureRoot();
    const good = folded(root, [foldSegment()]);
    validateReport(JSON.parse(JSON.stringify(good)));
    validateReport({
      ...JSON.parse(JSON.stringify(good)),
      activeFold: { index: 0, operation: "replay" },
      publication: {
        expectedOld: B,
        head: "4".repeat(40),
        recordDigest: "d".repeat(64),
      },
    });
    assert.throws(
      () => validateReport({ ...good, folds: [{ ...good.folds![0]!, from: "short" }] }),
      /invalid fold segment/,
    );
    assert.throws(
      () => validateReport({ ...good, activeFold: { index: 3, operation: "replay" } }),
      /active fold is invalid/,
    );
    assert.throws(
      () =>
        validateReport({
          ...good,
          publication: { expectedOld: B, head: "4".repeat(40), recordDigest: "nope" },
        }),
      /fold publication is invalid/,
    );
  });

  it("parses the current walk-record shape as a foldless report", () => {
    // Inline copy of a current walk record: no Folds section, no incorporated-source line.
    const record = [
      "## Header",
      "",
      `- Source: \`origin/hyprws@${"b891577fbf4bebf2974e916bcb1e64a3741783b7"}\``,
      "- Target: `v0.0.41-nightly.20260913.1625@2db675aeffd9cb1e8b5ad76ddd018433b45b02e9`",
      "- `expected_old`: `b891577fbf4bebf2974e916bcb1e64a3741783b7`",
      "- Lease: report leased at `b891577fbf4bebf2974e916bcb1e64a3741783b7` (origin/hyprws) — any movement of `origin/hyprws` voids this rehearsal; restart at `vp run fork:sync unblock-list`",
      "- Rehearsal branch: `rehearse/v0.0.41-nightly.20260913.1625-from-b891577fbf4b`",
      "- Rebased head: `absent`",
      "- Stack size: `219` fork commits",
      "",
      "## Conflicts",
      "",
      "Escaped pipes are accepted in Subject, File, Resolution, and Agent-safe cells (`\\|`); write a literal backslash as `\\\\`.",
      "",
      "| Fork commit and subject | Domain | File | Class | Resolution | Agent-safe? | Decided by |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| `347da0d7ad9e` `refactor(web): centralize thread route navigation` | project-windows | `apps/web/src/components/ChatView.tsx` | mechanical | rerere replay | true | agent |",
      "",
      "## Automerged overlap review",
      "",
      "See orientation in the JSON report.",
      "",
      "## Fork commits",
      "",
      "None.",
      "",
      "## Silent seams",
      "",
      "None.",
      "",
      "## Decisions",
      "",
      "None.",
      "",
      "## Repair commits",
      "",
      "None.",
      "",
      "## Verification",
      "",
      "",
      "## Grounding",
      "",
      "None.",
      "",
      "do-not-land",
      "",
    ].join("\n");
    assert.strictEqual(parseFoldRecordHeader(record), undefined);
    assert.strictEqual(parseFoldSection(record), undefined);
    const parsed = parseRecord(record);
    assert.strictEqual(parsed.conflicts.length, 1);
    assert.strictEqual(
      parsed.conflicts[0]!.subject,
      "refactor(web): centralize thread route navigation",
    );
    assert.deepStrictEqual(parsed.decisions, []);
  });
});

describe("fold wiring (RSI-Software/t3code-hyprws#922)", () => {
  const gitRun = (cwd: string, args: ReadonlyArray<string>): string =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).toString().trim();

  const identity = (cwd: string): void => {
    gitRun(cwd, ["config", "user.name", "test"]);
    gitRun(cwd, ["config", "user.email", "test@example.invalid"]);
  };

  const commitFile = (cwd: string, name: string, content: string, message: string): string => {
    NodeFS.writeFileSync(NodePath.join(cwd, name), content);
    gitRun(cwd, ["add", name]);
    gitRun(cwd, ["commit", "-m", message]);
    return gitRun(cwd, ["rev-parse", "HEAD"]);
  };

  /** The stop-recording half of the walk's own `stopWalk`, for verb-level fold contexts. */
  const recordWalkStop = (report: SyncReport, detail: string): SyncReport => ({
    ...report,
    walk: {
      ...(report.walk ?? {}),
      stop: { reason: "conflict" as const, detail },
    },
  });

  /**
   * A real trunk clone (`repositoryRoot`, with `origin` a bare remote publishing `hyprws`), a lane
   * clone holding the candidate stack on the target tag, and the walk bindings a `checked` report
   * carries. Trunk tip is one landing past the shared base; tests push further landings to
   * `refs/heads/hyprws` to move the frontier the fold folds.
   */
  const foldFixture = (options: { readonly seam?: boolean } = {}) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-fold-wiring-"));
    const origin = NodePath.join(root, "origin.git");
    const trunk = NodePath.join(root, "trunk");
    const lane = NodePath.join(root, "lane");
    gitRun(root, ["init", "--bare", "--initial-branch=main", origin]);
    NodeChildProcess.execFileSync("git", ["clone", "--quiet", origin, trunk], { encoding: "utf8" });
    identity(trunk);
    // The bot snapshot reader parses the workflow file the way fixtureRoot provides it.
    const workflowDirectory = NodePath.join(trunk, ".github", "workflows");
    NodeFS.mkdirSync(workflowDirectory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(workflowDirectory, "hyprws-upstream-sync.yml"),
      'on:\n  schedule:\n    - cron: "23 */4 * * *"\n',
    );
    commitFile(trunk, "seam.txt", "base\n", "base");
    // `unblock-check` reads the lockfile from the lane head; give the fixture a stable one.
    commitFile(trunk, "pnpm-lock.yaml", "lockfile: fixture\n", "chore: lockfile");
    const sharedBase = gitRun(trunk, ["rev-parse", "HEAD"]);
    gitRun(trunk, ["tag", "v1.2.3"]);
    commitFile(trunk, "up0.txt", "0\n", "upstream landing 0");
    // The trunk carries the fork's own work, as hyprws does; the shared base stays the tag.
    const landed = commitFile(
      trunk,
      options.seam === true ? "seam.txt" : "fork.txt",
      options.seam === true ? "fork\n" : "fork\n",
      "feat: fork work\n\nFork-Domain: fork-meta\nFork-Tier: qol",
    );
    gitRun(trunk, ["push", "--quiet", "origin", `HEAD:refs/heads/hyprws`, "v1.2.3"]);
    NodeChildProcess.execFileSync("git", ["clone", "--quiet", origin, lane], { encoding: "utf8" });
    identity(lane);
    gitRun(lane, ["checkout", "--quiet", "--detach", "v1.2.3"]);
    // The candidate stack is the replay of `sharedBase..T`, the original series proof target.
    commitFile(lane, "up0.txt", "0\n", "upstream landing 0");
    const forkHead = commitFile(
      lane,
      "fork.txt",
      "fork\n",
      "feat: fork work\n\nFork-Domain: fork-meta\nFork-Tier: qol",
    );
    const expectedLaneBranch = `rehearse/v1.2.3-from-${landed.slice(0, 12)}`;
    const checked = report(trunk, {
      stage: "checked",
      // A real SHA the wrapper runner's real Git can resolve for the orientation checks.
      issue: { number: 352, blockingSha: sharedBase, title: "blocked" },
      target: { tag: "v1.2.3", sha: sharedBase },
      source: { sha: landed, expectedOld: landed, sharedBase },
      lane: { branch: expectedLaneBranch, worktree: lane },
      rebasedHead: forkHead,
      installedHead: forkHead,
      stackSize: 1,
      originalCount: 2,
      originalMessages:
        "upstream landing 0\x1efeat: fork work\n\nFork-Domain: fork-meta\nFork-Tier: qol\x1e",
      orientation: "mirror: fixture",
    });
    NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
    NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
    return {
      root,
      origin,
      trunk,
      lane,
      sharedBase,
      landed,
      forkHead,
      report: checked,
      land: (name: string, content: string, message: string): string => {
        const sha = commitFile(trunk, name, content, message);
        gitRun(trunk, ["push", "--quiet", "origin", `${sha}:refs/heads/hyprws`]);
        return sha;
      },
      cleanup: (): void => {
        NodeFS.rmSync(root, { recursive: true, force: true });
        NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
      },
    };
  };

  it("unblock-fold folds one clean trunk landing and regresses to replayed", () => {
    const item = foldFixture();
    try {
      const landing = item.land("up1.txt", "1\n", "upstream landing 1");
      const folded = execute(["unblock-fold", "--report", item.report.reportPath], item.trunk);
      assert.strictEqual(folded.stage, "replayed");
      assert.strictEqual(folded.folds?.length, 1);
      const segment = folded.folds![0]!;
      assert.deepStrictEqual(
        { from: segment.from, to: segment.to, onto: segment.onto, count: segment.originalCount },
        { from: item.landed, to: landing, onto: item.forkHead, count: 1 },
      );
      assert.strictEqual(segment.replayedHead, gitRun(item.lane, ["rev-parse", "HEAD"]));
      assert.strictEqual(folded.source?.expectedOld, landing);
      assert.strictEqual(folded.activeFold, undefined);
      assert.include(folded.touchedPaths ?? [], "up1.txt");
      assert.include(NodeFS.readFileSync(folded.recordPath, "utf8"), "## Folds");
    } finally {
      item.cleanup();
    }
  });

  /** Real Git and everything else through `SystemRunner`; `vp` fakes success and `gh` answers
   * from a FakeRunner, so the fold, the proof, and the push run for real. `options` let a test
   * script the record comment and its remote body (the applied-publication resume path). */
  const wrapperRunner = (
    options: {
      /** The body the record comment carries on the issue (read back through `gh api`). */
      readonly recordBody?: () => string;
      /** The result of a record-comment PATCH. */
      readonly patchResult?: () => CommandResult;
      /** The URL posting the record comment returns. */
      readonly commentUrl?: string;
      /** The result of posting the record comment (scripted per call). */
      readonly commentResult?: () => CommandResult;
    } = {},
  ): CommandRunner & {
    readonly calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
  } => {
    const system = new SystemRunner();
    const inner = new FakeRunner();
    const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    setBotResponses(inner, "candidate");
    return {
      calls,
      run: (command, args, cwd, input, env) => {
        calls.push({ command, args: [...args] });
        if (command === "vp" || command === "node") return { status: 0, stdout: "", stderr: "" };
        if (command === "gh") {
          if (args[0] === "issue" && args[1] === "comment") {
            if (options.commentResult !== undefined) return options.commentResult();
            if (options.commentUrl !== undefined)
              return { status: 0, stdout: `${options.commentUrl}\n`, stderr: "" };
          } else if (args[0] === "api" && args.includes("--jq"))
            return { status: 0, stdout: `${options.recordBody?.() ?? ""}`, stderr: "" };
          if (args[0] === "api" && args.includes("-X") && options.patchResult !== undefined)
            return options.patchResult();
          return inner.run(command, args, cwd, input, env);
        }
        if (command !== "git")
          assert.fail(`unscripted command reached the wrapper: ${command} ${args.join(" ")}`);
        return system.run(command, args, cwd, input, env);
      },
    };
  };

  const sha256 = (value: string): string =>
    NodeCrypto.createHash("sha256").update(value).digest("hex");

  /**
   * The ledger environment without ledgerFixture's remote swap: the walk's own `origin` must
   * stay in place because the apply fetches and pushes the trunk through it. Seeds the churn
   * ref on the real origin and puts a fake `gh` on PATH that answers the record lookup.
   */
  /**
   * Like `ledgerEnv`, but the fake `gh` also serves `SystemGitHub`'s direct calls so the stable
   * candidate reconciliation is observable: created candidate issues land in a state file, and
   * a rerun's listing already carries the marker, so a second announcement finds the issue and
   * creates nothing.
   */
  const stableGhEnv = (recordPath: string): { statePath: string; restore: () => void } => {
    const home = NodePath.dirname(recordPath);
    const statePath = NodePath.join(home, "stable-gh-state.json");
    NodeFS.writeFileSync(statePath, JSON.stringify({ next: 101, issues: [] }));
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(bin, "gh"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        'const a = args.join(" ");',
        "const statePath = process.env.STABLE_FAKE_STATE;",
        'const state = JSON.parse(fs.readFileSync(statePath, "utf8"));',
        "const save = () => fs.writeFileSync(statePath, JSON.stringify(state));",
        'const print = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));',
        'if (a.startsWith("api --method POST repos/")) {',
        '  const input = JSON.parse(fs.readFileSync(0, "utf8"));',
        '  const issue = { number: state.next++, node_id: `n${state.next}`, state: "open", title: input.title, body: input.body, type: { name: "Notification" } };',
        "  state.issues.push(issue); save();",
        "  print({ number: issue.number, node_id: issue.node_id, title: issue.title, body: issue.body });",
        "  return;",
        "}",
        'if (a.includes("--paginate") && a.includes("issues?state=all")) { print([state.issues]); return; }',
        'if (args[0] === "api" && args[1] === "graphql") {',
        '  print({ data: { organization: { issueFields: { nodes: [] } }, repository: { issueTypes: { nodes: [{ id: "T1", name: "Notification", isEnabled: true }] } } } });',
        "  return;",
        "}",
        'if (a.startsWith("api --method GET ")) { print("[]"); return; }',
        'const record = fs.readFileSync(process.env.FAKE_RECORD_PATH, "utf8");',
        'print(JSON.stringify({ body: process.env.FAKE_ISSUE_BODY, url: "https://example.test/issue", comments: [{ body: record, url: "https://example.test/record" }] }));',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    const previousRecord = process.env.FAKE_RECORD_PATH;
    const previousBody = process.env.FAKE_ISSUE_BODY;
    const previousState = process.env.STABLE_FAKE_STATE;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.FAKE_RECORD_PATH = recordPath;
    process.env.FAKE_ISSUE_BODY = [
      "## Sequential rebase census",
      "",
      "| File | Hunks | Fork commit | Domain |",
      "| --- | ---: | --- | --- |",
      "| `scripts/fork-sync.ts` | 1 | `1234567 feat(fork): walk identity` | fork-meta |",
    ].join("\n");
    process.env.STABLE_FAKE_STATE = statePath;
    return {
      statePath,
      restore: () => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousRecord === undefined) delete process.env.FAKE_RECORD_PATH;
        else process.env.FAKE_RECORD_PATH = previousRecord;
        if (previousBody === undefined) delete process.env.FAKE_ISSUE_BODY;
        else process.env.FAKE_ISSUE_BODY = previousBody;
        if (previousState === undefined) delete process.env.STABLE_FAKE_STATE;
        else process.env.STABLE_FAKE_STATE = previousState;
      },
    };
  };

  const ledgerEnv = (root: string, recordPath: string): { restore: () => void } => {
    gitRun(root, ["config", "user.name", "test"]);
    gitRun(root, ["config", "user.email", "test@example.invalid"]);
    writeBotRefFile(root, CHURN_REF, CHURN_LEDGER_FILE, "[]\n", "churn: fixture");
    gitRun(root, ["push", "--quiet", "origin", `${CHURN_REF}:${CHURN_REF}`]);
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(bin, "gh"),
      [
        "#!/usr/bin/env node",
        'const record = require("node:fs").readFileSync(process.env.FAKE_RECORD_PATH, "utf8");',
        "process.stdout.write(",
        "  JSON.stringify({",
        "    body: process.env.FAKE_ISSUE_BODY,",
        '    url: "https://example.test/issue",',
        '    comments: [{ body: record, url: "https://example.test/record" }],',
        "  }),",
        ");",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    const previousRecord = process.env.FAKE_RECORD_PATH;
    const previousBody = process.env.FAKE_ISSUE_BODY;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.FAKE_RECORD_PATH = recordPath;
    process.env.FAKE_ISSUE_BODY = [
      "## Sequential rebase census",
      "",
      "| File | Hunks | Fork commit | Domain |",
      "| --- | ---: | --- | --- |",
      "| `scripts/fork-sync.ts` | 1 | `1234567 feat(fork): walk identity` | fork-meta |",
    ].join("\n");
    return {
      restore: () => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousRecord === undefined) delete process.env.FAKE_RECORD_PATH;
        else process.env.FAKE_RECORD_PATH = previousRecord;
        if (previousBody === undefined) delete process.env.FAKE_ISSUE_BODY;
        else process.env.FAKE_ISSUE_BODY = previousBody;
      },
    };
  };

  it("unblock-apply alone folds a landed trunk, passes the gate, and pushes the advanced lease", () => {
    const item = foldFixture();
    try {
      const landing = item.land("up1.txt", "1\n", "upstream landing 1");
      const ledger = ledgerEnv(item.trunk, item.report.recordPath);
      const runner = wrapperRunner();
      try {
        const applied = execute(
          ["unblock-apply", "--report", item.report.reportPath, "--record", item.report.recordPath],
          item.trunk,
          runner,
        );
        // The fold ran inside the apply: the frontier advanced, the lane name stayed on T.
        assert.strictEqual(applied.stage, "applied");
        assert.strictEqual(applied.source?.expectedOld, landing);
        assert.strictEqual(applied.folds?.length, 1);
        assert.strictEqual(
          applied.lane?.branch,
          `rehearse/v1.2.3-from-${item.landed.slice(0, 12)}`,
        );
        assert.strictEqual(applied.publication?.outcome, "applied");
        assert.strictEqual(applied.publication?.expectedOld, landing);
        assert.strictEqual(applied.publication?.head, applied.installedHead);
        // The pushed history contains the landing and the lease matched the advanced frontier.
        assert.strictEqual(
          gitRun(item.trunk, ["rev-parse", "refs/remotes/origin/hyprws"]),
          applied.installedHead,
        );
        process.stdout.write(
          `DEBUG origin/hyprws:\n${gitRun(item.trunk, ["log", "--oneline", "-5", "origin/hyprws"])}\nlanding=${landing} installed=${applied.installedHead}\n`,
        );
        // The pushed history carries the landing's changes: the fold replays it onto the
        // candidate, so the applied tree contains the landed file (RSI-Software/t3code-hyprws#922).
        assert.strictEqual(gitRun(item.trunk, ["show", "origin/hyprws:up1.txt"]).trim(), "1");
        assert.include(NodeFS.readFileSync(applied.recordPath, "utf8"), "## Folds");
      } finally {
        ledger.restore();
      }
    } finally {
      item.cleanup();
    }
  });

  it("unblock-apply resumes an applied push from the publication receipt without a second push", () => {
    const item = foldFixture();
    try {
      const landing = item.land("up1.txt", "1\n", "upstream landing 1");
      const folded = execute(["unblock-fold", "--report", item.report.reportPath], item.trunk);
      const head = folded.folds![0]!.replayedHead!;
      // The push landed (the trunk carries the applied head) but the outcome was never written.
      gitRun(item.lane, ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/hyprws`]);
      const record = renderRecord({ ...folded, rebasedHead: head });
      NodeFS.writeFileSync(item.report.recordPath, record);
      const checked: SyncReport = {
        ...folded,
        stage: "checked",
        installedHead: head,
        rebasedHead: head,
        publication: {
          expectedOld: landing,
          head,
          recordDigest: sha256(record),
        },
      };
      NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
      // Sanity: the trunk really advertises the applied head the receipt names.
      gitRun(item.trunk, ["fetch", "--quiet", "origin", "refs/heads/hyprws"]);
      assert.strictEqual(gitRun(item.trunk, ["rev-parse", "refs/remotes/origin/hyprws"]), head);
      const ledger = ledgerEnv(item.trunk, checked.recordPath);
      const runner = wrapperRunner();
      try {
        const applied = execute(
          ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
          item.trunk,
          runner,
        );
        assert.strictEqual(applied.stage, "applied");
        assert.strictEqual(applied.publication?.outcome, "applied");
        const pushCalls = runner.calls.filter(
          ({ args }) =>
            args.includes("push") && args.some((a) => a.startsWith("--force-with-lease")),
        );
        assert.deepStrictEqual(pushCalls, []);
      } finally {
        ledger.restore();
      }
    } finally {
      item.cleanup();
    }
  });

  it("unblock-auto resumes a persisted folding walk and finishes the fold", () => {
    const item = foldFixture();
    try {
      const landing = item.land("up1.txt", "1\n", "upstream landing 1");
      // The crash window between the persisted `folding` report and the replay: folds and the
      // active fold exist, the lane never advanced.
      const folding: SyncReport = {
        ...item.report,
        stage: "folding",
        activeFold: { index: 0, operation: "replay" },
        folds: [
          {
            from: item.landed,
            to: landing,
            onto: item.forkHead,
            originalCount: 1,
            originalMessages: "upstream landing 1\x1e",
          },
        ],
        baseCheckedHead: item.forkHead,
      };
      NodeFS.writeFileSync(folding.reportPath, JSON.stringify(folding));
      NodeFS.writeFileSync(folding.recordPath, renderRecord(folding));
      const ledger = ledgerEnv(item.trunk, folding.recordPath);
      const runner = wrapperRunner();
      try {
        const finished: SyncReport = execute(
          ["unblock-auto", "--report", folding.reportPath],
          item.trunk,
          runner,
        );
        assert.strictEqual(finished.stage, "applied");
        assert.strictEqual(finished.source?.expectedOld, landing);
        assert.strictEqual(finished.folds?.length, 1);
        assert.isDefined(finished.folds?.[0]?.replayedHead);
        // Resumed in place, never re-listed: the report binding and lane survived.
        assert.strictEqual(finished.reportPath, folding.reportPath);
        assert.strictEqual(finished.lane?.worktree, item.lane);
      } finally {
        ledger.restore();
      }
    } finally {
      item.cleanup();
    }
  });

  it("an apply-retry fold conflict records the ordinary handoff rows before stopping", () => {
    const item = foldFixture({ seam: true });
    try {
      const landing = item.land("seam.txt", "upstream\n", "upstream seam rewrite");
      const system = new SystemRunner();
      const runner: CommandRunner = {
        run: (command, args, cwd, input, env) =>
          command === "git" && args.includes("push")
            ? {
                status: 1,
                stdout: "",
                stderr: `To origin\n ! [rejected] refs/heads/hyprws -> refs/heads/hyprws (stale info)\n`,
              }
            : system.run(command, args, cwd, input, env),
      };
      const context: FoldVerbContext = {
        rehearsalRebaseArgs,
        preserveRecordDecisions,
        rehearsalConflictStop,
        recordWalkStop,
        unblockCheck: () => {
          throw new Error("recheck goes through the stub below");
        },
      };
      assert.throws(
        () =>
          leasedPushWithFoldRetry({
            report: item.report,
            runner,
            context,
            worktree: item.lane,
            head: item.forkHead,
            lease: item.landed,
            recordPath: item.report.recordPath,
            recheck: (foldedReport) => {
              const head = foldedReport.folds![0]!.replayedHead!;
              return { ...foldedReport, stage: "checked", installedHead: head, rebasedHead: head };
            },
          }),
        /lane is retained with the conflict rows recorded/,
      );
      const stopped = JSON.parse(NodeFS.readFileSync(item.report.reportPath, "utf8")) as SyncReport;
      assert.strictEqual(stopped.stage, "conflicts");
      // The fold conflict is an ordinary walk stop: the report carries the same `walk.stop` the
      // rehearsal stop leaves behind (RSI-Software/t3code-hyprws#922).
      assert.strictEqual(stopped.walk?.stop?.reason, "conflict");
      assert.match(stopped.walk?.stop?.detail ?? "", /fold conflict at upstream seam rewrite/);
      assert.deepStrictEqual(stopped.activeFold, { index: 0, operation: "replay" });
      const row = stopped.conflicts[stopped.conflicts.length - 1]!;
      assert.strictEqual(row.path, "seam.txt");
      assert.include(row.subject, "(fold 1)");
      assert.strictEqual(row.subject, "upstream seam rewrite (fold 1)");
      assert.isTrue(NodeFS.existsSync(item.lane));
    } finally {
      item.cleanup();
    }
  });

  it("autosquash reaches below a fold and the segment is re-proved at its relocated onto", () => {
    const item = foldFixture();
    try {
      item.land("up1.txt", "1\n", "upstream landing 1");
      const folded = execute(["unblock-fold", "--report", item.report.reportPath], item.trunk);
      assert.strictEqual(folded.folds?.[0]?.onto, item.forkHead);
      // A repair for a path the proved-prefix fork commit owns, left dirty for the repair pass.
      // Before #922's fold-aware rule this repair went standalone; now it must reach its owner
      // below the fold.
      NodeFS.writeFileSync(NodePath.join(item.lane, "fork.txt"), "repaired\n");
      const runner = wrapperRunner();
      const checked = execute(["unblock-check", "--report", folded.reportPath], item.trunk, runner);
      assert.strictEqual(checked.stage, "checked");
      // The autosquash ran from the target and folded the fixup into the owner below the fold:
      // the finished head is the fold landing, and the repaired tree rides the rewritten owner.
      assert.strictEqual(
        gitRun(item.lane, ["show", "-s", "--format=%s", "HEAD"]),
        "upstream landing 1",
      );
      assert.strictEqual(gitRun(item.lane, ["show", "HEAD:fork.txt"]), "repaired");
      // The fold segment relocated onto the rewritten owner and its head is the relocated landing.
      const segment = checked.folds![0]!;
      assert.notStrictEqual(segment.onto, item.forkHead);
      assert.strictEqual(segment.onto, gitRun(item.lane, ["rev-parse", "HEAD~1"]));
      assert.strictEqual(segment.checkedHead, gitRun(item.lane, ["rev-parse", "HEAD"]));
      assert.isUndefined(segment.repairCommits);
      // The head-derived bindings and the rendered record header follow the head the check
      // proved, not the pre-autosquash rehearsal head the report carried in.
      assert.strictEqual(checked.rebasedHead, gitRun(item.lane, ["rev-parse", "HEAD"]));
      assert.strictEqual(checked.stackSize, 3);
      const record = NodeFS.readFileSync(checked.recordPath, "utf8");
      assert.include(record, `- Rebased head: \`${checked.rebasedHead}\``);
      assert.include(record, `- Final head: \`${checked.rebasedHead}\``);
      assert.include(record, "- Stack size: `3` fork commits");
      // The relocated binding still proves the replay.
      verifyReplay(checked, runner);
    } finally {
      item.cleanup();
    }
  });

  it("an ownerless path in a folded lane stops, and --seam-owner folds it into the named owner", () => {
    const item = foldFixture();
    try {
      item.land("up1.txt", "1\n", "upstream landing 1");
      const folded = execute(["unblock-fold", "--report", item.report.reportPath], item.trunk);
      // No fork commit touched repair.txt, so the walk refuses it rather than guessing.
      NodeFS.writeFileSync(NodePath.join(item.lane, "repair.txt"), "repair\n");
      let detail = "";
      try {
        execute(["unblock-check", "--report", folded.reportPath], item.trunk, wrapperRunner());
      } catch (error) {
        detail = String(
          (error as { failure?: { detail?: string } }).failure?.detail ?? (error as Error).message,
        );
      }
      assert.include(detail, "no fork commit in the replayed stack owns repair.txt");
      // Declaring the proved-prefix owner folds the repair into it, below the fold.
      const runner = wrapperRunner();
      const checked = execute(
        [
          "unblock-check",
          "--report",
          folded.reportPath,
          "--seam-owner",
          `repair.txt=${item.forkHead}`,
        ],
        item.trunk,
        runner,
      );
      assert.strictEqual(checked.stage, "checked");
      assert.strictEqual(gitRun(item.lane, ["show", "HEAD:repair.txt"]), "repair");
      assert.strictEqual(
        gitRun(item.lane, ["show", "-s", "--format=%s", "HEAD"]),
        "upstream landing 1",
      );
      const segment = checked.folds![0]!;
      assert.notStrictEqual(segment.onto, item.forkHead);
      verifyReplay(checked, runner);
    } finally {
      item.cleanup();
    }
  });

  it("verifyReplay drops the start-empty commits the --no-keep-empty rebase drops (RSI-Software/t3code-hyprws#665)", () => {
    // A report bound before the flag existed: its baseline counts a commit that starts empty
    // (tree identical to its parent's tree). The proof derives the start-empty set from git at
    // proof time, so the old report proves as 2 expected commits without re-binding.
    const item = foldFixture();
    try {
      gitRun(item.trunk, ["commit", "--allow-empty", "-m", "chore(fork): empty distribution"]);
      const emptySha = gitRun(item.trunk, ["rev-parse", "HEAD"]);
      const bound: SyncReport = {
        ...item.report,
        source: { sha: emptySha, expectedOld: emptySha, sharedBase: item.sharedBase },
        originalCount: 3,
        originalMessages: `${item.report.originalMessages}chore(fork): empty distribution\x1e`,
      };
      const runner = wrapperRunner();
      // The lane holds only the two real commits; the proof must not expect the start-empty one.
      verifyReplay(bound, runner);
      // A commit that only *becomes* empty during the replay is not start-empty: it stays
      // counted, and its absence from the lane still refuses (retirement stays human).
      const became = commitFile(item.trunk, "became.txt", "x\n", "feat: became empty upstream");
      const stillCounted: SyncReport = {
        ...item.report,
        source: { sha: became, expectedOld: became, sharedBase: item.sharedBase },
        originalCount: 3,
        originalMessages: `${item.report.originalMessages}feat: became empty upstream\x1e`,
      };
      assert.throws(
        () => verifyReplay(stillCounted, runner),
        /replay commit count changed: 3 -> 2/,
      );
    } finally {
      item.cleanup();
    }
  });

  it("a fold conflict stops with attributed rows and resumes through unblock-rehearse", () => {
    const item = foldFixture({ seam: true });
    try {
      const landing = item.land("seam.txt", "upstream\n", "upstream seam rewrite");
      const stopped = execute(["unblock-fold", "--report", item.report.reportPath], item.trunk);
      assert.strictEqual(stopped.stage, "conflicts");
      assert.deepStrictEqual(stopped.activeFold, { index: 0, operation: "replay" });
      const row = stopped.conflicts[stopped.conflicts.length - 1]!;
      assert.strictEqual(row.path, "seam.txt");
      assert.include(row.subject, "(fold 1)");
      // Resolve the seam, stage it, and fill the record's TODO cells like the human handoff does.
      NodeFS.writeFileSync(NodePath.join(item.lane, "seam.txt"), "resolved\n");
      gitRun(item.lane, ["add", "seam.txt"]);
      const recordPath = stopped.recordPath;
      const record = NodeFS.readFileSync(recordPath, "utf8");
      const filledRecord = record.replace(
        /\| TODO \| TODO \| TODO \| TODO \|/,
        "| mechanical | resolved by hand in the lane | yes | human |",
      );
      assert.notStrictEqual(record, filledRecord);
      NodeFS.writeFileSync(recordPath, filledRecord);
      const resumed = execute(["unblock-rehearse", "--report", stopped.reportPath], item.trunk);
      assert.strictEqual(resumed.stage, "replayed");
      assert.strictEqual(resumed.activeFold, undefined);
      assert.strictEqual(resumed.source?.expectedOld, landing);
      assert.strictEqual(
        resumed.folds?.[0]?.replayedHead,
        gitRun(item.lane, ["rev-parse", "HEAD"]),
      );
      assert.strictEqual(
        gitRun(item.lane, ["show", "-s", "--format=%s", "HEAD"]),
        "upstream seam rewrite",
      );
    } finally {
      item.cleanup();
    }
  });

  it("non-linear trunk movement refuses and retains the lane", () => {
    const item = foldFixture();
    try {
      const side = commitFile(item.trunk, "side.txt", "side\n", "side landing");
      gitRun(item.trunk, ["reset", "--hard", item.landed]);
      const merge = gitRun(item.trunk, [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "merge",
        "--no-ff",
        "-m",
        "merge the side landing",
        side,
      ]);
      void merge;
      const mergeHead = gitRun(item.trunk, ["rev-parse", "HEAD"]);
      gitRun(item.trunk, ["push", "--quiet", "origin", `${mergeHead}:refs/heads/hyprws`]);
      assert.throws(
        () => execute(["unblock-fold", "--report", item.report.reportPath], item.trunk),
        /refuses:/,
      );
      const unchanged = JSON.parse(
        NodeFS.readFileSync(item.report.reportPath, "utf8"),
      ) as SyncReport;
      assert.strictEqual(unchanged.stage, "checked");
      assert.strictEqual(unchanged.folds, undefined);
      assert.isTrue(NodeFS.existsSync(item.lane));
    } finally {
      item.cleanup();
    }
  });

  it("the tag-pinned gate accepts a folded record when the freshly fetched trunk is B", () => {
    const item = foldFixture();
    try {
      const landing = item.land("up1.txt", "1\n", "upstream landing 1");
      const folded = execute(["unblock-fold", "--report", item.report.reportPath], item.trunk);
      const head = folded.folds![0]!.replayedHead!;
      const record = renderRecord({ ...folded, rebasedHead: head, stackSize: 2 });
      assert.deepStrictEqual(
        inspectRecord(record, {
          targetTag: "v1.2.3",
          targetSha: item.sharedBase,
          expectedOld: landing,
          rebasedHead: head,
          stackSize: "2",
        }),
        [],
      );
      assert.notDeepEqual(
        inspectRecord(record, {
          targetTag: "v1.2.3",
          targetSha: item.sharedBase,
          expectedOld: item.landed,
          rebasedHead: head,
          stackSize: "2",
        }),
        [],
      );
    } finally {
      item.cleanup();
    }
  });

  it("unblock-apply retries a definite stale lease by folding, bounded to three attempts", () => {
    const item = foldFixture();
    try {
      const landing = item.land("up1.txt", "1\n", "upstream landing 1");
      const system = new SystemRunner();
      const pushes: Array<CommandResult> = [
        {
          status: 1,
          stdout: "",
          stderr: `To origin\n ! [rejected] refs/heads/hyprws -> refs/heads/hyprws (stale info)\nerror: failed to push some refs\n`,
        },
        { status: 0, stdout: "ok\n", stderr: "" },
      ];
      const runner: CommandRunner = {
        run: (command, args, cwd, input, env) =>
          command === "git" && args.includes("push")
            ? (pushes.shift() ?? { status: 1, stdout: "", stderr: "out of scripted pushes" })
            : system.run(command, args, cwd, input, env),
      };
      const foldedChecked: SyncReport = {
        ...item.report,
        stage: "checked",
        installedHead: item.forkHead,
        rebasedHead: item.forkHead,
      };
      NodeFS.writeFileSync(foldedChecked.reportPath, JSON.stringify(foldedChecked));
      NodeFS.writeFileSync(foldedChecked.recordPath, renderRecord(foldedChecked));
      const context: FoldVerbContext = {
        rehearsalRebaseArgs,
        preserveRecordDecisions,
        rehearsalConflictStop,
        recordWalkStop,
        unblockCheck: () => {
          throw new Error("recheck goes through the stub below");
        },
      };
      const applied = leasedPushWithFoldRetry({
        report: foldedChecked,
        runner,
        context,
        worktree: item.lane,
        head: item.forkHead,
        lease: item.landed,
        recordPath: foldedChecked.recordPath,
        recheck: (foldedReport) => {
          const head = foldedReport.folds![0]!.replayedHead!;
          return {
            ...foldedReport,
            stage: "checked",
            installedHead: head,
            rebasedHead: head,
          };
        },
      });
      assert.deepStrictEqual(applied.publication, {
        expectedOld: landing,
        head: applied.installedHead!,
        recordDigest: applied.publication?.recordDigest ?? "",
        outcome: "applied",
      });
      assert.strictEqual(applied.source?.expectedOld, landing);
      assert.strictEqual(applied.stage, "checked");
    } finally {
      item.cleanup();
    }
  });

  const forceWithLeasePushes = (
    runner: ReturnType<typeof wrapperRunner>,
  ): ReadonlyArray<{ readonly command: string; readonly args: ReadonlyArray<string> }> =>
    runner.calls.filter(
      ({ args }) =>
        args.includes("push") && args.some((argument) => argument.startsWith("--force-with-lease")),
    );

  it("an apply failure after the push resumes publication with no second push, then is a no-op", () => {
    const item = foldFixture();
    try {
      const recordPath = item.report.recordPath;
      const commentUrl = "https://example.test/record#issuecomment-123";
      const ledger = ledgerEnv(item.trunk, recordPath);
      try {
        // The record comment drifted from the local record, and the applied-record PATCH fails:
        // the push itself already landed (a real push through the fixture's origin).
        let patchCalls = 0;
        const failing = wrapperRunner({
          commentUrl,
          recordBody: () => "",
          patchResult: () =>
            ++patchCalls === 1
              ? { status: 1, stdout: "", stderr: "patch refused\n" }
              : { status: 0, stdout: "", stderr: "" },
        });
        assert.throws(
          () =>
            execute(
              ["unblock-apply", "--report", item.report.reportPath, "--record", recordPath],
              item.trunk,
              failing,
            ),
          /patch refused/,
        );
        // The applied stage and the applied receipt were persisted before the failing PATCH.
        const onDisk = validateReport(
          JSON.parse(NodeFS.readFileSync(item.report.reportPath, "utf8")),
        ) as SyncReport;
        assert.strictEqual(onDisk.stage, "applied");
        assert.strictEqual(onDisk.publication?.outcome, "applied");
        assert.strictEqual(patchCalls, 1);
        gitRun(item.trunk, ["fetch", "--quiet", "origin", "refs/heads/hyprws"]);
        assert.strictEqual(
          gitRun(item.trunk, ["rev-parse", "refs/remotes/origin/hyprws"]),
          onDisk.installedHead,
        );
        // The rerun publishes the rest (record republish, churn row, announcement, rerere,
        // outcomes) from the persisted applied stage without a second push.
        const resume = wrapperRunner({
          commentUrl,
          recordBody: () => NodeFS.readFileSync(recordPath, "utf8"),
        });
        const applied = execute(
          ["unblock-apply", "--report", item.report.reportPath, "--record", recordPath],
          item.trunk,
          resume,
        );
        assert.strictEqual(applied.stage, "applied");
        assert.deepStrictEqual(forceWithLeasePushes(resume), []);
        assert.strictEqual(applied.announcementUrl, commentUrl);
        assert.strictEqual(applied.rererePublication?.state, "published");
        assert.strictEqual(applied.walk?.ledger?.state, "published");
        // A second rerun is a no-op: no push, no reposted announcement.
        const again = wrapperRunner({
          commentUrl,
          recordBody: () => NodeFS.readFileSync(recordPath, "utf8"),
        });
        execute(
          ["unblock-apply", "--report", item.report.reportPath, "--record", recordPath],
          item.trunk,
          again,
        );
        assert.deepStrictEqual(forceWithLeasePushes(again), []);
        assert.deepStrictEqual(
          again.calls.filter(
            ({ command, args }) => command === "gh" && args[0] === "issue" && args[1] === "comment",
          ),
          [],
        );
      } finally {
        ledger.restore();
      }
    } finally {
      item.cleanup();
    }
  });

  it("unblock-auto finishes an applied push from a pending receipt without re-listing", () => {
    const item = foldFixture();
    try {
      const landing = item.land("up1.txt", "1\n", "upstream landing 1");
      const folded = execute(["unblock-fold", "--report", item.report.reportPath], item.trunk);
      const head = folded.folds![0]!.replayedHead!;
      // The push landed (the trunk carries the applied head) but the outcome was never written.
      gitRun(item.lane, ["push", "--quiet", "--force", "origin", "HEAD:refs/heads/hyprws"]);
      const record = renderRecord({ ...folded, rebasedHead: head });
      NodeFS.writeFileSync(item.report.recordPath, record);
      const checked: SyncReport = {
        ...folded,
        stage: "checked",
        installedHead: head,
        rebasedHead: head,
        publication: { expectedOld: landing, head, recordDigest: sha256(record) },
      };
      NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
      const ledger = ledgerEnv(item.trunk, checked.recordPath);
      const runner = wrapperRunner();
      try {
        const finished: SyncReport = execute(
          ["unblock-auto", "--report", checked.reportPath],
          item.trunk,
          runner,
        );
        assert.strictEqual(finished.stage, "applied");
        assert.strictEqual(finished.publication?.outcome, "applied");
        // Resumed in place, never re-listed.
        assert.strictEqual(finished.reportPath, checked.reportPath);
        assert.strictEqual(finished.lane?.worktree, item.lane);
        assert.deepStrictEqual(forceWithLeasePushes(runner), []);
      } finally {
        ledger.restore();
      }
    } finally {
      item.cleanup();
    }
  });

  it("a fold conflict stop feeds record-decisions and the dirty-lane auto resume", () => {
    // record-decisions accepts the fold conflict stop as a conflict-stop report (a separate
    // fixture: recording mutates the report in place).
    const recordedItem = foldFixture({ seam: true });
    try {
      recordedItem.land("seam.txt", "upstream\n", "upstream seam rewrite");
      const stopped = execute(
        ["unblock-fold", "--report", recordedItem.report.reportPath],
        recordedItem.trunk,
      );
      assert.strictEqual(stopped.walk?.stop?.reason, "conflict");
      NodeFS.writeFileSync(NodePath.join(recordedItem.lane, "seam.txt"), "resolved\n");
      gitRun(recordedItem.lane, ["add", "seam.txt"]);
      const ledger = ledgerEnv(recordedItem.trunk, stopped.recordPath);
      try {
        const recorded = execute(
          ["record-decisions", "--report", stopped.reportPath, "--tag", "v1.2.3"],
          recordedItem.trunk,
          wrapperRunner(),
        );
        assert.isDefined(recorded.recordCommentUrl);
        assert.strictEqual(recorded.conflicts[recorded.conflicts.length - 1]?.decidedBy, "human");
      } finally {
        ledger.restore();
      }
    } finally {
      recordedItem.cleanup();
    }
    // The stopped lane's staged resolutions are the human's answer, so unblock-auto resumes the
    // dirty lane instead of refusing it (RSI-Software/t3code-hyprws#922).
    const item = foldFixture({ seam: true });
    try {
      const landing = item.land("seam.txt", "upstream\n", "upstream seam rewrite");
      const stopped = execute(["unblock-fold", "--report", item.report.reportPath], item.trunk);
      assert.strictEqual(stopped.stage, "conflicts");
      assert.strictEqual(stopped.walk?.stop?.reason, "conflict");
      NodeFS.writeFileSync(NodePath.join(item.lane, "seam.txt"), "resolved\n");
      gitRun(item.lane, ["add", "seam.txt"]);
      const record = NodeFS.readFileSync(stopped.recordPath, "utf8");
      const filledRecord = record.replace(
        /\| TODO \| TODO \| TODO \| TODO \|/,
        "| mechanical | resolved by hand in the lane | yes | human |",
      );
      assert.notStrictEqual(record, filledRecord);
      NodeFS.writeFileSync(stopped.recordPath, filledRecord);
      const ledger = ledgerEnv(item.trunk, stopped.recordPath);
      try {
        const runner = wrapperRunner();
        const finished: SyncReport = execute(
          ["unblock-auto", "--report", stopped.reportPath],
          item.trunk,
          runner,
        );
        assert.strictEqual(finished.stage, "applied");
        assert.strictEqual(finished.source?.expectedOld, landing);
        assert.strictEqual(finished.reportPath, stopped.reportPath);
        assert.strictEqual(finished.lane?.worktree, item.lane);
      } finally {
        ledger.restore();
      }
    } finally {
      item.cleanup();
    }
  });

  it("refuses a repair whose owner subject appears twice in the target range", () => {
    // Autosquash matches `fixup!` targets by SUBJECT and folds into the oldest match, so a
    // landing that shares its subject with the proved commit makes the fixup ambiguous. The walk
    // refuses rather than fold the repair into the wrong landing.
    const item = foldFixture();
    try {
      item.land(
        "landing.txt",
        "landing\n",
        "feat: fork work\n\nFork-Domain: fork-meta\nFork-Tier: qol",
      );
      const folded = execute(["unblock-fold", "--report", item.report.reportPath], item.trunk);
      NodeFS.writeFileSync(NodePath.join(item.lane, "landing.txt"), "repaired\n");
      let detail = "";
      try {
        execute(["unblock-check", "--report", folded.reportPath], item.trunk, wrapperRunner());
      } catch (error) {
        detail = String(
          (error as { failure?: { detail?: string } }).failure?.detail ?? (error as Error).message,
        );
      }
      assert.include(detail, 'duplicated subject: "feat: fork work"');
      assert.isFalse(
        NodeFS.existsSync(NodePath.join(item.lane, ".git", "rebase-merge")),
        "the refusal must precede any rebase",
      );
    } finally {
      item.cleanup();
    }
  });

  it("persists pre-push stable candidates and announces exactly once, never on a rerun", () => {
    const item = foldFixture();
    try {
      // A stable tag the walk crosses on a sibling upstream line: merge-base(expectedOld, v1.3.0)
      // is the shared base, and v1.3.0 sits strictly past it (RSI-Software/t3code-hyprws#922).
      const walkBranch = gitRun(item.trunk, ["symbolic-ref", "--short", "HEAD"]);
      gitRun(item.trunk, ["checkout", "--quiet", "--detach", item.sharedBase]);
      const up9 = commitFile(item.trunk, "up9.txt", "9\n", "upstream landing 9");
      gitRun(item.trunk, ["tag", "v1.3.0"]);
      gitRun(item.trunk, ["push", "--quiet", "origin", "v1.3.0"]);
      gitRun(item.trunk, ["checkout", "--quiet", walkBranch]);
      gitRun(item.lane, ["fetch", "--quiet", "origin", "refs/tags/v1.3.0:refs/tags/v1.3.0"]);
      const checked: SyncReport = {
        ...item.report,
        target: { tag: "v1.3.0", sha: up9 },
        lane: {
          branch: `rehearse/v1.3.0-from-${item.landed.slice(0, 12)}`,
          worktree: item.lane,
        },
      };
      NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
      NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
      const ledger = ledgerEnv(item.trunk, checked.recordPath);
      const stable = stableGhEnv(checked.recordPath);
      const runner = wrapperRunner();
      try {
        const applied = execute(
          ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
          item.trunk,
          runner,
        );
        // The pre-push candidate bindings were persisted, not dropped and re-created.
        assert.deepStrictEqual(
          applied.stableCandidates?.map(({ tag, branch }) => ({ tag, branch })),
          [{ tag: "v1.3.0", branch: "release/v1.3.0-hyprws" }],
        );
        assert.include(
          applied.stableCandidates![0]!.body,
          "hyprws-stable-candidate: v1.3.0-hyprws",
        );
        assert.notStrictEqual(
          gitRun(item.trunk, ["ls-remote", "origin", "refs/heads/release/v1.3.0-hyprws"]),
          "",
        );
        // Exactly one candidate issue announcement.
        let state = JSON.parse(NodeFS.readFileSync(stable.statePath, "utf8")) as {
          issues: Array<{ body: string }>;
        };
        assert.strictEqual(state.issues.length, 1);
        assert.include(state.issues[0]!.body, "hyprws-stable-candidate: v1.3.0-hyprws");
        // The rerun announces nothing new: the persisted bindings reconcile against the issue
        // the first apply created.
        const rerun = wrapperRunner();
        const again = execute(
          ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
          item.trunk,
          rerun,
        );
        assert.strictEqual(again.stage, "applied");
        assert.deepStrictEqual(forceWithLeasePushes(rerun), []);
        state = JSON.parse(NodeFS.readFileSync(stable.statePath, "utf8"));
        assert.strictEqual(state.issues.length, 1);
      } finally {
        stable.restore();
        ledger.restore();
      }
    } finally {
      item.cleanup();
    }
  });

  it("persists the candidate bindings before the record comment so a retry never re-snapshots", () => {
    const item = foldFixture();
    try {
      // The same sibling-upstream crossing as the persistence test above.
      const walkBranch = gitRun(item.trunk, ["symbolic-ref", "--short", "HEAD"]);
      gitRun(item.trunk, ["checkout", "--quiet", "--detach", item.sharedBase]);
      const up9 = commitFile(item.trunk, "up9.txt", "9\n", "upstream landing 9");
      gitRun(item.trunk, ["tag", "v1.3.0"]);
      gitRun(item.trunk, ["push", "--quiet", "origin", "v1.3.0"]);
      gitRun(item.trunk, ["checkout", "--quiet", walkBranch]);
      gitRun(item.lane, ["fetch", "--quiet", "origin", "refs/tags/v1.3.0:refs/tags/v1.3.0"]);
      const checked: SyncReport = {
        ...item.report,
        target: { tag: "v1.3.0", sha: up9 },
        lane: {
          branch: `rehearse/v1.3.0-from-${item.landed.slice(0, 12)}`,
          worktree: item.lane,
        },
      };
      NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
      NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
      const ledger = ledgerEnv(item.trunk, checked.recordPath);
      const stable = stableGhEnv(checked.recordPath);
      try {
        // The record comment post throws; the snapshots were already created and must already be
        // persisted on the report.
        let commentCalls = 0;
        const failing = wrapperRunner({
          commentResult: () =>
            ++commentCalls === 1
              ? { status: 1, stdout: "", stderr: "comment refused\n" }
              : { status: 0, stdout: "https://example.test/record#issuecomment-123\n", stderr: "" },
        });
        assert.throws(
          () =>
            execute(
              ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
              item.trunk,
              failing,
            ),
          /comment refused/,
        );
        const onDisk = validateReport(
          JSON.parse(NodeFS.readFileSync(checked.reportPath, "utf8")),
        ) as SyncReport;
        assert.strictEqual(onDisk.stage, "checked");
        assert.strictEqual(onDisk.stableCandidates?.length, 1);
        assert.strictEqual(onDisk.stableCandidates?.[0]?.tag, "v1.3.0");
        const snapshotBefore = gitRun(item.trunk, [
          "ls-remote",
          "origin",
          "refs/heads/release/v1.3.0-hyprws",
        ]);
        assert.notStrictEqual(snapshotBefore, "");
        // The rerun finds the bindings on the report, posts the comment, pushes once, and
        // announces each persisted candidate exactly once — the snapshot branch was never
        // re-created.
        const resume = wrapperRunner({
          commentUrl: "https://example.test/record#issuecomment-123",
        });
        const applied = execute(
          ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
          item.trunk,
          resume,
        );
        assert.strictEqual(applied.stage, "applied");
        assert.deepStrictEqual(forceWithLeasePushes(resume).length, 1);
        assert.strictEqual(applied.stableCandidates?.length, 1);
        assert.strictEqual(
          gitRun(item.trunk, ["ls-remote", "origin", "refs/heads/release/v1.3.0-hyprws"]),
          snapshotBefore,
        );
        const state = JSON.parse(NodeFS.readFileSync(stable.statePath, "utf8")) as {
          issues: Array<{ body: string }>;
        };
        assert.strictEqual(state.issues.length, 1);
        assert.include(state.issues[0]!.body, "hyprws-stable-candidate: v1.3.0-hyprws");
      } finally {
        stable.restore();
        ledger.restore();
      }
    } finally {
      item.cleanup();
    }
  });

  it("unblock-auto resumes an applied publication report instead of the legacy healer", () => {
    const item = foldFixture();
    try {
      item.land("up1.txt", "1\n", "upstream landing 1");
      const recordPath = item.report.recordPath;
      const commentUrl = "https://example.test/record#issuecomment-123";
      const ledger = ledgerEnv(item.trunk, recordPath);
      try {
        // The fold-retry push lands, but the applied-record PATCH fails: the report is applied
        // and the remote comment is stale.
        let patchCalls = 0;
        const failing = wrapperRunner({
          commentUrl,
          recordBody: () => "",
          patchResult: () =>
            ++patchCalls === 1
              ? { status: 1, stdout: "", stderr: "patch refused\n" }
              : { status: 0, stdout: "", stderr: "" },
        });
        assert.throws(
          () =>
            execute(
              ["unblock-apply", "--report", item.report.reportPath, "--record", recordPath],
              item.trunk,
              failing,
            ),
          /patch refused/,
        );
        const onDisk = validateReport(
          JSON.parse(NodeFS.readFileSync(item.report.reportPath, "utf8")),
        ) as SyncReport;
        assert.strictEqual(onDisk.stage, "applied");
        // unblock-auto must route through the applied resume: the record comment is republished,
        // the churn row is appended exactly once, and the walk is not stopped.
        let autoPatchCalls = 0;
        const resume = wrapperRunner({
          commentUrl,
          recordBody: () => "",
          patchResult: () => {
            autoPatchCalls += 1;
            return { status: 0, stdout: "", stderr: "" };
          },
        });
        let finished: SyncReport;
        try {
          finished = execute(
            ["unblock-auto", "--report", item.report.reportPath],
            item.trunk,
            resume,
          );
        } catch {
          finished = validateReport(
            JSON.parse(NodeFS.readFileSync(item.report.reportPath, "utf8")),
          ) as SyncReport;
        }
        assert.strictEqual(finished.stage, "applied");
        assert.strictEqual(autoPatchCalls, 1);
        assert.deepStrictEqual(forceWithLeasePushes(resume), []);
        assert.notStrictEqual(finished.announcementUrl, "");
        assert.strictEqual(finished.rererePublication?.state, "published");
        assert.strictEqual(finished.walk?.ledger?.state, "published");
        gitRun(item.trunk, ["fetch", "--quiet", "origin", CHURN_REF]);
        const churnState = JSON.parse(
          readBotRefFile(item.trunk, CHURN_REF, CHURN_LEDGER_FILE) ?? "[]",
        ) as { walks: Array<{ tag: string; pending?: boolean }> };
        assert.strictEqual(
          churnState.walks.filter((row) => row.tag === "v1.2.3" && row.pending !== true).length,
          1,
        );
      } finally {
        ledger.restore();
      }
    } finally {
      item.cleanup();
    }
  });
});
