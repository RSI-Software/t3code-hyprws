// @effect-diagnostics nodeBuiltinImport:off - The sync driver is Git plumbing; fixtures need real repositories.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  blockedIssueBody,
  blockingShaMarker,
  closeBlocks,
  failureIssueBody,
  failureMarker,
  publishBlock,
  publishFailure,
  readReport,
  renderReport,
  reportPath,
  run,
  type CommandRunner,
  type ForkSyncReport,
} from "./fork-sync.ts";
import { runCommand, type CommandResult } from "./lib/fork-command.ts";

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const refused = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr });

// ---------------------------------------------------------------------------
// Fixture: one upstream remote, one origin remote, a fork trunk
// ---------------------------------------------------------------------------

interface Fixture {
  readonly root: string;
  readonly worktree: string;
  readonly git: (args: ReadonlyArray<string>, cwd?: string) => string;
}

const fixture = (options: {
  readonly forkContent: string;
  readonly upstreamContent: string;
  /** The fork branches from the tagged upstream commit instead of its base. */
  readonly forkOnTag?: boolean;
  readonly nightlyTag?: boolean;
}): Fixture => {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-test-"));
  const git = (args: ReadonlyArray<string>, cwd = base): string => {
    const result = runCommand("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.stderr.trim() || "failed"}`);
    return result.stdout.trim();
  };
  const configure = (cwd: string): void => {
    git(["config", "user.email", "fork@example.invalid"], cwd);
    git(["config", "user.name", "fork"], cwd);
  };
  const upstream = NodePath.join(base, "upstream.git");
  const origin = NodePath.join(base, "origin.git");
  const repo = NodePath.join(base, "repo");
  git(["init", "--quiet", "--bare", "--initial-branch", "main", upstream]);
  git(["init", "--quiet", "--bare", "--initial-branch", "main", origin]);
  git(["init", "--quiet", "--initial-branch", "main", repo]);
  configure(repo);
  NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), "line1\nline2\nline3\n");
  git(["add", "."], repo);
  git(["commit", "--quiet", "-m", "base"], repo);
  git(["remote", "add", "origin", origin], repo);
  git(["remote", "add", "upstream", upstream], repo);
  git(["push", "--quiet", "origin", "main"], repo);
  git(["push", "--quiet", "upstream", "main"], repo);

  const tagUpstream = (): void => {
    git(["checkout", "--quiet", "main"], repo);
    NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), options.upstreamContent);
    git(["commit", "--quiet", "-am", "upstream change"], repo);
    git(["tag", "v1.0.0"], repo);
    if (options.nightlyTag === true) {
      NodeFS.writeFileSync(
        NodePath.join(repo, "shared.txt"),
        `${options.upstreamContent}upstream more\n`,
      );
      git(["commit", "--quiet", "-am", "upstream nightly"], repo);
      git(["tag", "v1.0.1-nightly.20260901.1"], repo);
    }
    git(
      [
        "push",
        "--quiet",
        "upstream",
        "main",
        "v1.0.0",
        ...(options.nightlyTag === true ? ["v1.0.1-nightly.20260901.1"] : []),
      ],
      repo,
    );
  };

  // The fork branches from the base, or from the tag itself when it already sits on it.
  if (options.forkOnTag === true) tagUpstream();
  git(
    ["checkout", "--quiet", "-b", "hyprws", options.forkOnTag === true ? "v1.0.0" : "main"],
    repo,
  );
  NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), options.forkContent);
  git(["commit", "--quiet", "-am", "fork change"], repo);
  git(["push", "--quiet", "origin", "hyprws"], repo);
  if (options.forkOnTag !== true) {
    git(["checkout", "--quiet", "main"], repo);
    tagUpstream();
    git(["checkout", "--quiet", "hyprws"], repo);
  }
  return {
    root: repo,
    worktree: NodePath.join(repo, ".t3", "fork-sync", "worktree"),
    git,
  };
};

