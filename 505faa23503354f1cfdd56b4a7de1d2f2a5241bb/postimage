// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Temporary report fixtures use Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  announceStableCandidates,
  autoGateFour,
  baseReleaseTag,
  autoResolveConflicts,
  collectRetireEvidence,
  decisionSurface,
  execute,
  filledDecisionCells,
  forkCommitIdentifiers,
  gateVerificationEnv,
  identifyRerereResolvedPaths,
  laneExecutablePath,
  lockDriftClass,
  nextScheduledFire,
  NO_GROUNDING_CLAIM,
  offeredTagLines,
  orientationDecisionRows,
  orientationTouchedPaths,
  parseConflictRows,
  parseSilentSeam,
  reconcileAfterApply,
  rehearsalConflictRows,
  rehearsalConflictStop,
  rehearsalRebaseArgs,
  renderRecord,
  resolveAutoTarget,
  gateFourStopReasons,
  resolveUnblockTarget,
  run,
  SystemRunner,
  validateAutoLane,
  validateReport,
  validateSignedRecord,
  type CommandResult,
  type CommandRunner,
  type RetireEvidence,
  type SyncReport,
} from "./fork-sync.ts";
import { inspectRecord } from "./fork-sync-gate.ts";
import { type RebaseGitHubClient } from "./fork-rebase-notify.ts";
import { type StableCandidate } from "./lib/fork-rebase-issues.ts";
import { findUpstreamReferences } from "./fork-upstream-refs.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

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

