// @effect-diagnostics nodeBuiltinImport:off - The sync driver is Git plumbing; fixtures need real repositories.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  blockedIssueBody,
  blockingShaMarker,
  closeBlocks,
  publishBlock,
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
      const { runner } = exec();
      const code = capture(() => run(["v9.9.9"], { runner, root: f.root })).value;
      assert.strictEqual(code, 1);
      const report = JSON.parse(
        NodeFS.readFileSync(reportPath(f.root, "v9.9.9"), "utf8"),
      ) as ForkSyncReport;
      assert.strictEqual(report.outcome, "failed");
      assert.match(report.error ?? "", /not a release tag/);
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
  push: { pushed: false, detail: "" },
  error: "blocked",
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

it("closes every open block issue after a clean run", () => {
  const closed: Array<{ readonly number: number; readonly comment: string }> = [];
  const runner: CommandRunner = {
    run: (command, args) => {
      if (command === "gh" && args[0] === "issue" && args[1] === "list")
        return ok(
          JSON.stringify([
            { number: 7, title: "a", body: "x" },
            { number: 9, title: "b", body: "y" },
          ]),
        );
      if (command === "ghb" && args[0] === "issue" && args[1] === "close")
        closed.push({
          number: Number(args[2]),
          comment: args[args.indexOf("--comment") + 1] ?? "",
        });
      return ok();
    },
  };
  closeBlocks(runner, "/tmp", "abc1234def");
  assert.deepStrictEqual(
    closed.map(({ number, comment }) => ({ number, comment })),
    [
      { number: 7, comment: "Resolved by hyprws abc1234def." },
      { number: 9, comment: "Resolved by hyprws abc1234def." },
    ],
  );
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