const withFixture = (
  options: Parameters<typeof fixture>[0],
  effect: (fixture: Fixture) => void,
): void => {
  const f = fixture(options);
  try {
    effect(f);
  } finally {
    NodeFS.rmSync(NodePath.dirname(f.root), { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Runner stub: git is real, vp/gh/ghb are recorded
// ---------------------------------------------------------------------------

interface Recording {
  readonly runner: CommandRunner;
  readonly calls: ReadonlyArray<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
}

const exec = (
  handlers: {
    readonly vp?: (args: ReadonlyArray<string>) => CommandResult;
    readonly gh?: (args: ReadonlyArray<string>) => CommandResult;
    readonly ghb?: (args: ReadonlyArray<string>) => CommandResult;
  } = {},
): Recording => {
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  return {
    calls,
    runner: {
      run: (command, args, spec) => {
        calls.push({ command, args });
        if (command === "vp") return handlers.vp?.(args) ?? ok();
        if (command === "gh") return handlers.gh?.(args) ?? ok("[]");
        if (command === "ghb") return handlers.ghb?.(args) ?? ok();
        return runCommand(command, args, {
          cwd: spec.cwd,
          ...(spec.env === undefined ? {} : { env: spec.env }),
          ...(spec.stream === undefined ? {} : { stream: spec.stream }),
        });
      },
    },
  };
};

const capture = <T>(effect: () => T): { readonly output: string; readonly value: T } => {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    const value = effect();
    return { output: chunks.join(""), value };
  } finally {
    process.stdout.write = original;
  }
};

const forkShas = (f: Fixture): { readonly fork: string; readonly upstream: string } => ({
  fork: f.git(["rev-parse", "hyprws"], f.root),
  upstream: f.git(["rev-parse", "upstream/main"], f.root),
});

// ---------------------------------------------------------------------------
// The blocked → resolve → rerun loop
// ---------------------------------------------------------------------------

it("stops at a conflict rerere and hooks cannot resolve, then applies after a hand resolution", () => {
  withFixture(
    {
      forkContent: "line1\nline2 fork\nline3\n",
      upstreamContent: "line1\nline2 upstream\nline3\n",
    },
    (f) => {
      const shas = forkShas(f);
      const { runner } = exec();

      // first run: blocked, exit non-zero, one report with the conflict table
      const first = capture(() => run(["v1.0.0"], { runner, root: f.root }));
      assert.strictEqual(first.value, 1);
      const blocked = readReport(f.root, "v1.0.0");
      assert.strictEqual(blocked.outcome, "blocked");
      assert.strictEqual(blocked.dryRun, false);
      assert.strictEqual(blocked.target.tag, "v1.0.0");
      assert.strictEqual(blocked.trunk.after, null);
      assert.strictEqual(blocked.conflicts.length, 1);
      const row = blocked.conflicts[0]!;
      assert.strictEqual(row.path, "shared.txt");
      assert.strictEqual(row.via, "human");
      assert.strictEqual(row.forkCommit, shas.fork);
      assert.strictEqual(row.upstreamCommit, shas.upstream);
      assert.deepEqual(blocked.decision.paths, ["shared.txt"]);
      assert.match(blocked.decision.resume, /rebase --continue/);
      assert.match(first.output, /\| Path \| Fork commit \| Upstream commit \|/);

      // the report is the authority; the worktree it names holds the stop
      assert.strictEqual(NodeFS.existsSync(NodePath.join(f.worktree, "shared.txt")), true);

      // hand resolution, exactly as the decision route says
      NodeFS.writeFileSync(
        NodePath.join(f.worktree, "shared.txt"),
        "line1\nline2 resolved\nline3\n",
      );
      f.git(["add", "shared.txt"], f.worktree);
      f.git(["-c", "core.editor=true", "rebase", "--continue"], f.worktree);

      // rerun: rerere replays the resolution; the dry run reaches applied
      const second = exec();
      const applied = capture(() =>
        run(["v1.0.0", "--dry-run"], { runner: second.runner, root: f.root }),
      );
      assert.strictEqual(applied.value, 0);
      const report = readReport(f.root, "v1.0.0");
      assert.strictEqual(report.outcome, "applied");
      assert.strictEqual(report.dryRun, true);
      assert.strictEqual(report.trunk.before, blocked.trunk.before);
      assert.notStrictEqual(report.trunk.after, report.trunk.before);
      assert.strictEqual(report.push.pushed, false);
      assert.strictEqual(report.conflicts.length, 0);
      assert.strictEqual(report.checks.length, 3);
      for (const check of report.checks) assert.strictEqual(check.status, "passed");
    },
  );
});

it("refuses the push when the check battery is red and records the failing command", () => {
  withFixture(
    {
      forkContent: "fork line1\nline2\nline3\n",
      upstreamContent: "line1\nline2\nline3 upstream\n",
    },
    (f) => {
      const shas = forkShas(f);
      const recording = exec({
        vp: (args) =>
          args[1] === "fork:ci"
            ? refused("fork:ci: scripts suite failed; fix above before pushing\n")
            : ok(),
      });
      const printed = capture(() => run(["v1.0.0"], { runner: recording.runner, root: f.root }));
      assert.strictEqual(printed.value, 1);
      const report = readReport(f.root, "v1.0.0");
      assert.strictEqual(report.outcome, "failed");
      assert.strictEqual(report.error, "the check battery is red");
      assert.strictEqual(report.trunk.after, null);
      assert.strictEqual(report.push.pushed, false);
      const red = report.checks.find((check) => check.status === "failed");
      assert.notStrictEqual(red, undefined);
      assert.strictEqual(red!.command, "vp run fork:ci");
      assert.match(red!.detail, /scripts suite failed/);
      assert.match(red!.detail, /exit 1/);
      // the rendered report shows the red row
      assert.match(printed.output, /❌ `vp run fork:ci`/);
      // a red battery never reaches the push
      assert.strictEqual(
        recording.calls.some(({ command, args }) => command === "git" && args[0] === "push"),
        false,
      );
      assert.strictEqual(f.git(["rev-parse", "origin/hyprws"], f.root), shas.fork);
    },
  );
});

it("pushes the rebased tip after a green battery", () => {
  withFixture(
    {
      forkContent: "fork line1\nline2\nline3\n",
      upstreamContent: "line1\nline2\nline3 upstream\n",
    },
    (f) => {
      const recording = exec();
      const code = capture(() => run(["v1.0.0"], { runner: recording.runner, root: f.root })).value;
      assert.strictEqual(code, 0);
      const report = readReport(f.root, "v1.0.0");
      assert.strictEqual(report.outcome, "applied");
      assert.strictEqual(report.push.pushed, true);
      assert.strictEqual(report.checks.length, 3);
      for (const check of report.checks) assert.strictEqual(check.status, "passed");
      const push = recording.calls.find(
        ({ command, args }) => command === "git" && args[0] === "push",
      );
      assert.notStrictEqual(push, undefined);
      assert.match(push!.args.join(" "), /--force-with-lease=hyprws:/);
      assert.strictEqual(f.git(["rev-parse", "origin/hyprws"], f.root), report.trunk.after);
    },
  );
});

it("resolves a marked hook seam by re-applying the hook", () => {
  withFixture(
    {
      forkContent: 'line1\nexport const line2 = "fork"; // fork-hook: fork-meta/test\nline3\n',
      upstreamContent: "line1\nline2 upstream\nline3\n",
    },
    (f) => {
      const { runner } = exec();
      const code = capture(() => run(["v1.0.0", "--dry-run"], { runner, root: f.root })).value;
      assert.strictEqual(code, 0);
      const report = readReport(f.root, "v1.0.0");
      assert.strictEqual(report.outcome, "applied");
      assert.strictEqual(report.conflicts.length, 1);
      const row = report.conflicts[0]!;
      assert.strictEqual(row.via, "hook");
      assert.deepEqual(row.hooksReapplied, ["fork-meta/test"]);
    },
  );
});

it("exits 0 with already applied when the fork sits on the tag", () => {
  withFixture(
    {
      forkContent: "line1\nline2 fork\nline3\n",
      upstreamContent: "line1\nline2 upstream\nline3\n",
      forkOnTag: true,
    },
    (f) => {
      const { runner } = exec();
      const code = capture(() => run(["v1.0.0"], { runner, root: f.root })).value;
      assert.strictEqual(code, 0);
      const report = readReport(f.root, "v1.0.0");
      assert.strictEqual(report.outcome, "already-applied");
      assert.strictEqual(report.conflicts.length, 0);
      assert.strictEqual(report.trunk.after, report.trunk.before);
    },
  );
});

it("picks the newest upstream release tag when no tag is given", () => {
  withFixture(
    {
      forkContent: "fork line1\nline2\nline3\n",
      upstreamContent: "line1\nline2\nline3 upstream\n",
      nightlyTag: true,
    },
    (f) => {
      const { runner } = exec();
      const code = capture(() => run(["--dry-run"], { runner, root: f.root })).value;
      assert.strictEqual(code, 0);
      const report = readReport(f.root, "v1.0.1-nightly.20260901.1");
      assert.strictEqual(report.target.tag, "v1.0.1-nightly.20260901.1");
      assert.strictEqual(report.outcome, "applied");
      assert.strictEqual(report.conflicts.length, 0);
    },
  );
});

it("refuses a target that is not a release tag on upstream", () => {
  withFixture(
    {
      forkContent: "line1\nline2 fork\nline3\n",
      upstreamContent: "line1\nline2 upstream\nline3\n",
    },
    (f) => {
      const created: Array<{ readonly title: string; readonly body: string }> = [];
      const recording = exec({
        gh: () => ok("[]"),
        ghb: (args) => {
          if (args[0] === "issue" && args[1] === "create") {
            created.push({
              title: args[args.indexOf("--title") + 1] ?? "",
              body: NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"),
            });
            return ok("https://github.com/RSI-Software/t3code-hyprws/issues/45\n");
          }
          return ok();
        },
      });
      const code = capture(() => run(["v9.9.9"], { runner: recording.runner, root: f.root })).value;
      assert.strictEqual(code, 1);
      const report = JSON.parse(
        NodeFS.readFileSync(reportPath(f.root, "v9.9.9"), "utf8"),
      ) as ForkSyncReport;
      assert.strictEqual(report.outcome, "failed");
      assert.match(report.error ?? "", /not a release tag/);
      // the named target keys the failure issue even though it never resolved
      assert.strictEqual(created[0]?.title, "hyprws sync failed at target (v9.9.9)");
      assert.include(created[0]?.body ?? "", failureMarker("target", "v9.9.9"));
    },
  );
});

// ---------------------------------------------------------------------------
// Blocked publication through ghb
// ---------------------------------------------------------------------------

const blockedReport = (blockingSha: string): ForkSyncReport => ({
  schema: "fork.sync-report.v1",
  outcome: "blocked",
  dryRun: false,
  startedAt: "2026-09-21T10:00:00.000Z",
  finishedAt: "2026-09-21T10:01:00.000Z",
  repository: "RSI-Software/t3code-hyprws",
  target: { tag: "v1.0.0", sha: "1".repeat(40) },
  lease: { expectedOld: "2".repeat(40) },
  trunk: { before: "2".repeat(40), after: null },
  base: "3".repeat(40),
  rerere: { restored: false, saved: false, published: false },
  conflicts: [
    {
      path: "apps/web/src/page.tsx",
      forkCommit: "4".repeat(40),
      forkSubject: "feat: fork seam",
      upstreamCommit: blockingSha,
      upstreamSubject: "feat: upstream rewrite",
      via: "human",
      hooksReapplied: [],
    },
  ],
  checks: [],
  closedBlocks: [],
  decision: {
    worktree: "/tmp/fork-sync/worktree",
    paths: ["apps/web/src/page.tsx"],
    resume: 'git -C /tmp/fork-sync/worktree add -- "apps/web/src/page.tsx"',
  },
  blocked: {
    issue: null,
    title: `hyprws sync blocked at v1.0.0 (upstream ${blockingSha.slice(0, 7)})`,
    blockingSha,
    publishError: null,
    publishedVia: null,
  },
  failure: null,
  push: { pushed: false, detail: "" },
  error: "blocked",
});

const failedReport = (step: string, key: string): ForkSyncReport => ({
  schema: "fork.sync-report.v1",
  outcome: "failed",
  dryRun: false,
  startedAt: "2026-09-21T10:00:00.000Z",
  finishedAt: "2026-09-21T10:01:00.000Z",
  repository: "RSI-Software/t3code-hyprws",
  target: { tag: key, sha: "1".repeat(40) },
  lease: { expectedOld: "2".repeat(40) },
  trunk: { before: "2".repeat(40), after: null },
  base: "3".repeat(40),
  rerere: { restored: false, saved: false, published: false },
  conflicts: [],
  checks: [{ command: "vp run fork:delta --check", status: "failed", detail: "red" }],
  decision: { worktree: "", paths: [], resume: "" },
  blocked: null,
  closedBlocks: [],
  failure: {
    issue: null,
    title: `hyprws sync failed at ${step} (${key})`,
    step,
    key,
    publishError: null,
    publishedVia: null,
  },
  push: { pushed: false, detail: "" },
  error: "the check battery is red",
});

it("files one issue per blocking sha with the governed fields", () => {
  const issueBodies: string[] = [];
  const recording = exec({
    gh: () => ok("[]"),
    ghb: (args) => {
      if (args[0] === "issue" && args[1] === "create")
        issueBodies.push(NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"));
      return ok("https://github.com/RSI-Software/t3code-hyprws/issues/42\n");
    },
  });
  const report = publishBlock(recording.runner, "/tmp", blockedReport("5".repeat(40)));
  assert.strictEqual(report.blocked?.issue, 42);
  assert.strictEqual(report.blocked?.publishedVia, "ghb");
  const create = recording.calls.find(({ args }) => args[0] === "issue" && args[1] === "create");
  assert.notStrictEqual(create, undefined);
  const args = create!.args;
  const value = (name: string): string | undefined => args[args.indexOf(name) + 1];
  assert.strictEqual(value("--title"), "hyprws sync blocked at v1.0.0 (upstream 5555555)");
  assert.strictEqual(value("--type"), "Notification 🔔");
  assert.strictEqual(value("--priority"), "High");
  assert.strictEqual(value("--filed-by"), "Agent 🤖");
  assert.strictEqual(value("--source"), "1151");
  assert.deepStrictEqual(
    args.filter((argument, index) => args[index - 1] === "--label"),
    ["ci"],
  );
  assert.ok(args.includes("--no-project"));
  assert.ok(args.includes("--no-relationship"));
  const list = recording.calls.find(({ command, args }) => command === "gh" && args[0] === "issue");
  assert.notStrictEqual(list, undefined);
  assert.strictEqual(
    list!.args[list!.args.indexOf("--search") + 1],
    '"hyprws sync blocked" in:title',
  );
  const body = issueBodies[0] ?? "";
  assert.match(body, /^Origin: hyprws sync run onto v1\.0\.0; `vp run fork:sync v1\.0\.0`\./);
  assert.match(
    body,
    /\| `apps\/web\/src\/page\.tsx` \| `4444444 feat: fork seam` \| `5555555 feat: upstream rewrite` \|/,
  );
  assert.include(body, blockingShaMarker("5".repeat(40)));
});

it("updates the open issue keyed by the blocking sha instead of filing a new one", () => {
  const created: boolean[] = [];
  const recording = exec({
    gh: () =>
      ok(
        JSON.stringify([
          { number: 11, title: "old", body: `stale\n${blockingShaMarker("5".repeat(40))}` },
        ]),
      ),
    ghb: (args) => {
      if (args[0] === "issue" && args[1] === "create") created.push(true);
      return ok();
    },
  });
  const report = publishBlock(recording.runner, "/tmp", blockedReport("5".repeat(40)));
  assert.strictEqual(report.blocked?.issue, 11);
  assert.deepStrictEqual(created, []);
  const comment = recording.calls.find(({ args }) => args[0] === "issue" && args[1] === "comment");
  assert.notStrictEqual(comment, undefined);
  assert.strictEqual(comment!.args[2], "11");
});

it("prints the body and records the refusal when ghb refuses", () => {
  const recording = exec({
    gh: () => ok("[]"),
    ghb: () => refused("delegated agents cannot create issues"),
  });
  const printed = capture(() =>
    publishBlock(recording.runner, "/tmp", blockedReport("5".repeat(40))),
  );
  assert.match(printed.value.blocked?.publishError ?? "", /cannot create issues/);
  assert.strictEqual(printed.value.blocked?.publishedVia, null);
  assert.match(printed.output, /\| Path \| Fork commit \| Upstream commit \|/);
  assert.include(printed.output, blockingShaMarker("5".repeat(40)));
});

it("falls back to bare gh when ghb cannot spawn, same body and title", () => {
  const issueBodies: string[] = [];
  const recording = exec({
    gh: (args) => {
      if (args[0] === "issue" && args[1] === "create") {
        issueBodies.push(NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"));
        return ok("https://github.com/RSI-Software/t3code-hyprws/issues/43\n");
      }
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      return ok();
    },
    ghb: () => ({
      status: 1,
      stdout: "",
      stderr: "spawnSync ghb ENOENT",
      error: new Error("spawnSync ghb ENOENT"),
    }),
  });
  const report = publishBlock(recording.runner, "/tmp", blockedReport("5".repeat(40)));
  assert.strictEqual(report.blocked?.issue, 43);
  assert.strictEqual(report.blocked?.publishedVia, "gh");
  assert.strictEqual(report.blocked?.publishError, null);
  const create = recording.calls.find(
    ({ command, args }) => command === "gh" && args[0] === "issue" && args[1] === "create",
  );
  assert.notStrictEqual(create, undefined);
  const args = create!.args;
  const value = (name: string): string | undefined => args[args.indexOf(name) + 1];
  assert.strictEqual(value("--title"), "hyprws sync blocked at v1.0.0 (upstream 5555555)");
  assert.deepStrictEqual(
    args.filter((argument, index) => args[index - 1] === "--label"),
    ["ci"],
  );
  assert.strictEqual(args.includes("--type"), false, "bare gh carries no governed filing fields");
  const body = issueBodies[0] ?? "";
  assert.match(body, /^Origin: hyprws sync run onto v1\.0\.0;/);
  assert.match(body, /\| `apps\/web\/src\/page\.tsx` \|/);
  assert.include(body, blockingShaMarker("5".repeat(40)));
  // the probe is the only ghb traffic
  for (const call of recording.calls)
    if (call.command === "ghb") assert.strictEqual(call.args[0], "--version");

  // the same fallback closes through gh
  const closed: Array<{ readonly number: number; readonly command: string }> = [];
  closeBlocks(
    {
      run: (command, closeArgs) => {
        if (command === "gh" && closeArgs[1] === "close")
          closed.push({ number: Number(closeArgs[2]), command });
        if (command === "gh" && closeArgs[1] === "list") return ok("[]");
        return ok();
      },
    },
    "/tmp",
    "abc1234def",
  );
  assert.deepStrictEqual(closed, []);
});

it("closes every open block and failure issue with the claim, comment, close sequence", () => {
  const bodies: string[] = [];
  // each governed search matches only its own phrase: block issues under the
  // blocked phrase, the failure issue under the sync-failure phrase
  const recording = exec({
    gh: (args) =>
      ok(
        JSON.stringify(
          args[args.indexOf("--search") + 1] === '"hyprws sync failed" in:title'
            ? [{ number: 11, title: "f", body: "z" }]
            : [
                { number: 7, title: "a", body: "x" },
                { number: 9, title: "b", body: "y" },
              ],
        ),
      ),
    ghb: (args) => {
      if (args[0] === "issue" && args[1] === "comment")
        bodies.push(NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"));
      return ok();
    },
  });
  const closures = closeBlocks(recording.runner, "/tmp", "abc1234def");
  assert.deepStrictEqual(closures, [
    { issue: 7, refusal: null },
    { issue: 9, refusal: null },
    { issue: 11, refusal: null },
  ]);
  // claim (judged Standalone 📍: the driver files parentless, --no-project)
  // before comment before close, per issue, with no sleeps between
  const claim = recording.calls.find(
    ({ command, args }) => command === "ghb" && args[1] === "claim",
  );
  assert.notStrictEqual(claim, undefined);
  assert.ok(claim!.args.includes("--standalone"));
  const sequence = recording.calls
    .filter(({ command, args }) => command === "ghb" && args[0] !== "--version")
    .map(({ args }) => [args[1], String(args[2])]);
  assert.deepStrictEqual(sequence, [
    ["claim", "7"],
    ["comment", "7"],
    ["close", "7"],
    ["claim", "9"],
    ["comment", "9"],
    ["close", "9"],
    ["claim", "11"],
    ["comment", "11"],
    ["close", "11"],
  ]);
  // the comment names the applied trunk sha: it publishes before the close
  // precondition check, so unlike --comment it counts as evidence
  assert.deepStrictEqual(bodies, [
    "Resolved by hyprws abc1234def.",
    "Resolved by hyprws abc1234def.",
    "Resolved by hyprws abc1234def.",
  ]);
  const close = recording.calls.find(
    ({ command, args }) => command === "ghb" && args[1] === "close",
  );
  assert.notStrictEqual(close, undefined);
  assert.ok(close!.args.includes("--reason"));
  assert.strictEqual(close!.args.includes("--comment"), false);
});

it("records a refused close per issue and still closes the others", () => {
  const recording = exec({
    gh: (args) =>
      ok(
        JSON.stringify(
          args[args.indexOf("--search") + 1] === '"hyprws sync failed" in:title'
            ? []
            : [
                { number: 7, title: "a", body: "x" },
                { number: 9, title: "b", body: "y" },
              ],
        ),
      ),
    ghb: (args) =>
      args[1] === "close" && args[2] === "7"
        ? refused("Issue RSI-Software/t3code-hyprws#7 was not closed: no assignee.")
        : ok(),
  });
  const closures = closeBlocks(recording.runner, "/tmp", "abc1234def");
  assert.deepStrictEqual(closures, [
    {
      issue: 7,
      refusal:
        "ghb issue close 7 --reason completed --repo RSI-Software/t3code-hyprws failed: Issue RSI-Software/t3code-hyprws#7 was not closed: no assignee.",
    },
    { issue: 9, refusal: null },
  ]);
  // the claim and the sha comment still ran for the refused issue
  const refused7 = recording.calls.filter(
    ({ command, args }) => command === "ghb" && args[2] === "7",
  );
  assert.deepStrictEqual(
    refused7.map(({ args }) => args[1]),
    ["claim", "comment", "close"],
  );
});

// ---------------------------------------------------------------------------
// Failure publication for a non-blocked failed run
// ---------------------------------------------------------------------------

const checkRedFixture = {
  forkContent: "fork line1\nline2\nline3\n",
  upstreamContent: "line1\nline2\nline3 upstream\n",
};

it("files one governed failure issue when the check battery goes red", () => {
  withFixture(checkRedFixture, (f) => {
    const issueBodies: string[] = [];
    const recording = exec({
      vp: () => refused("fork:delta --check is red"),
      gh: () => ok("[]"),
      ghb: (args) => {
        if (args[0] === "issue" && args[1] === "create") {
          issueBodies.push(
            NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"),
          );
          return ok("https://github.com/RSI-Software/t3code-hyprws/issues/42\n");
        }
        return ok();
      },
    });
    const code = capture(() => run(["v1.0.0"], { runner: recording.runner, root: f.root })).value;
    assert.strictEqual(code, 1);
    const report = readReport(f.root, "v1.0.0");
    assert.strictEqual(report.outcome, "failed");
    assert.strictEqual(report.failure?.step, "check");
    assert.strictEqual(report.failure?.key, "v1.0.0");
    assert.strictEqual(report.failure?.issue, 42);
    assert.strictEqual(report.failure?.publishedVia, "ghb");
    assert.strictEqual(report.failure?.publishError, null);
    const create = recording.calls.find(
      ({ command, args }) => command === "ghb" && args[0] === "issue" && args[1] === "create",
    );
    assert.notStrictEqual(create, undefined);
    const args = create!.args;
    const value = (name: string): string | undefined => args[args.indexOf(name) + 1];
    assert.strictEqual(value("--title"), "hyprws sync failed at check (v1.0.0)");
    assert.strictEqual(value("--type"), "Notification 🔔");
    assert.strictEqual(value("--priority"), "High");
    assert.strictEqual(value("--source"), "1151");
    assert.deepStrictEqual(
      args.filter((argument, index) => args[index - 1] === "--label"),
      ["ci"],
    );
    const list = recording.calls.find(
      ({ command, args }) => command === "gh" && args[0] === "issue",
    );
    assert.strictEqual(
      list!.args[list!.args.indexOf("--search") + 1],
      '"hyprws sync failed" in:title',
    );
    const body = issueBodies[0] ?? "";
    assert.match(body, /failed at the `check` step/);
    assert.match(body, /```\nthe check battery is red\n```/);
    assert.match(body, /\| `vp run fork:delta --check` \| failed \|/);
    assert.include(body, failureMarker("check", "v1.0.0"));
  });
});

it("a rerun with the same failure comments on the issue instead of filing again", () => {
  withFixture(checkRedFixture, (f) => {
    let creates = 0;
    const comments: Array<{ readonly issue: string; readonly body: string }> = [];
    let listResponse = ok("[]");
    const recording = exec({
      vp: () => refused("fork:delta --check is red"),
      gh: (args) => (args[0] === "issue" && args[1] === "list" ? listResponse : ok()),
      ghb: (args) => {
        if (args[0] === "issue" && args[1] === "create") {
          creates += 1;
          return ok("https://github.com/RSI-Software/t3code-hyprws/issues/42\n");
        }
        if (args[0] === "issue" && args[1] === "comment")
          comments.push({
            issue: args[2] ?? "",
            body: NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"),
          });
        return ok();
      },
    });
    assert.strictEqual(
      capture(() => run(["v1.0.0"], { runner: recording.runner, root: f.root })).value,
      1,
    );
    assert.strictEqual(creates, 1);

    listResponse = ok(
      JSON.stringify([
        {
          number: 42,
          title: "hyprws sync failed at check (v1.0.0)",
          body: `first failure\n${failureMarker("check", "v1.0.0")}`,
        },
      ]),
    );
    assert.strictEqual(
      capture(() => run(["v1.0.0"], { runner: recording.runner, root: f.root })).value,
      1,
    );
    assert.strictEqual(creates, 1, "never files again");
    assert.deepStrictEqual(
      comments.map(({ issue }) => issue),
      ["42"],
    );
    assert.include(comments[0]?.body ?? "", failureMarker("check", "v1.0.0"));
    const report = readReport(f.root, "v1.0.0");
    assert.strictEqual(report.failure?.issue, 42);
    assert.strictEqual(report.failure?.publishedVia, "ghb");
  });
});

it("a dry run reports the failure and files nothing", () => {
  withFixture(checkRedFixture, (f) => {
    let creates = 0;
    const recording = exec({
      vp: () => refused("fork:delta --check is red"),
      gh: () => ok("[]"),
      ghb: (args) => {
        if (args[0] === "issue" && args[1] === "create") creates += 1;
        return ok();
      },
    });
    const code = capture(() =>
      run(["v1.0.0", "--dry-run"], { runner: recording.runner, root: f.root }),
    ).value;
    assert.strictEqual(code, 1);
    const report = readReport(f.root, "v1.0.0");
    assert.strictEqual(report.outcome, "failed");
    assert.strictEqual(report.failure?.step, "check");
    assert.strictEqual(report.failure?.issue, null);
    assert.strictEqual(creates, 0);
    for (const call of recording.calls) assert.notStrictEqual(call.command, "gh");
  });
});

it("files a failure issue keyed by the trunk sha when the run crashes before a tag resolves", () => {
  withFixture(checkRedFixture, (f) => {
    const head = f.git(["rev-parse", "HEAD"], f.root);
    const created: Array<{ readonly title: string; readonly body: string }> = [];
    const recording = exec({
      gh: () => ok("[]"),
      ghb: (args) => {
        if (args[0] === "issue" && args[1] === "create") {
          created.push({
            title: args[args.indexOf("--title") + 1] ?? "",
            body: NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"),
          });
          return ok("https://github.com/RSI-Software/t3code-hyprws/issues/44\n");
        }
        return ok();
      },
    });
    const runner: CommandRunner = {
      run: (command, args, spec) =>
        command === "git" && args[0] === "fetch"
          ? refused("network unreachable")
          : recording.runner.run(command, args, spec),
    };
    const code = capture(() => run([], { runner, root: f.root })).value;
    assert.strictEqual(code, 1);
    // no tag resolved, none was named, so no report is written
    assert.strictEqual(NodeFS.existsSync(reportPath(f.root, "v1.0.0")), false);
    assert.strictEqual(created[0]?.title, `hyprws sync failed at fetch (${head.slice(0, 7)})`);
    assert.include(created[0]?.body ?? "", failureMarker("fetch", head));
    assert.include(created[0]?.body ?? "", "network unreachable");
  });
});

it("prints the body and records the refusal when the failure issue cannot publish", () => {
  const recording = exec({
    gh: () => ok("[]"),
    ghb: () => refused("delegated agents cannot create issues"),
  });
  const body = failureIssueBody(failedReport("push", "v1.0.0"));
  assert.match(body, /failed at the `push` step/);
  assert.include(body, failureMarker("push", "v1.0.0"));
  const printed = capture(() =>
    publishFailure(recording.runner, "/tmp", failedReport("push", "v1.0.0")),
  );
  assert.match(printed.value.failure?.publishError ?? "", /cannot create issues/);
  assert.strictEqual(printed.value.failure?.publishedVia, null);
  assert.include(printed.output, failureMarker("push", "v1.0.0"));
});

it("renders the report and the issue body as pure output of the typed report", () => {
  const report = blockedReport("5".repeat(40));
  const markdown = renderReport(report);
  assert.match(markdown, /🛑 blocked/);
  assert.match(markdown, /Lease: origin\/hyprws at 2222222/);
  assert.match(markdown, /## Decision route/);
  assert.match(markdown, /`\/tmp\/fork-sync\/worktree`/);
  const body = blockedIssueBody(report);
  assert.match(body, /\| Path \| Fork commit \| Upstream commit \|/);
  assert.match(body, /The typed report is the authority/);
  assert.include(body, blockingShaMarker("5".repeat(40)));
  assert.match(body, /git -C \/tmp\/fork-sync\/worktree add/);
});

// ---------------------------------------------------------------------------
// The clean run closing the block issues it filed
// ---------------------------------------------------------------------------

const appliedFixture = {
  forkContent: "fork line1\nline2\nline3\n",
  upstreamContent: "line1\nline2\nline3 upstream\n",
};

const alreadyAppliedFixture = { ...appliedFixture, forkOnTag: true } as const;

const openBlocks = (): string =>
  JSON.stringify([{ number: 1164, title: "hyprws sync blocked at v1.0.0", body: "stale" }]);

/** Each governed search matches only its own phrase; no failure issue exists in these runs. */
const openBlocksPerPhrase = (args: ReadonlyArray<string>): CommandResult =>
  ok(args[args.indexOf("--search") + 1] === '"hyprws sync failed" in:title' ? "[]" : openBlocks());

it("a clean applied run closes its open block issues unaided", () => {
  withFixture(appliedFixture, (f) => {
    const { runner } = exec({
      gh: openBlocksPerPhrase,
      ghb: (args) => {
        if (args[1] === "comment")
          assert.match(
            NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"),
            new RegExp(`Resolved by hyprws ${f.git(["rev-parse", "origin/hyprws"], f.root)}\\.`),
          );
        return ok();
      },
    });
    const applied = capture(() => run(["v1.0.0"], { runner, root: f.root }));
    assert.strictEqual(applied.value, 0);
    const report = readReport(f.root, "v1.0.0");
    assert.strictEqual(report.outcome, "applied");
    assert.strictEqual(report.push.pushed, true);
    assert.strictEqual(report.error, null);
    assert.deepStrictEqual(report.closedBlocks, [{ issue: 1164, refusal: null }]);
    assert.match(applied.output, /- ✅ closed block #1164/);
  });
});

it("fails the applied run and records the refusal when the block close is refused", () => {
  withFixture(appliedFixture, (f) => {
    const { runner } = exec({
      gh: openBlocksPerPhrase,
      ghb: (args) =>
        args[1] === "close"
          ? refused("Issue RSI-Software/t3code-hyprws#1164 was not closed: no assignee.")
          : ok(),
    });
    const applied = capture(() => run(["v1.0.0"], { runner, root: f.root }));
    assert.strictEqual(applied.value, 1);
    const report = readReport(f.root, "v1.0.0");
    // the push landed; the run still fails so a person sees the refusal
    assert.strictEqual(report.outcome, "applied");
    assert.strictEqual(report.push.pushed, true);
    assert.deepStrictEqual(report.closedBlocks, [
      {
        issue: 1164,
        refusal:
          "ghb issue close 1164 --reason completed --repo RSI-Software/t3code-hyprws failed: Issue RSI-Software/t3code-hyprws#1164 was not closed: no assignee.",
      },
    ]);
    assert.match(report.error ?? "", /closing stale block issues failed/);
    assert.match(report.error ?? "", /no assignee/);
    assert.match(applied.output, /- ❌ block #1164 close refused: .*no assignee/);
    assert.match(applied.output, /Error: closing stale block issues failed/);
  });
});

it("an already-applied run also closes its open block issues unaided", () => {
  withFixture(alreadyAppliedFixture, (f) => {
    const { runner } = exec({
      gh: openBlocksPerPhrase,
      ghb: (args) => {
        if (args[1] === "comment")
          assert.match(
            NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"),
            new RegExp(`Resolved by hyprws ${f.git(["rev-parse", "origin/hyprws"], f.root)}\\.`),
          );
        return ok();
      },
    });
    const applied = capture(() => run(["v1.0.0"], { runner, root: f.root }));
    assert.strictEqual(applied.value, 0);
    const report = readReport(f.root, "v1.0.0");
    assert.strictEqual(report.outcome, "already-applied");
    assert.strictEqual(report.push.pushed, false);
    assert.strictEqual(report.error, null);
    assert.deepStrictEqual(report.closedBlocks, [{ issue: 1164, refusal: null }]);
    assert.match(applied.output, /- ✅ closed block #1164/);
  });
});

it("an already-applied run fails and records the refusal when the block close is refused", () => {
  withFixture(alreadyAppliedFixture, (f) => {
    const { runner } = exec({
      gh: openBlocksPerPhrase,
      ghb: (args) =>
        args[1] === "close"
          ? refused("Issue RSI-Software/t3code-hyprws#1164 was not closed: no assignee.")
          : ok(),
    });
    const applied = capture(() => run(["v1.0.0"], { runner, root: f.root }));
    assert.strictEqual(applied.value, 1);
    const report = readReport(f.root, "v1.0.0");
    assert.strictEqual(report.outcome, "already-applied");
    assert.deepStrictEqual(report.closedBlocks, [
      {
        issue: 1164,
        refusal:
          "ghb issue close 1164 --reason completed --repo RSI-Software/t3code-hyprws failed: Issue RSI-Software/t3code-hyprws#1164 was not closed: no assignee.",
      },
    ]);
    assert.match(report.error ?? "", /closing stale block issues failed/);
    assert.match(applied.output, /- ❌ block #1164 close refused/);
  });
});