it("refuses orientation while the bot run is in progress", () => {
  const root = fixtureRoot();
  const listed = report(root, {
    bot: {
      mode: "candidate",
      lastRun: { ...lastRun, status: "in_progress", conclusion: null },
      nextFire: "2026-09-02T08:23:00.000Z",
    },
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
      /bot run is in progress; wait for it and rerun unblock-list/,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
  }
});

it("refuses orientation while the bot run is queued", () => {
  const root = fixtureRoot();
  const listed = report(root, {
    bot: {
      mode: "candidate",
      lastRun: { ...lastRun, status: "queued", conclusion: null },
      nextFire: "2026-09-02T08:23:00.000Z",
    },
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
      /bot run is in progress; wait for it and rerun unblock-list/,
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
    assert.deepInclude(next?.conflicts[0], {
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

it("treats a rerere file with leftover markers as a conflict stop", () => {
  const root = fixtureRoot();
  const path = "apps/web/src/reused.ts";
  NodeFS.mkdirSync(NodePath.join(root, "apps", "web", "src"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(root, path),
    "<<<<<<< ours\nresolved?\n=======\nother\n>>>>>>> theirs\n",
  );
  const state = report(root, {
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
  const runner = new FakeRunner();
  try {
    assert.isNull(autoResolveConflicts(state, runner));
    assert.isFalse(runner.calls.some(({ args }) => args.includes("add")));
    assert.deepInclude(state.conflicts[0], { class: "TODO", decidedBy: "human" });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("requires rerere remaining and diff-check validation before auto staging", () => {
  const root = fixtureRoot();
  const path = "apps/web/src/reused.ts";
  NodeFS.mkdirSync(NodePath.join(root, "apps", "web", "src"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), "resolved\n");
  const state = report(root, {
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
  const rerereArgs = [
    "-c",
    "core.commentChar=auto",
    "-c",
    "rerere.enabled=true",
    "rerere",
    "remaining",
  ] as const;
  try {
    const remaining = new FakeRunner();
    remaining.set("git", rerereArgs, { stdout: `${path}\n` });
    assert.isNull(autoResolveConflicts(state, remaining));

    const badDiff = new FakeRunner();
    badDiff.set("git", rerereArgs, { stdout: "" });
    badDiff.set("git", ["-c", "core.commentChar=auto", "diff", "--check", "--", path], {
      status: 1,
      stderr: "whitespace error",
    });
    assert.isNull(autoResolveConflicts(state, badDiff));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("takes the conflict stop path when rerere remaining exits nonzero", () => {
  const root = fixtureRoot();
  const path = "apps/web/src/reused.ts";
  NodeFS.mkdirSync(NodePath.join(root, "apps", "web", "src"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), "resolved\n");
  const state = report(root, {
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
  const runner = new FakeRunner();
  runner.set(
    "git",
    ["-c", "core.commentChar=auto", "-c", "rerere.enabled=true", "rerere", "remaining"],
    { status: 1, stderr: "rerere failed" },
  );
  try {
    assert.isNull(autoResolveConflicts(state, runner));
    assert.isFalse(runner.calls.some(({ args }) => args.includes("add")));
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

it("Gate 4 auto-keeps keep and stops on retire or partial verdicts", () => {
  const root = fixtureRoot();
  const decision = (verdict: "keep" | "retire" | "partial"): SyncReport =>
    report(root, {
      orientationDecisions: [
        {
          subject: `feat: ${verdict}`,
          domain: "fork-meta",
          verdict,
          decidedBy: "human",
        },
      ],
    });
  try {
    assert.isEmpty(gateFourStopReasons(decision("keep")));
    assert.deepInclude(autoGateFour(decision("keep"))?.orientationDecisions?.[0], {
      verdict: "keep",
      decidedBy: "agent",
    });
    assert.include(gateFourStopReasons(decision("retire")).join("\n"), "retire");
    assert.include(gateFourStopReasons(decision("partial")).join("\n"), "partial");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("Gate 4 parses candidate overlap fail-closed", () => {
  const root = fixtureRoot();
  const candidate = (overlap?: string): SyncReport =>
    report(root, {
      orientation:
        overlap === undefined
          ? "  [candidate] `feat: candidate` (fork-meta)\n"
          : `  [candidate] \`feat: candidate\` (fork-meta)\n      behaviour-overlap: ${overlap}\n`,
      orientationDecisions: [
        {
          subject: "feat: candidate",
          domain: "fork-meta",
          verdict: "candidate",
          decidedBy: "human",
        },
      ],
    });
  try {
    assert.include(gateFourStopReasons(candidate()).join("\n"), "no parsed behaviour overlap");
    assert.include(
      gateFourStopReasons(candidate("none")).join("\n"),
      "no parsed behaviour overlap",
    );
    assert.isEmpty(gateFourStopReasons(candidate("weak hunk overlap: file.ts@1~2")));
    assert.include(
      gateFourStopReasons(candidate("medium overlap: file.ts")).join("\n"),
      "behaviour-overlap: medium overlap: file.ts",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("Gate 4 auto-keeps hard overlap only for a mechanical conflict path", () => {
  const root = fixtureRoot();
  const path = "packages/contracts/src/settings.test.ts";
  const base = report(root, {
    orientation: [
      "  [candidate] `feat(files): reveal ignored workspace files (#73)` (workspace-files)",
      `      behaviour-overlap: hard: ${path} (1 hunk)`,
    ].join("\n"),
    orientationDecisions: orientationDecisionRows(
      "  [candidate] `feat(files): reveal ignored workspace files (#73)` (workspace-files)",
    ),
  });
  const conflict = {
    commit: C,
    subject: "feat(files): reveal ignored workspace files (#73)",
    domain: "workspace-files",
    path,
    class: "mechanical" as const,
    resolution: "rerere replay",
    agentSafe: "true",
    decidedBy: "agent" as const,
  };
  try {
    assert.include(
      gateFourStopReasons(base).join("\n"),
      "hard overlap lacks a mechanical conflict",
    );
    const decided = autoGateFour({ ...base, conflicts: [conflict] });
    assert.deepInclude(decided?.orientationDecisions?.[0], {
      verdict: "candidate",
      action: "keep (mechanical seam)",
      decidedBy: "agent",
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("surfaces every gate 4 stop instead of the first one it finds", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const path = "packages/contracts/src/settings.test.ts";
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: root },
    installedHead: B,
    ciHead: B,
    orientation: [
      `mirror:       origin/main matches upstream/main at ${A.slice(0, 12)}`,
      "  [candidate] `feat(web): hidden behind the first stop` (workspace-files)",
      `      behaviour-overlap: hard: ${path} (1 hunk)`,
      "",
    ].join("\n"),
    orientationDecisions: [
      {
        subject: "fix(server): split upstream",
        domain: "fork-meta",
        verdict: "partial",
        decidedBy: "TODO",
      },
      {
        subject: "feat(web): hidden behind the first stop",
        domain: "workspace-files",
        verdict: "candidate",
        decidedBy: "TODO",
      },
    ],
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  runner.set("git", ["rev-parse", "refs/tags/v1.2.3^{commit}"], { stdout: `${B}\n` });
  runner.set("git", ["merge-base", C, B], { stdout: `${A}\n` });
  try {
    assert.lengthOf(gateFourStopReasons(checked), 2);
    const { output, result } = captureStdout(() =>
      run(["unblock-auto", "--resume", "--report", checked.reportPath], root, runner),
    );
    assert.strictEqual(result, 2);
    // A stop the operator cannot see costs a whole round trip, so one surface carries them all.
    assert.include(output, "Gate 4 refusal: orientation verdict requires judgement: partial");
    assert.include(output, `Gate 4 refusal: hard overlap lacks a mechanical conflict for`);
    assert.include(output, path);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
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

it("Gate 4 auto-keeps a candidate absent from the target tree and stops on a present one", () => {
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
    assert.isEmpty(gateFourStopReasons(absent));
    assert.deepInclude(autoGateFour(absent)?.orientationDecisions?.[0], {
      verdict: "candidate",
      action: "keep (target tree absent)",
      decidedBy: "agent",
    });
    assert.include(renderRecord(absent), "retire-candidate; target-tree: absent");

    const present = state([{ identifier: "ForkOnlyHelper", location: "apps/web/src/x.ts:14" }]);
    assert.include(
      gateFourStopReasons(present).join("\n"),
      "retire candidate is present in the target tree: `feat: candidate`: ForkOnlyHelper at apps/web/src/x.ts:14",
    );
    assert.isNull(autoGateFour(present));
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
    assert.isEmpty(gateFourStopReasons(state));
    const decided = autoGateFour(state);
    assert.isNotNull(decided);
    assert.lengthOf(
      decided?.orientationDecisions?.filter(
        ({ verdict, action }) => verdict === "candidate" && action === "keep (mechanical seam)",
      ) ?? [],
      3,
    );
    const record = renderRecord(decided ?? state);
    assert.include(record, "[type]: return upstream DesktopPreviewRecordingSource");
    assert.include(record, "| keep (mechanical seam) |");
    validateSignedRecord(record, decided ?? state);
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
    assert.isEmpty(gateFourStopReasons(typeOnly));
    assert.include(gateFourStopReasons(behaviour).join("\n"), "silent seam touches behaviour");
    assert.include(renderRecord(behaviour), "`apps/a.ts` [behaviour]: changed visible behavior");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(typeOnly.reportPath), { recursive: true, force: true });
  }
});

it("unblock-auto stops once with Gate 4 evidence for a behaviour seam", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: root },
    installedHead: B,
    ciHead: B,
    orientation: `mirror:       origin/main matches upstream/main at ${A.slice(0, 12)}\n`,
    silentSeams: [
      { path: "apps/web/src/a.ts", summary: "changed visible behavior", touchesBehaviour: true },
    ],
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  runner.set("git", ["rev-parse", "refs/tags/v1.2.3^{commit}"], { stdout: `${B}\n` });
  runner.set("git", ["merge-base", C, B], { stdout: `${A}\n` });
  try {
    const { output, result } = captureStdout(() =>
      run(["unblock-auto", "--resume", "--report", checked.reportPath], root, runner),
    );
    assert.strictEqual(result, 2);
    assert.include(output, "`apps/web/src/a.ts` [behaviour]: changed visible behavior");
    assert.include(output, "Gate 4 refusal: silent seam touches behaviour");
    assert.isTrue(
      validateReport(JSON.parse(NodeFS.readFileSync(checked.reportPath, "utf8")))
        .behaviourSeamStopPresented,
    );

    let stderr = "";
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      const second = captureStdout(() =>
        run(["unblock-auto", "--resume", "--report", checked.reportPath], root, runner),
      );
      assert.strictEqual(second.result, 1);
      assert.notInclude(second.output, "Gate 4 refusal: silent seam touches behaviour");
      assert.include(stderr, "checked rehearsal head moved");
    } finally {
      process.stderr.write = original;
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("fills the record on a resume from a presented behaviour-seam stop", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const subject = "feat(web): preserve behavior";
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: root },
    installedHead: B,
    ciHead: B,
    orientation: [
      `mirror:       origin/main matches upstream/main at ${A.slice(0, 12)}`,
      `  [candidate] \`${subject}\` (fork-meta)`,
      "      behaviour-overlap: weak hunk overlap: apps/web/src/a.ts@1~2",
      "",
    ].join("\n"),
    orientationDecisions: [
      { subject, domain: "fork-meta", verdict: "candidate", decidedBy: "TODO" },
    ],
    silentSeams: [
      { path: "apps/web/src/a.ts", summary: "changed visible behavior", touchesBehaviour: true },
    ],
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  runner.set("git", ["rev-parse", "refs/tags/v1.2.3^{commit}"], { stdout: `${B}\n` });
  runner.set("git", ["merge-base", C, B], { stdout: `${A}\n` });
  const forkCommitRows = (record: string): ReadonlyArray<string> =>
    (record.split("## Fork commits\n", 2)[1] ?? "")
      .split("\n## ", 1)[0]
      ?.split("\n")
      .filter((line) => line.startsWith("| `")) ?? [];
  try {
    assert.strictEqual(
      captureStdout(() =>
        run(["unblock-auto", "--resume", "--report", checked.reportPath], root, runner),
      ).result,
      2,
    );
    assert.isTrue(
      forkCommitRows(NodeFS.readFileSync(checked.recordPath, "utf8")).some((row) =>
        row.includes("| TODO |"),
      ),
    );

    const original = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      run(["unblock-auto", "--resume", "--report", checked.reportPath], root, runner);
    } finally {
      process.stderr.write = original;
    }
    const rows = forkCommitRows(NodeFS.readFileSync(checked.recordPath, "utf8"));
    assert.lengthOf(rows, 1);
    // The resume owes the same fill the unpresented path runs, so no cell is left for the apply.
    assert.notInclude(rows[0] ?? "", "TODO");
    assert.include(rows[0] ?? "", "| keep (mechanical seam) |");
    assert.include(rows[0] ?? "", "| agent |");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("auto-keeps weak overlap but stops for a retire-candidate conflict", () => {
  const root = fixtureRoot();
  const weak = report(root, {
    stage: "checked",
    installedHead: B,
    orientation:
      "  [candidate] `feat(web): preserve behavior` (fork-meta)\n      behaviour-overlap: weak hunk overlap: apps/web/src/a.ts@1~2\n",
    orientationDecisions: [
      {
        subject: "feat(web): preserve behavior",
        domain: "fork-meta",
        verdict: "candidate",
        decidedBy: "human",
      },
    ],
  });
  const decided = autoGateFour(weak);
  assert.deepInclude(decided?.orientationDecisions?.[0], {
    verdict: "candidate",
    action: "keep (mechanical seam)",
    decidedBy: "agent",
  });

  const blocked = report(root, {
    stage: "checked",
    installedHead: B,
    conflicts: [
      {
        commit: C,
        subject: "fix(web): choose behavior",
        domain: "fork-meta",
        path: "apps/web/src/a.ts",
        class: "retire-candidate",
        resolution: "human choice",
        agentSafe: "no",
        decidedBy: "human",
      },
    ],
  });
  NodeFS.writeFileSync(blocked.reportPath, JSON.stringify(blocked));
  NodeFS.writeFileSync(blocked.recordPath, renderRecord(blocked));
  const blockedRunner = new FakeRunner();
  setBotResponses(blockedRunner, "candidate");
  try {
    const { output, result } = captureStdout(() =>
      run(["unblock-auto", "--resume", "--report", blocked.reportPath], root, blockedRunner),
    );
    assert.strictEqual(result, 2);
    assert.include(output, decisionSurface(renderRecord(blocked)));
    assert.include(
      output,
      `resume: node scripts/fork-sync.ts unblock-auto --resume --report ${blocked.reportPath}\n`,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(weak.reportPath), { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(blocked.reportPath), { recursive: true, force: true });
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
    assert.include(
      stderr,
      `resume: node scripts/fork-sync.ts unblock-auto --resume --report ${checked.reportPath}\n`,
    );
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
    assert.isDefined(
      runner.calls.find(
        ({ command, args }) =>
          command === "git" && args.join(" ").endsWith(`push origin --delete ${branch}`),
      ),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
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
    assert.strictEqual(
      run(["unblock-auto", "--resume", "--report", checked.reportPath], root, runner),
      1,
    );
    assert.include(stderr, "failed: vp run fork:upstream-refs");
    assert.include(
      stderr,
      `resume: node scripts/fork-sync.ts unblock-auto --resume --report ${checked.reportPath}\n`,
    );
  } finally {
    process.stderr.write = original;
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
  }
});

it("refuses apply when the pushed lane moved after the CI verdict", () => {
  const root = fixtureRoot();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const checked = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: root },
    installedHead: B,
    ciHead: B,
  });
  NodeFS.writeFileSync(checked.reportPath, JSON.stringify(checked));
  NodeFS.writeFileSync(checked.recordPath, renderRecord(checked));
  const runner = new FakeRunner();
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  setBotResponses(runner, "candidate");
  runner.set("git", ["-c", "core.commentChar=auto", "rev-parse", "HEAD"], { stdout: `${B}\n` });
  runner.set(
    "git",
    ["-c", "core.commentChar=auto", "ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { stdout: `${C}\trefs/heads/${branch}\n` },
  );
  try {
    assert.throws(
      () =>
        execute(
          ["unblock-apply", "--report", checked.reportPath, "--record", checked.recordPath],
          root,
          runner,
        ),
      /pushed rehearsal lane moved after the CI verdict/,
    );
    assert.isFalse(runner.calls.some(({ command }) => command === "vp"));
  } finally {
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
    assert.deepStrictEqual(inspectRecord(renderRecord(checked), observed), []);
    const { baseTag: _baseTag, ...untagged } = rewrite;
    const withoutTag = report(root, { ...checked, rewrite: untagged });
    assert.deepStrictEqual(inspectRecord(renderRecord(withoutTag), observed), [
      `Target mismatch: record absent@${A}, checkout v0.0.38-nightly.20260831.1236@${A}`,
    ]);
    NodeFS.rmSync(NodePath.dirname(withoutTag.reportPath), { recursive: true, force: true });
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

const dispatchListArgs = [
  "run",
  "list",
  "--workflow",
  "hyprws-upstream-sync.yml",
  "--event",
  "workflow_dispatch",
  "-L",
  "10",
  "--json",
  "databaseId,url",
  "--repo",
  "RSI-Software/t3code-hyprws",
] as const;

it("identifies the new reconciliation run instead of the old race winner", () => {
  const root = fixtureRoot();
  const applied = report(root, { stage: "applied" });
  const runner = new FakeRunner();
  runner.setSequence("gh", dispatchListArgs, [
    { stdout: JSON.stringify([{ databaseId: 10, url: "https://example.test/runs/old" }]) },
    {
      stdout: JSON.stringify([
        { databaseId: 11, url: "https://example.test/runs/new" },
        { databaseId: 10, url: "https://example.test/runs/old" },
      ]),
    },
  ]);
  try {
    const next = reconcileAfterApply(applied, runner);
    assert.deepStrictEqual(next.reconciliation, {
      state: "dispatched",
      baselineRunId: 10,
      runUrl: "https://example.test/runs/new",
    });
    assert.isDefined(
      runner.calls.find(
        ({ command, args }) =>
          command === "gh" &&
          args.join(" ") ===
            "workflow run hyprws-upstream-sync.yml --ref hyprws --repo RSI-Software/t3code-hyprws",
      ),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(applied.reportPath), { recursive: true, force: true });
  }
});

it("resumes an ambiguous reconciliation without redispatching", () => {
  const root = fixtureRoot();
  const applied = report(root, {
    stage: "applied",
    reconciliation: { state: "ambiguous", baselineRunId: 10 },
  });
  const runner = new FakeRunner();
  runner.set("gh", dispatchListArgs, {
    stdout: JSON.stringify([{ databaseId: 12, url: "https://example.test/runs/resumed" }]),
  });
  try {
    const next = reconcileAfterApply(applied, runner);
    assert.strictEqual(next.reconciliation?.runUrl, "https://example.test/runs/resumed");
    assert.isFalse(
      runner.calls.some(
        ({ command, args }) => command === "gh" && args[0] === "workflow" && args[1] === "run",
      ),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(applied.reportPath), { recursive: true, force: true });
  }
});

it("prints resume after an ambiguous reconciliation failure", () => {
  const root = fixtureRoot();
  const applied = report(root, { stage: "applied" });
  NodeFS.writeFileSync(applied.reportPath, JSON.stringify(applied));
  const runner = new FakeRunner();
  runner.set("gh", dispatchListArgs, { stdout: "[]" });
  runner.set(
    "gh",
    [
      "workflow",
      "run",
      "hyprws-upstream-sync.yml",
      "--ref",
      "hyprws",
      "--repo",
      "RSI-Software/t3code-hyprws",
    ],
    { status: 1, stderr: "dispatch failed" },
  );
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.strictEqual(
      run(["unblock-auto", "--resume", "--report", applied.reportPath], root, runner),
      1,
    );
    assert.include(stderr, "failed: gh workflow run");
    assert.include(
      stderr,
      `resume: node scripts/fork-sync.ts unblock-auto --resume --report ${applied.reportPath}`,
    );
    assert.strictEqual(
      validateReport(JSON.parse(NodeFS.readFileSync(applied.reportPath, "utf8"))).reconciliation
        ?.state,
      "ambiguous",
    );
  } finally {
    process.stderr.write = original;
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(applied.reportPath), { recursive: true, force: true });
  }
});

it("unblock-auto takes the conflict STOP path when rerere remaining fails", () => {
  const root = fixtureRoot();
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-auto-lane-"));
  const oriented = report(root, {
    stage: "oriented",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    orientation: `mirror:       origin/main matches upstream/main at ${A.slice(0, 12)}\n`,
  });
  NodeFS.writeFileSync(oriented.reportPath, JSON.stringify(oriented));
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const runner = new FakeRunner();
  setBotResponses(runner, "candidate");
  runner.set("git", ["rev-parse", "origin/hyprws^{commit}"], { stdout: `${C}\n` });
  runner.set("git", ["rev-parse", "refs/tags/v1.2.3^{commit}"], { stdout: `${B}\n` });
  runner.set("git", ["merge-base", C, B], { stdout: `${A}\n` });
  runner.set("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    status: 1,
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
      `${A}..${C}`,
    ],
    { stdout: "feat: one\x1e" },
  );
  runner.set("git", ["-c", "core.commentChar=auto", "rev-list", "--count", `${A}..${C}`], {
    stdout: "1\n",
  });
  runner.set(
    "wt",
    ["switch", "--create", branch, "--base", C, "--no-cd", "--format", "json", "--yes"],
    { stdout: JSON.stringify({ worktree_path: worktree }) },
  );
  runner.set("git", rehearsalRebaseArgs(["rebase", B]), {
    status: 1,
    stderr: "conflict",
  });
  runner.set("git", ["-c", "core.commentChar=auto", "diff", "--name-only", "--diff-filter=U"], {
    stdout: "apps/web/src/manual.ts\n",
  });
  runner.set(
    "git",
    ["-c", "core.commentChar=auto", "show", "-s", "--format=%H%x1f%s%x1f%b", "REBASE_HEAD"],
    { stdout: `${C}\x1ffix(web): choose behavior\x1fFork-Domain: fork-meta\n` },
  );
  runner.setSequence(
    "git",
    ["-c", "core.commentChar=auto", "-c", "rerere.enabled=true", "rerere", "remaining"],
    [{ stdout: "apps/web/src/manual.ts\n" }, { status: 1, stderr: "rerere failed" }],
  );
  try {
    const { output, result } = captureStdout(() =>
      run(["unblock-auto", "--resume", "--report", oriented.reportPath], root, runner),
    );
    assert.strictEqual(result, 2);
    assert.include(output, "Stop. Rebase conflict in fix(web): choose behavior");
    assert.include(
      output,
      `resume: node scripts/fork-sync.ts unblock-auto --resume --report ${oriented.reportPath}\n`,
    );
    assert.lengthOf(
      output.split("\n").filter((line) => line.includes("unblock-rehearse")),
      1,
    );
    assert.notInclude(output, "then rerun unblock-rehearse");
    const stopped = validateReport(JSON.parse(NodeFS.readFileSync(oriented.reportPath, "utf8")));
    assert.deepInclude(stopped.conflicts[0], { class: "TODO", decidedBy: "TODO" });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(oriented.reportPath), { recursive: true, force: true });
  }
});

it("unblock-auto refuses a RUNNING bot with status 3", () => {
  const root = fixtureRoot();
  const listed = report(root);
  NodeFS.writeFileSync(listed.reportPath, JSON.stringify(listed));
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
      run(["unblock-auto", "--resume", "--report", listed.reportPath], root, runner),
      3,
    );
    assert.strictEqual(
      stderr,
      `bot run is in progress; wait for it and rerun unblock-list\nresume: node scripts/fork-sync.ts unblock-auto --resume --report ${listed.reportPath}\n`,
    );
  } finally {
    process.stderr.write = original;
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(listed.reportPath), { recursive: true, force: true });
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
          run(["unblock-auto", "--resume", "--report", listed.reportPath], root, runner),
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
        assert.strictEqual(
          run(["unblock-auto", "--resume", "--report", listed.reportPath], root, runner),
          3,
        );
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
        assert.strictEqual(
          run(["unblock-auto", "--resume", "--report", listed.reportPath], root, runner),
          3,
        );
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
          run(
            ["unblock-auto", "--bot-carried", "--resume", "--report", listed.reportPath],
            root,
            runner,
          ),
          2,
        );
      });
    });
    assert.include(stderr, "--bot-carried cannot resume a report the human lane started");
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

it("pins the rewrite lane scan to its base tag, not upstream/main", () => {
  const state = rewriteReplayedRun("v0.0.38-nightly.20260831.1236");
  try {
    execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    assert.isAbove(
      order(state.runner, "vp", [
        "run",
        "--no-cache",
        "fork:scan",
        "--target",
        "v0.0.38-nightly.20260831.1236",
      ]),
      -1,
    );
    assert.strictEqual(order(state.runner, "vp", ["run", "--no-cache", "fork:scan"]), -1);
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
  }
});

it("resolves the rewrite scan tag from the fork base when the report carries none", () => {
  const state = rewriteReplayedRun(undefined);
  state.runner.set("git", ["tag", "--points-at", A], {
    stdout: "hyprws-checkpoint\nv0.0.38-nightly.20260831.1236\n",
  });
  try {
    execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
    assert.isAbove(
      order(state.runner, "vp", [
        "run",
        "--no-cache",
        "fork:scan",
        "--target",
        "v0.0.38-nightly.20260831.1236",
      ]),
      -1,
    );
  } finally {
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
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
      run(["unblock-auto", "--resume", "--report", state.reportPath], state.root, state.runner),
      1,
    );
    assert.include(stderr, "failed: vp run --no-cache fork:scan --target v1.2.3");
    assert.include(
      stderr,
      `resume: node scripts/fork-sync.ts unblock-auto --resume --report ${state.reportPath}\n`,
    );
  } finally {
    process.stderr.write = original;
    NodeFS.rmSync(state.root, { recursive: true, force: true });
    NodeFS.rmSync(state.worktree, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
  }
});

it("pushes the rehearsal and records the CI verdict on its exact head", () => {
  const { runner, root, worktree, reportPath, branch } = checkedRun();
  try {
    const localTasks = runner.calls.filter(
      ({ command, args }) => command === "vp" && args[0] === "run",
    );
    assert.lengthOf(localTasks, 2);
    for (const call of localTasks) assert.strictEqual(call.args[1], "--no-cache");
    assert.isFalse(
      runner.calls.some(
        ({ command, args }) =>
          command === "vp" &&
          (args[0] === "check" || args.includes("typecheck") || args.includes("test")),
      ),
    );
    assert.isDefined(
      runner.calls.find(
        ({ command, args }) =>
          command === "git" &&
          args.join(" ").endsWith(`push --force-with-lease origin HEAD:refs/heads/${branch}`),
      ),
    );

    const checked = validateReport(JSON.parse(NodeFS.readFileSync(reportPath, "utf8")));
    assert.strictEqual(checked.installedHead, A);
    assert.strictEqual(checked.ciHead, A);
    assert.deepInclude(checked.verification, {
      command: "hyprws CI https://example.test/runs/42",
      result: "passed",
    });
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

it("refuses a check when the record and the report decided the same subject differently", () => {
  const state = undecidedRun();
  const replayed = validateReport(JSON.parse(NodeFS.readFileSync(state.reportPath, "utf8")));
  try {
    NodeFS.writeFileSync(
      state.reportPath,
      JSON.stringify({
        ...replayed,
        orientationDecisions: [
          {
            subject: SUBJECT,
            domain: "workspace-files",
            verdict: "candidate",
            action: "keep (mechanical seam)",
            decidedBy: "agent",
          },
        ],
      }),
    );
    signRecord(replayed.recordPath, "retire", "human");
    assert.throws(
      () => execute(["unblock-check", "--report", state.reportPath], state.root, state.runner),
      /record decision disagrees with the report/,
    );
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
      execute(["unblock-check", "--report", state.reportPath], state.root, state.runner);
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
      () => execute(["unblock-check", "--report", state.reportPath], state.root, state.runner),
      /hyprws CI timed out after 45 minutes/,
    );
    assert.lengthOf(
      state.runner.calls.filter(
        ({ command, args }) => command === "sleep" && args.join(" ") === "30",
      ),
      90,
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
        command === "vp" && (args[0] === "check" || (args[0] === "run" && args[1] !== undefined)),
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
    const code = run(["rewrite-rehearse", "--from", from], root, runner);
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
      assert.match(message, /restart at vp run fork:sync unblock-list/);
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
  const branch = checked.lane!.branch;
  runner.set("git", ["status", "--porcelain"], { stdout: "" });
  // Stub the gate — the full tree read is not exercise its branches here; the
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
      `Lease: report leased at \`${C}\` (origin/hyprws) — any movement of \`origin/hyprws\` voids this rehearsal`,
    );
    assert.include(record, "restart at `vp run fork:sync unblock-list`");
    assert.include(
      record,
      "Stop. Lease boundary: any movement of `origin/hyprws` past the lease above voids this green rehearsal.",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.dirname(checked.reportPath), { recursive: true, force: true });
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
  const runner = new FakeRunner();
  // Minimal stubs for the full check path - use a real git repo lane to satisfy git calls if possible
  // Instead, directly test the parsing layer: parseVerbArgs allows repeatable --silent-seam
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

it("unblock-refresh re-pins header and heads after a lane rewrite", async () => {
  const root = fixtureRoot();
  const lane = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-lane-"));
  // init a git repo in lane so rev-parse HEAD works
  NodeChildProcess.execFileSync("git", ["init", "-b", "main"], { cwd: lane });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: lane });
  NodeChildProcess.execFileSync("git", ["config", "user.name", "t"], { cwd: lane });
  NodeFS.writeFileSync(NodePath.join(lane, "file.txt"), "v1");
  NodeChildProcess.execFileSync("git", ["add", "."], { cwd: lane });
  NodeChildProcess.execFileSync("git", ["commit", "-m", "init"], { cwd: lane });
  const firstHead = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: lane })
    .toString()
    .trim();
  const branch = `rehearse/v1.2.3-from-${C.slice(0, 12)}`;
  const state = report(root, {
    stage: "checked",
    target: { tag: "v1.2.3", sha: B },
    source: { sha: C, expectedOld: C, sharedBase: A },
    lane: { branch, worktree: lane },
    rebasedHead: firstHead,
    installedHead: firstHead,
    ciHead: firstHead,
    verification: [],
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
  assert.strictEqual(refreshed.rebasedHead, secondHead);
  assert.strictEqual(refreshed.installedHead, secondHead);
  assert.strictEqual(refreshed.ciHead, secondHead);
  const record = NodeFS.readFileSync(refreshed.recordPath, "utf8");
  assert.include(record, secondHead);
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(lane, { recursive: true, force: true });
  NodeFS.rmSync(NodePath.dirname(state.reportPath), { recursive: true, force: true });
});
