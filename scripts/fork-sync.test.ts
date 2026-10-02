// @effect-diagnostics nodeBuiltinImport:off - The sync driver is Git plumbing; fixtures need real repositories.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  blockedIssueBody,
  checkCommands,
  blockingShaMarker,
  checkFailureDetail,
  closeBlocks,
  dependencySetChanged,
  failureIssueBody,
  failureMarker,
  fixupRefusals,
  publishBlock,
  publishFailure,
  realRunner,
  rebaseOnto,
  readReport,
  REGENERATION_ROUTES,
  resolverText,
  renderReport,
  reportPath,
  run,
  runChecks,
  type CommandRunner,
  type ForkSyncReport,
  type ReleaseTag,
} from "./fork-sync.ts";
import { deriveCiTestJobs, workflowJobIds } from "./lib/fork-ci-jobs.ts";
import { FORK_CI_WORKFLOW_PATH } from "./lib/fork-ci-flags.ts";
import { runCommand, type CommandResult } from "./lib/fork-command.ts";
import { GENERATED_HOOK_PATH } from "./lib/fork-hook-guard.ts";

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
const refused = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr });

// ---------------------------------------------------------------------------
// Fixture: one upstream remote, one origin remote, a fork trunk
// ---------------------------------------------------------------------------

/** A hyprws CI workflow in miniature: a Check job, a pooled job, and a matrix job. */
const FIXTURE_WORKFLOW = `name: hyprws CI
jobs:
  check:
    name: Check
    steps:
      - run: vp check
  test:
    name: Test
    steps:
      - name: Install libraries
        run: sudo apt-get update && sudo apt-get install -y libsecret-1-dev
      - run: vp run --filter '!t3' test --testTimeout=60000
  test_server:
    name: Test Server \${{ matrix.shard }}
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2]
    steps:
      - run: vp run --filter t3 test --shard \${{ matrix.shard }}/\${{ strategy.job-total }}
`;

const FIXTURE_TEST_JOBS = deriveCiTestJobs(FIXTURE_WORKFLOW);

/** Every row a full battery reports: the Check-job commands, then each test job. */
const BATTERY_ROWS = checkCommands().length + FIXTURE_TEST_JOBS.length;

const writeWorkflow = (root: string, source = FIXTURE_WORKFLOW): void => {
  const path = NodePath.join(root, FORK_CI_WORKFLOW_PATH);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, source);
};

interface Fixture {
  readonly root: string;
  readonly worktree: string;
  readonly git: (args: ReadonlyArray<string>, cwd?: string) => string;
}

const fixture = (options: {
  readonly forkContent: string;
  readonly upstreamContent: string;
  /** Base file both sides start from; defaults to the legacy line fixture. */
  readonly baseContent?: string;
  /** Further files the base commit carries, by repo-relative path. */
  readonly baseFiles?: Readonly<Record<string, string>>;
  /** The fork branches from the tagged upstream commit instead of its base. */
  readonly forkOnTag?: boolean;
  readonly nightlyTag?: boolean;
  /** The base commit's t3.json worktree setup command; a no-op by default, as every fork checkout declares one. */
  readonly setup?: string;
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
  NodeFS.writeFileSync(
    NodePath.join(repo, "shared.txt"),
    options.baseContent ?? "line1\nline2\nline3\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(repo, "t3.json"),
    JSON.stringify({
      scripts: [
        { name: "Setup Worktree", command: options.setup ?? "true", runOnWorktreeCreate: true },
      ],
    }),
  );
  writeWorkflow(repo);
  for (const [path, content] of Object.entries(options.baseFiles ?? {}))
    NodeFS.writeFileSync(NodePath.join(repo, path), content);
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
// Runner stub: git is real, vp/gh are recorded
// ---------------------------------------------------------------------------

interface Recording {
  readonly runner: CommandRunner;
  readonly calls: ReadonlyArray<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
}

const exec = (
  handlers: {
    readonly vp?: (args: ReadonlyArray<string>) => CommandResult;
    readonly gh?: (args: ReadonlyArray<string>) => CommandResult;
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
      assert.strictEqual(row.via, "manual");
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

      // rerun: adopts the finished worktree; the dry run reaches applied
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
      // the hand-finished stop still reports its row
      assert.deepEqual(report.conflicts, blocked.conflicts);
      assert.strictEqual(report.checks.length, BATTERY_ROWS);
      for (const check of report.checks) assert.strictEqual(check.status, "passed");
    },
  );
});

it("runs the repo's worktree setup once, so the first stop already has its dependencies", () => {
  withFixture(
    {
      forkContent: "line1\nline2 fork\nline3\n",
      upstreamContent: "line1\nline2 upstream\nline3\n",
      setup: "mkdir -p node_modules/.bin && touch node_modules/.bin/tsc",
    },
    (f) => {
      const shas = forkShas(f);
      const first = exec();
      capture(() => run(["v1.0.0"], { runner: first.runner, root: f.root }));
      assert.strictEqual(readReport(f.root, "v1.0.0").outcome, "blocked");
      assert.strictEqual(first.calls.filter(({ command }) => command === "sh").length, 1);
      assert.strictEqual(
        NodeFS.existsSync(NodePath.join(f.worktree, "node_modules/.bin/tsc")),
        true,
      );
      const state = JSON.parse(
        NodeFS.readFileSync(NodePath.join(NodePath.dirname(f.worktree), "worktree.json"), "utf8"),
      );
      assert.strictEqual(state.installed, shas.fork);

      NodeFS.writeFileSync(
        NodePath.join(f.worktree, "shared.txt"),
        "line1\nline2 resolved\nline3\n",
      );
      f.git(["add", "shared.txt"], f.worktree);
      f.git(["-c", "core.editor=true", "rebase", "--continue"], f.worktree);

      // the adopted rerun neither repeats the setup nor installs a second time
      const second = exec();
      const applied = capture(() =>
        run(["v1.0.0", "--dry-run"], { runner: second.runner, root: f.root }),
      );
      assert.strictEqual(applied.value, 0);
      assert.strictEqual(
        second.calls.some(
          ({ command, args }) => command === "sh" || (command === "vp" && args[0] === "i"),
        ),
        false,
      );
    },
  );
});

it("writes no rerere field and still reads a report that carries one", () => {
  withFixture(
    {
      forkContent: "line1\nline2 fork\nline3\n",
      upstreamContent: "line1\nline2 upstream\nline3\n",
    },
    (f) => {
      capture(() => run(["v1.0.0"], { runner: exec().runner, root: f.root }));
      const path = reportPath(f.root, "v1.0.0");
      const written = JSON.parse(NodeFS.readFileSync(path, "utf8"));
      assert.notProperty(written, "rerere");
      NodeFS.writeFileSync(
        path,
        JSON.stringify({ ...written, rerere: { restored: false, saved: false, published: false } }),
      );
      assert.strictEqual(readReport(f.root, "v1.0.0").outcome, "blocked");
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
      assert.strictEqual(report.error, "the check battery is red: vp run fork:ci");
      assert.strictEqual(report.trunk.after, null);
      assert.match(printed.output, /Trunk: [0-9a-f]{7} → unchanged/);
      assert.strictEqual(report.push.pushed, false);
      // the red tip survives in the kept worktree the report names
      assert.strictEqual(report.decision.worktree, f.worktree);
      const tip = report.decision.tip;
      assert.notStrictEqual(tip, undefined);
      assert.strictEqual(f.git(["rev-parse", "HEAD"], f.worktree), tip);
      assert.match(printed.output, new RegExp(`Tip: \`${tip}\``));
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

const redThenGreen = (): { readonly red: Recording; readonly green: Recording } => ({
  red: exec({ vp: (args) => (args[1] === "fork:ci" ? refused("red\n") : ok()) }),
  green: exec(),
});

it("carries a reshape extra committed in the kept worktree into the pushed tip", () => {
  withFixture(
    {
      forkContent: "fork line1\nline2\nline3\n",
      upstreamContent: "line1\nline2\nline3 upstream\n",
    },
    (f) => {
      const { red, green } = redThenGreen();
      capture(() => run(["v1.0.0"], { runner: red.runner, root: f.root }));
      NodeFS.writeFileSync(NodePath.join(f.worktree, "extra.txt"), "reshape\n");
      f.git(["add", "extra.txt"], f.worktree);
      f.git(["commit", "--quiet", "-m", "reshape extra"], f.worktree);
      const tip = f.git(["rev-parse", "HEAD"], f.worktree);
      const code = capture(() => run(["v1.0.0"], { runner: green.runner, root: f.root })).value;
      assert.strictEqual(code, 0);
      const report = readReport(f.root, "v1.0.0");
      assert.strictEqual(report.trunk.after, tip);
      assert.strictEqual(f.git(["rev-parse", "origin/hyprws"], f.root), tip);
      // adoption never replays the rebase
      assert.strictEqual(
        green.calls.some(({ command, args }) => command === "git" && args.includes("rebase")),
        false,
      );
      assert.strictEqual(NodeFS.existsSync(f.worktree), false);
    },
  );
});

it("recreates the kept worktree when the lease moves or the tag changes", () => {
  withFixture(
    {
      forkContent: "fork line1\nline2\nline3\n",
      upstreamContent: "line1\nline2\nline3 upstream\n",
      nightlyTag: true,
    },
    (f) => {
      const { red } = redThenGreen();
      const extra = (): void => {
        NodeFS.writeFileSync(NodePath.join(f.worktree, "extra.txt"), "stale\n");
        f.git(["add", "extra.txt"], f.worktree);
        f.git(["commit", "--quiet", "-m", "stale extra"], f.worktree);
      };
      const hasExtra = (): boolean => NodeFS.existsSync(NodePath.join(f.worktree, "extra.txt"));

      // new tag: the v1.0.0 carrier is not adopted for the nightly
      capture(() => run(["v1.0.0"], { runner: red.runner, root: f.root }));
      extra();
      capture(() => run(["v1.0.1-nightly.20260901.1"], { runner: red.runner, root: f.root }));
      assert.strictEqual(hasExtra(), false);

      // moved lease: a new trunk commit on origin discards the carrier
      extra();
      NodeFS.writeFileSync(NodePath.join(f.root, "trunk.txt"), "moved\n");
      f.git(["add", "trunk.txt"], f.root);
      f.git(["commit", "--quiet", "-m", "trunk moves"], f.root);
      f.git(["push", "--quiet", "origin", "hyprws"], f.root);
      capture(() => run(["v1.0.1-nightly.20260901.1"], { runner: red.runner, root: f.root }));
      assert.strictEqual(hasExtra(), false);
      assert.strictEqual(NodeFS.existsSync(NodePath.join(f.worktree, "trunk.txt")), true);
    },
  );
});

it("refuses to adopt a kept HEAD without the target and keeps the carrier", () => {
  withFixture(
    {
      forkContent: "fork line1\nline2\nline3\n",
      upstreamContent: "line1\nline2\nline3 upstream\n",
    },
    (f) => {
      const { red } = redThenGreen();
      capture(() => run(["v1.0.0", "--dry-run"], { runner: red.runner, root: f.root }));
      f.git(["reset", "--quiet", "--hard", "origin/hyprws"], f.worktree);
      const rerun = exec();
      const code = capture(() =>
        run(["v1.0.0", "--dry-run"], { runner: rerun.runner, root: f.root }),
      ).value;
      assert.strictEqual(code, 1);
      assert.match(readReport(f.root, "v1.0.0").error ?? "", /does not contain v1\.0\.0/);
      assert.strictEqual(NodeFS.existsSync(f.worktree), true);
      assert.strictEqual(
        NodeFS.existsSync(NodePath.join(f.root, ".t3", "fork-sync", "worktree.json")),
        true,
      );
    },
  );
});

it("blocks again on a rerun while the kept rebase still has unresolved paths", () => {
  withFixture(
    {
      forkContent: "line1\nline2 fork\nline3\n",
      upstreamContent: "line1\nline2 upstream\nline3\n",
    },
    (f) => {
      const first = exec();
      capture(() => run(["v1.0.0"], { runner: first.runner, root: f.root }));
      const second = exec();
      const code = capture(() => run(["v1.0.0"], { runner: second.runner, root: f.root })).value;
      assert.strictEqual(code, 1);
      const report = readReport(f.root, "v1.0.0");
      assert.strictEqual(report.outcome, "blocked");
      assert.deepEqual(report.decision.paths, ["shared.txt"]);
      // the stop is re-read, never rebuilt
      assert.strictEqual(
        second.calls.some(({ command, args }) => command === "git" && args[0] === "worktree"),
        false,
      );
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
      assert.strictEqual(report.checks.length, BATTERY_ROWS);
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
      baseContent: 'import { a } from "a";\n',
      forkContent:
        'import { a } from "a";\nimport { forkThing } from "fork"; // fork-hook: fork-meta/test\n',
      upstreamContent: 'import { a } from "a";\nimport { b } from "b";\n',
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

it("refuses a marked hook beside an unmarked edit and files one keyed block", () => {
  withFixture(
    {
      baseContent: 'import { a } from "a";\n',
      forkContent:
        'import { changed } from "fork";\nimport { a } from "a";\nimport { forkThing } from "fork"; // fork-hook: fork-meta/test\n',
      upstreamContent: 'import { a } from "upstream";\nimport { b } from "b";\n',
    },
    (f) => {
      const { runner } = exec();
      const first = capture(() => run(["v1.0.0"], { runner, root: f.root }));
      assert.strictEqual(first.value, 1);
      const report = readReport(f.root, "v1.0.0");
      assert.strictEqual(report.outcome, "blocked");
      assert.strictEqual(report.conflicts.length, 1);
      const row = report.conflicts[0]!;
      assert.strictEqual(row.path, "shared.txt");
      assert.strictEqual(row.via, "manual");
      assert.deepStrictEqual(row.hooksReapplied, []);
      assert.match(
        row.refuseReason ?? "",
        /not a fully marked insertion: the base stage differs outside the marked region/,
      );
      assert.deepStrictEqual(report.decision.paths, ["shared.txt"]);
      const body = blockedIssueBody(report);
      assert.match(body, /shared\.txt/);
      assert.match(body, /not a fully marked insertion/);
      const worktreeContent = NodeFS.readFileSync(NodePath.join(f.worktree, "shared.txt"), "utf8");
      // The stop is the proof of never re-applying: the walk writes nothing
      // and leaves git's conflict markers for a manual resolution.
      assert.match(worktreeContent, /<{7} /);
      assert.match(worktreeContent, /={7}\n/);
      assert.deepStrictEqual(report.decision.paths, ["shared.txt"]);
    },
  );
});

it("accepts an upstream delete whose fork edit is net-zero and continues the rebase", () => {
  withFixture(
    {
      forkContent: "line1\nline2 fork\nline3\n",
      upstreamContent: "line1\nline2 upstream\nline3\n",
    },
    (f) => {
      // The fork modifies the file, then restores the base content: net-zero.
      NodeFS.writeFileSync(NodePath.join(f.root, "shared.txt"), "line1\nline2\nline3\n");
      f.git(["commit", "--quiet", "-am", "fork restores"], f.root);
      f.git(["push", "--quiet", "origin", "hyprws"], f.root);
      // Upstream deletes the file in the new release tag.
      f.git(["checkout", "--quiet", "main"], f.root);
      f.git(["rm", "--quiet", "shared.txt"], f.root);
      f.git(["commit", "--quiet", "-m", "upstream deletes shared"], f.root);
      f.git(["tag", "v2.0.0"], f.root);
      f.git(["push", "--quiet", "upstream", "main", "v2.0.0"], f.root);
      f.git(["checkout", "--quiet", "hyprws"], f.root);

      const { runner, calls } = exec();
      const applied = capture(() => run(["v2.0.0", "--dry-run"], { runner, root: f.root }));
      assert.strictEqual(applied.value, 0);
      const report = readReport(f.root, "v2.0.0");
      assert.strictEqual(report.outcome, "applied");
      assert.notStrictEqual(report.trunk.after, null);
      assert.strictEqual(report.conflicts.length, 2);
      // Auto maintenance detached by a sequencer commit would race the next
      // pick for MERGE_RR.lock (RSI-Software/t3code-hyprws#1459).
      const rebases = calls.filter(
        ({ command, args }) => command === "git" && args.includes("rebase"),
      );
      assert.isTrue(rebases.some(({ args }) => args.includes("--continue")));
      for (const { args } of rebases) assert.include(args, "maintenance.auto=false");
      for (const row of report.conflicts) {
        assert.strictEqual(row.path, "shared.txt");
        assert.strictEqual(row.via, "net-zero-delete");
        assert.strictEqual(row.reason, "upstream deleted; fork edit is net-zero");
        assert.deepStrictEqual(row.hooksReapplied, []);
      }
      // The rebased trunk agrees with upstream: the file stays deleted.
      assert.strictEqual(
        f.git(["ls-tree", "--name-only", report.trunk.after!, "--", "shared.txt"], f.root),
        "",
      );
      assert.strictEqual(report.checks.length, BATTERY_ROWS);
      for (const check of report.checks) assert.strictEqual(check.status, "passed");
    },
  );
});

it("still blocks a delete/modify whose fork edit is not net-zero", () => {
  withFixture(
    {
      forkContent: "line1\nline2 fork\nline3\n",
      upstreamContent: "line1\nline2 upstream\nline3\n",
    },
    (f) => {
      f.git(["checkout", "--quiet", "main"], f.root);
      f.git(["rm", "--quiet", "shared.txt"], f.root);
      f.git(["commit", "--quiet", "-m", "upstream deletes shared"], f.root);
      f.git(["tag", "v2.0.0"], f.root);
      f.git(["push", "--quiet", "upstream", "main", "v2.0.0"], f.root);
      f.git(["checkout", "--quiet", "hyprws"], f.root);

      const { runner } = exec();
      const blockedRun = capture(() => run(["v2.0.0"], { runner, root: f.root }));
      assert.strictEqual(blockedRun.value, 1);
      const report = readReport(f.root, "v2.0.0");
      assert.strictEqual(report.outcome, "blocked");
      assert.strictEqual(report.conflicts.length, 1);
      const row = report.conflicts[0]!;
      assert.strictEqual(row.path, "shared.txt");
      assert.strictEqual(row.via, "manual");
      assert.deepStrictEqual(report.decision.paths, ["shared.txt"]);
      // The modified text still stands in the worktree, awaiting a manual resolution.
      assert.strictEqual(NodeFS.existsSync(NodePath.join(f.worktree, "shared.txt")), true);
    },
  );
});

it("still blocks when the fork side deleted the path and upstream modified it", () => {
  withFixture(
    {
      forkContent: "line1\nline2 fork\nline3\n",
      upstreamContent: "line1\nline2 upstream\nline3\n",
    },
    (f) => {
      // The fork trunk's one commit deletes the file outright.
      f.git(["rm", "--quiet", "shared.txt"], f.root);
      f.git(["commit", "--quiet", "--amend", "-m", "fork deletes"], f.root);
      f.git(["push", "--quiet", "--force", "origin", "hyprws"], f.root);

      const { runner } = exec();
      const blockedRun = capture(() => run(["v1.0.0"], { runner, root: f.root }));
      assert.strictEqual(blockedRun.value, 1);
      const report = readReport(f.root, "v1.0.0");
      assert.strictEqual(report.outcome, "blocked");
      assert.strictEqual(report.conflicts.length, 1);
      const row = report.conflicts[0]!;
      assert.strictEqual(row.path, "shared.txt");
      assert.strictEqual(row.via, "manual");
      // Upstream's text stands; nothing was removed on the fork's behalf.
      assert.strictEqual(NodeFS.existsSync(NodePath.join(f.worktree, "shared.txt")), true);
    },
  );
});

// ---------------------------------------------------------------------------
// Regenerable files
// ---------------------------------------------------------------------------

const LOCKFILE = "pnpm-lock.yaml";

const lockfileFixture = (shared: { readonly fork: string; readonly upstream: string }) =>
  ({
    forkContent: shared.fork,
    upstreamContent: shared.upstream,
    baseFiles: { [LOCKFILE]: "lock: base\n" },
  }) as const;

/** The fork's newest commit and a new upstream tag `v2.0.0` each rewrite `path`. */
const changeBothSides = (
  f: Fixture,
  path: string,
  sides: { readonly fork: string; readonly upstream: string },
): void => {
  NodeFS.writeFileSync(NodePath.join(f.root, path), sides.fork);
  f.git(["commit", "--quiet", "--amend", "--no-edit", "-a"], f.root);
  f.git(["push", "--quiet", "--force", "origin", "hyprws"], f.root);
  f.git(["checkout", "--quiet", "main"], f.root);
  NodeFS.writeFileSync(NodePath.join(f.root, path), sides.upstream);
  f.git(["commit", "--quiet", "-am", `upstream rewrites ${path}`], f.root);
  f.git(["tag", "v2.0.0"], f.root);
  f.git(["push", "--quiet", "upstream", "main", "v2.0.0"], f.root);
  f.git(["checkout", "--quiet", "hyprws"], f.root);
};

const relockBothSides = (f: Fixture): void =>
  changeBothSides(f, LOCKFILE, { fork: "lock: fork\n", upstream: "lock: upstream\n" });

/** A lockfile generator stub that records the text it regenerated from. */
const lockfileGenerator = (f: Fixture, seen: string[]) => (args: ReadonlyArray<string>) => {
  if (args[0] !== "install" || args[1] !== "--lockfile-only") return ok();
  const path = NodePath.join(f.worktree, LOCKFILE);
  seen.push(NodeFS.readFileSync(path, "utf8"));
  NodeFS.writeFileSync(path, "lock: regenerated\n");
  return ok();
};

it("regenerates a conflicted lockfile from HEAD and continues the rebase", () => {
  withFixture(
    lockfileFixture({ fork: "fork line1\nline2\nline3\n", upstream: "line1\nline2\nline3 up\n" }),
    (f) => {
      relockBothSides(f);
      const seen: string[] = [];
      const { runner } = exec({ vp: lockfileGenerator(f, seen) });
      const code = capture(() => run(["v2.0.0", "--dry-run"], { runner, root: f.root })).value;
      assert.strictEqual(code, 0);
      const report = readReport(f.root, "v2.0.0");
      assert.strictEqual(report.outcome, "applied");
      assert.deepStrictEqual(
        report.conflicts.map(({ path, via, reason }) => ({ path, via, reason })),
        [
          {
            path: LOCKFILE,
            via: "regenerate",
            reason: "regenerated by vp install --lockfile-only",
          },
        ],
      );
      // The generator ran over upstream's lockfile, never a merged one.
      assert.deepStrictEqual(seen, ["lock: upstream\n"]);
      assert.strictEqual(
        f.git(["show", `${report.trunk.after}:${LOCKFILE}`], f.root),
        "lock: regenerated",
      );
    },
  );
});

it("holds a generated path until the stop's manual paths resolve, then regenerates it", () => {
  withFixture(
    lockfileFixture({ fork: "line1\nline2 fork\nline3\n", upstream: "line1\nline2 up\nline3\n" }),
    (f) => {
      relockBothSides(f);
      const seen: string[] = [];
      const first = exec({ vp: lockfileGenerator(f, seen) });
      assert.strictEqual(
        capture(() => run(["v2.0.0", "--dry-run"], { runner: first.runner, root: f.root })).value,
        1,
      );
      const blocked = readReport(f.root, "v2.0.0");
      assert.deepStrictEqual(blocked.decision.paths, ["shared.txt"]);
      assert.notMatch(blocked.decision.resume, /rebase --continue/);
      assert.match(blocked.decision.resume, /the rerun regenerates pnpm-lock\.yaml/);
      assert.deepStrictEqual(seen, []);

      NodeFS.writeFileSync(NodePath.join(f.worktree, "shared.txt"), "line1\nline2 both\nline3\n");
      f.git(["add", "shared.txt"], f.worktree);
      const second = exec({ vp: lockfileGenerator(f, seen) });
      assert.strictEqual(
        capture(() => run(["v2.0.0", "--dry-run"], { runner: second.runner, root: f.root })).value,
        0,
      );
      const applied = readReport(f.root, "v2.0.0");
      assert.deepStrictEqual(
        applied.conflicts.map(({ path, via }) => ({ path, via })),
        [
          { path: "shared.txt", via: "manual" },
          { path: LOCKFILE, via: "regenerate" },
        ],
      );
      assert.strictEqual(
        f.git(["show", `${applied.trunk.after}:${LOCKFILE}`], f.root),
        "lock: regenerated",
      );
    },
  );
});

it("blocks on a generated path whose generator fails, naming the failure", () => {
  withFixture(
    lockfileFixture({ fork: "fork line1\nline2\nline3\n", upstream: "line1\nline2\nline3 up\n" }),
    (f) => {
      relockBothSides(f);
      const { runner } = exec({
        vp: (args) =>
          args[1] === "--lockfile-only" ? refused("ERR_PNPM_NO_MATCHING_VERSION") : ok(),
      });
      assert.strictEqual(
        capture(() => run(["v2.0.0", "--dry-run"], { runner, root: f.root })).value,
        1,
      );
      const report = readReport(f.root, "v2.0.0");
      assert.deepStrictEqual(report.decision.paths, [LOCKFILE]);
      const row = report.conflicts[0]!;
      assert.strictEqual(row.via, "manual");
      assert.match(row.refuseReason ?? "", /^vp install --lockfile-only failed: ERR_PNPM/);
    },
  );
});

const LICENSES = "third-party-licenses.config.json";

const licenseList = (...names: ReadonlyArray<string>): string =>
  `${JSON.stringify({ customNotices: names.map((name) => ({ name, license: "MIT" })) }, null, 2)}\n`;

it("merges both sides' license list appends by package name and continues the rebase", () => {
  withFixture(
    {
      forkContent: "fork line1\nline2\nline3\n",
      upstreamContent: "line1\nline2\nline3 up\n",
      baseFiles: { [LICENSES]: licenseList("base") },
    },
    (f) => {
      changeBothSides(f, LICENSES, {
        fork: licenseList("base", "fork-added"),
        upstream: licenseList("base", "upstream-added"),
      });
      const formatted: string[] = [];
      const { runner } = exec({
        vp: (args) => {
          if (args[0] === "fmt") formatted.push(args[1] ?? "");
          return ok();
        },
      });
      assert.strictEqual(
        capture(() => run(["v2.0.0", "--dry-run"], { runner, root: f.root })).value,
        0,
      );
      const report = readReport(f.root, "v2.0.0");
      assert.deepStrictEqual(
        report.conflicts.map(({ path, via, reason }) => ({ path, via, reason })),
        [{ path: LICENSES, via: "regenerate", reason: "merged by package name" }],
      );
      assert.deepStrictEqual(formatted, [LICENSES]);
      assert.strictEqual(
        f.git(["show", `${report.trunk.after}:${LICENSES}`], f.root) + "\n",
        licenseList("base", "upstream-added", "fork-added"),
      );
    },
  );
});

it("routes every generated path the fork carries", () => {
  const root = NodePath.join(import.meta.dirname, "..");
  const git = (args: ReadonlyArray<string>): string => {
    const result = runCommand("git", args, { cwd: root });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  const base = git(["merge-base", "HEAD", "upstream/main"]);
  const routed = new Set(REGENERATION_ROUTES.map(({ path }) => path));
  const unrouted = git(["diff", "--name-only", "--no-renames", base, "HEAD"])
    .split("\n")
    .filter((path) => GENERATED_HOOK_PATH.test(path) && !routed.has(path));
  assert.deepStrictEqual(unrouted, []);
});

it("lists every regeneration route in the runbook, in run order", () => {
  const runbook = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "../docs/fork/operations/fork-sync.md"),
    "utf8",
  );
  const section = runbook.split("## Regenerable files")[1]?.split("\n## ")[0] ?? "";
  const rows = [...section.matchAll(/^\| `([^`]+)` +\| (`[^`]+`|[^|`]+?) +\|/gm)].map(
    ([, path, resolver]) => ({ path, resolver: resolver?.replaceAll("`", "") }),
  );
  assert.deepStrictEqual(
    rows,
    REGENERATION_ROUTES.map((route) => ({ path: route.path, resolver: resolverText(route) })),
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
        gh: (args) => {
          if (args[0] === "issue" && args[1] === "create") {
            created.push({
              title: args[args.indexOf("--title") + 1] ?? "",
              body: NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"),
            });
            return ok("https://github.com/RSI-Software/t3code-hyprws/issues/45\n");
          }
          return ok("[]");
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
// Blocked publication through gh
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
  conflicts: [
    {
      path: "apps/web/src/page.tsx",
      forkCommit: "4".repeat(40),
      forkSubject: "feat: fork seam",
      upstreamCommit: blockingSha,
      upstreamSubject: "feat: upstream rewrite",
      via: "manual",
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
    gh: (args) => {
      if (args[0] === "issue" && args[1] === "create") {
        issueBodies.push(NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"));
        return ok("https://github.com/RSI-Software/t3code-hyprws/issues/42\n");
      }
      return ok("[]");
    },
  });
  const report = publishBlock(recording.runner, "/tmp", blockedReport("5".repeat(40)));
  assert.strictEqual(report.blocked?.issue, 42);
  assert.strictEqual(report.blocked?.publishedVia, "gh");
  const create = recording.calls.find(
    ({ command, args }) => command === "gh" && args[0] === "issue" && args[1] === "create",
  );
  assert.notStrictEqual(create, undefined);
  const args = create!.args;
  const value = (name: string): string | undefined => args[args.indexOf(name) + 1];
  assert.strictEqual(value("--title"), "hyprws sync blocked at v1.0.0 (upstream 5555555)");
  assert.strictEqual(value("--type"), "Notification 🔔");
  assert.deepStrictEqual(
    args.filter((argument, index) => args[index - 1] === "--label"),
    ["ci"],
  );
  const list = recording.calls.find(
    ({ command, args }) => command === "gh" && args[0] === "issue" && args[1] === "list",
  );
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

it("edits the open issue in place when the rendered body drifts, never comments", () => {
  const edits: Array<{ readonly args: ReadonlyArray<string>; readonly body: string }> = [];
  const recording = exec({
    gh: (args) => {
      if (args[0] === "issue" && args[1] === "edit") {
        edits.push({
          args,
          body: NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"),
        });
        return ok();
      }
      return ok(
        JSON.stringify([
          { number: 11, title: "old", body: `stale\n${blockingShaMarker("5".repeat(40))}` },
        ]),
      );
    },
  });
  const report = publishBlock(recording.runner, "/tmp", blockedReport("5".repeat(40)));
  assert.strictEqual(report.blocked?.issue, 11);
  // exactly one in-place edit, no fresh filing, and the report body never posts
  // as a comment
  assert.strictEqual(edits.length, 1);
  const args = edits[0]!.args;
  assert.deepStrictEqual(args.slice(0, 2), ["issue", "edit"]);
  assert.strictEqual(args[2], "11");
  const value = (name: string): string | undefined => args[args.indexOf(name) + 1];
  assert.strictEqual(value("--title"), "hyprws sync blocked at v1.0.0 (upstream 5555555)");
  assert.include(edits[0]!.body, blockingShaMarker("5".repeat(40)));
  assert.strictEqual(
    recording.calls.some(({ args }) => args[0] === "issue" && args[1] === "comment"),
    false,
  );
  assert.strictEqual(
    recording.calls.some(({ args }) => args[0] === "issue" && args[1] === "create"),
    false,
  );
});

it("rewrites the one standing issue for a new target and supersedes older open ones", () => {
  const first = failedReport("check", "v1.0.0");
  const next = { ...failedReport("check", "v1.1.0"), startedAt: "2026-09-22T10:00:00.000Z" };
  const edits: Array<{ readonly args: ReadonlyArray<string>; readonly body: string }> = [];
  const recording = exec({
    gh: (args) => {
      if (args[0] === "issue" && args[1] === "edit") {
        edits.push({
          args,
          body: NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"),
        });
        return ok();
      }
      if (args[0] === "issue" && args[1] === "list")
        return ok(
          JSON.stringify([
            { number: 7, title: "legacy", body: "older failure" },
            { number: 12, title: first.failure!.title, body: failureIssueBody(first) },
          ]),
        );
      return ok();
    },
  });
  const published = publishFailure(recording.runner, "/tmp", next);
  assert.strictEqual(published.failure?.issue, 12);
  assert.strictEqual(edits.length, 1);
  const args = edits[0]!.args;
  assert.strictEqual(args[2], "12");
  assert.strictEqual(args[args.indexOf("--title") + 1], "hyprws sync failed at check (v1.1.0)");
  const body = edits[0]!.body;
  assert.include(body, "Open since 2026-09-21 across 2 targets;");
  assert.include(body, "- 2026-09-22 · `v1.1.0` · check\n- 2026-09-21 · `v1.0.0` · check");
  // the older open issue of the same kind closes as superseded; nothing new files
  const close = recording.calls.find(({ args }) => args[0] === "issue" && args[1] === "close");
  assert.strictEqual(close?.args[2], "7");
  assert.include(close?.args ?? [], "Superseded by #12.");
  assert.strictEqual(
    recording.calls.some(({ args }) => args[0] === "issue" && args[1] === "create"),
    false,
  );
});

it("makes no write when the live title and body already match the render", () => {
  const report = blockedReport("5".repeat(40));
  const recording = exec({
    gh: () =>
      ok(
        JSON.stringify([
          {
            number: 11,
            title: report.blocked!.title,
            body: blockedIssueBody(report),
          },
        ]),
      ),
  });
  const published = publishBlock(recording.runner, "/tmp", report);
  assert.strictEqual(published.blocked?.issue, 11);
  assert.strictEqual(published.blocked?.publishError, null);
  // the list is the only write: no create, no edit
  assert.strictEqual(
    recording.calls.some(({ args }) => args[0] === "issue" && args[1] !== "list"),
    false,
  );
});

it("makes no write when a stray gh-bot attest footer and machine title suffix decorate the render", () => {
  const report = blockedReport("5".repeat(40));
  const recording = exec({
    gh: () =>
      ok(
        JSON.stringify([
          {
            number: 11,
            title: `${report.blocked!.title} [🔔#3]`,
            body: `${blockedIssueBody(report)}\n<!-- gh-bot:attest sha256:aaaa -->\n<!-- gh-bot:edit-attest sha256:bbbb -->\n`,
          },
        ]),
      ),
  });
  const published = publishBlock(recording.runner, "/tmp", report);
  assert.strictEqual(published.blocked?.issue, 11);
  // the stray decorations normalise away: no create, no edit
  assert.strictEqual(
    recording.calls.some(({ args }) => args[0] === "issue" && args[1] !== "list"),
    false,
  );
});

it("falls back to gh issue edit --type when gh rejects --type at create", () => {
  const recording = exec({
    gh: (args) => {
      if (args[0] === "issue" && args[1] === "create")
        return args.includes("--type")
          ? refused("unknown flag: --type")
          : ok("https://github.com/RSI-Software/t3code-hyprws/issues/44\n");
      if (args[0] === "issue" && args[1] === "list") return ok("[]");
      return ok();
    },
  });
  const report = publishBlock(recording.runner, "/tmp", blockedReport("5".repeat(40)));
  assert.strictEqual(report.blocked?.issue, 44);
  assert.strictEqual(report.blocked?.publishedVia, "gh");
  assert.strictEqual(report.blocked?.publishError, null);
  const creates = recording.calls.filter(
    ({ command, args }) => command === "gh" && args[0] === "issue" && args[1] === "create",
  );
  assert.strictEqual(creates.length, 2, "one refused attempt, one bare retry");
  assert.strictEqual(creates[0]!.args.includes("--type"), true);
  assert.strictEqual(creates[1]!.args.includes("--type"), false);
  // the fresh issue gets its Notification type by editing right after create
  const typeEdit = recording.calls.find(
    ({ command, args }) => command === "gh" && args[0] === "issue" && args[1] === "edit",
  );
  assert.notStrictEqual(typeEdit, undefined);
  assert.strictEqual(typeEdit!.args[2], "44");
  const typeIndex = typeEdit!.args.indexOf("--type");
  assert.strictEqual(typeEdit!.args[typeIndex + 1], "Notification 🔔");
  // still exactly one label on the landed create
  assert.deepStrictEqual(
    creates[1]!.args.filter((argument, index) => creates[1]!.args[index - 1] === "--label"),
    ["ci"],
  );
});

it("prints the body and records the refusal when gh refuses", () => {
  const recording = exec({
    gh: (args) =>
      args[0] === "issue" && args[1] === "create"
        ? refused("delegated agents cannot create issues")
        : ok("[]"),
  });
  const printed = capture(() =>
    publishBlock(recording.runner, "/tmp", blockedReport("5".repeat(40))),
  );
  assert.match(printed.value.blocked?.publishError ?? "", /cannot create issues/);
  assert.strictEqual(printed.value.blocked?.publishedVia, null);
  assert.match(printed.output, /\| Path \| Fork commit \| Upstream commit \|/);
  assert.include(printed.output, blockingShaMarker("5".repeat(40)));
});

it("closes every open block and failure issue with one close-and-comment call", () => {
  const bodies: string[] = [];
  // each governed search matches only its own phrase: block issues under the
  // blocked phrase, the failure issue under the sync-failure phrase
  const recording = exec({
    gh: (args) => {
      if (args[0] === "issue" && args[1] === "close") {
        bodies.push(args[args.indexOf("--comment") + 1] ?? "");
        return ok();
      }
      return ok(
        JSON.stringify(
          args[args.indexOf("--search") + 1] === '"hyprws sync failed" in:title'
            ? [{ number: 11, title: "f", body: "z" }]
            : [
                { number: 7, title: "a", body: "x" },
                { number: 9, title: "b", body: "y" },
              ],
        ),
      );
    },
  });
  const closures = closeBlocks(recording.runner, "/tmp", "abc1234def");
  assert.deepStrictEqual(closures, [
    { issue: 7, refusal: null },
    { issue: 9, refusal: null },
    { issue: 11, refusal: null },
  ]);
  // one gh issue close call per issue, no sleeps between
  const sequence = recording.calls
    .filter(({ command, args }) => command === "gh" && args[1] === "close")
    .map(({ args }) => String(args[2]));
  assert.deepStrictEqual(sequence, ["7", "9", "11"]);
  // the comment names the applied trunk sha and is the close evidence
  assert.deepStrictEqual(bodies, [
    "Resolved by hyprws abc1234def.",
    "Resolved by hyprws abc1234def.",
    "Resolved by hyprws abc1234def.",
  ]);
  const close = recording.calls.find(
    ({ command, args }) => command === "gh" && args[1] === "close",
  );
  assert.notStrictEqual(close, undefined);
  assert.ok(close!.args.includes("--reason"));
  assert.ok(close!.args.includes("--comment"));
});

it("records a refused close per issue and still closes the others", () => {
  const recording = exec({
    gh: (args) => {
      if (args[0] === "issue" && args[1] === "close")
        return args[2] === "7"
          ? refused("Issue RSI-Software/t3code-hyprws#7 was not closed: no assignee.")
          : ok();
      return ok(
        JSON.stringify(
          args[args.indexOf("--search") + 1] === '"hyprws sync failed" in:title'
            ? []
            : [
                { number: 7, title: "a", body: "x" },
                { number: 9, title: "b", body: "y" },
              ],
        ),
      );
    },
  });
  const closures = closeBlocks(recording.runner, "/tmp", "abc1234def");
  assert.deepStrictEqual(closures, [
    {
      issue: 7,
      refusal:
        'gh issue close 7 --reason completed --comment "Resolved by hyprws abc1234def." --repo RSI-Software/t3code-hyprws failed: Issue RSI-Software/t3code-hyprws#7 was not closed: no assignee.',
    },
    { issue: 9, refusal: null },
  ]);
  // the close still ran for the refused issue, alongside the untouched one
  const closeCalls = recording.calls.filter(
    ({ command, args }) => command === "gh" && args[1] === "close",
  );
  assert.deepStrictEqual(
    closeCalls.map(({ args }) => args[2]),
    ["7", "9"],
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
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "create") {
          issueBodies.push(
            NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"),
          );
          return ok("https://github.com/RSI-Software/t3code-hyprws/issues/42\n");
        }
        return ok("[]");
      },
    });
    const code = capture(() => run(["v1.0.0"], { runner: recording.runner, root: f.root })).value;
    assert.strictEqual(code, 1);
    const report = readReport(f.root, "v1.0.0");
    assert.strictEqual(report.outcome, "failed");
    assert.strictEqual(report.failure?.step, "check");
    assert.strictEqual(report.failure?.key, "v1.0.0");
    assert.strictEqual(report.failure?.issue, 42);
    assert.strictEqual(report.failure?.publishedVia, "gh");
    assert.strictEqual(report.failure?.publishError, null);
    const create = recording.calls.find(
      ({ command, args }) => command === "gh" && args[0] === "issue" && args[1] === "create",
    );
    assert.notStrictEqual(create, undefined);
    const args = create!.args;
    const value = (name: string): string | undefined => args[args.indexOf(name) + 1];
    assert.strictEqual(value("--title"), "hyprws sync failed at check (v1.0.0)");
    assert.strictEqual(value("--type"), "Notification 🔔");
    assert.deepStrictEqual(
      args.filter((argument, index) => args[index - 1] === "--label"),
      ["ci"],
    );
    const list = recording.calls.find(
      ({ command, args }) => command === "gh" && args[0] === "issue" && args[1] === "list",
    );
    assert.strictEqual(
      list!.args[list!.args.indexOf("--search") + 1],
      '"hyprws sync failed" in:title',
    );
    const body = issueBodies[0] ?? "";
    assert.match(body, /failed at the `check` step/);
    assert.match(
      body,
      /```\nthe check battery is red: vp run fork:delta --check, .*Test Server 2\n```/,
    );
    assert.match(body, /\| Test Server 2 · `vp run --filter t3 test --shard 2\/2` \| failed \|/);
    assert.match(body, /\| `vp run fork:delta --check` \| failed \|/);
    assert.include(body, failureMarker("check", "v1.0.0"));
  });
});

it("a rerun with the same failure edits the issue in place instead of filing again", () => {
  withFixture(checkRedFixture, (f) => {
    let creates = 0;
    const edits: string[] = [];
    let listResponse = ok("[]");
    const recording = exec({
      vp: () => refused("fork:delta --check is red"),
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "list") return listResponse;
        if (args[0] === "issue" && args[1] === "create") {
          creates += 1;
          return ok("https://github.com/RSI-Software/t3code-hyprws/issues/42\n");
        }
        if (args[0] === "issue" && args[1] === "edit") edits.push(args[2] ?? "");
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
    // the drifted body is rewritten in place, never commented
    assert.deepStrictEqual(edits, ["42"]);
    assert.strictEqual(
      recording.calls.some(({ args }) => args[0] === "issue" && args[1] === "comment"),
      false,
    );
    const report = readReport(f.root, "v1.0.0");
    assert.strictEqual(report.failure?.issue, 42);
    assert.strictEqual(report.failure?.publishedVia, "gh");
  });
});

it("a dry run reports the failure and files nothing", () => {
  withFixture(checkRedFixture, (f) => {
    let creates = 0;
    const recording = exec({
      vp: () => refused("fork:delta --check is red"),
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "create") creates += 1;
        return ok("[]");
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
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "create") {
          created.push({
            title: args[args.indexOf("--title") + 1] ?? "",
            body: NodeFS.readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8"),
          });
          return ok("https://github.com/RSI-Software/t3code-hyprws/issues/44\n");
        }
        return ok("[]");
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
    gh: (args) =>
      args[0] === "issue" && args[1] === "create"
        ? refused("delegated agents cannot create issues")
        : ok("[]"),
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
  assert.match(body, /\| Path \| Fork commit \| Upstream commit \| Refusal \|/);
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
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "close") {
          assert.match(
            args[args.indexOf("--comment") + 1] ?? "",
            new RegExp(`Resolved by hyprws ${f.git(["rev-parse", "origin/hyprws"], f.root)}\\.`),
          );
          return ok();
        }
        return openBlocksPerPhrase(args);
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
      gh: (args) =>
        args[0] === "issue" && args[1] === "close"
          ? refused("Issue RSI-Software/t3code-hyprws#1164 was not closed: no assignee.")
          : openBlocksPerPhrase(args),
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
        refusal: `gh issue close 1164 --reason completed --comment "Resolved by hyprws ${f.git(["rev-parse", "origin/hyprws"], f.root)}." --repo RSI-Software/t3code-hyprws failed: Issue RSI-Software/t3code-hyprws#1164 was not closed: no assignee.`,
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
      gh: (args) => {
        if (args[0] === "issue" && args[1] === "close") {
          assert.match(
            args[args.indexOf("--comment") + 1] ?? "",
            new RegExp(`Resolved by hyprws ${f.git(["rev-parse", "origin/hyprws"], f.root)}\\.`),
          );
          return ok();
        }
        return openBlocksPerPhrase(args);
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
      gh: (args) =>
        args[0] === "issue" && args[1] === "close"
          ? refused("Issue RSI-Software/t3code-hyprws#1164 was not closed: no assignee.")
          : openBlocksPerPhrase(args),
    });
    const applied = capture(() => run(["v1.0.0"], { runner, root: f.root }));
    assert.strictEqual(applied.value, 1);
    const report = readReport(f.root, "v1.0.0");
    assert.strictEqual(report.outcome, "already-applied");
    assert.deepStrictEqual(report.closedBlocks, [
      {
        issue: 1164,
        refusal: `gh issue close 1164 --reason completed --comment "Resolved by hyprws ${f.git(["rev-parse", "origin/hyprws"], f.root)}." --repo RSI-Software/t3code-hyprws failed: Issue RSI-Software/t3code-hyprws#1164 was not closed: no assignee.`,
      },
    ]);
    assert.match(report.error ?? "", /closing stale block issues failed/);
    assert.match(applied.output, /- ❌ block #1164 close refused/);
  });
});

// ---------------------------------------------------------------------------
// Fold at sync: fixup! landings autosquash onto the tag (RSI-Software/t3code-hyprws#1179)
// ---------------------------------------------------------------------------

/** A fork stack carrying one owner plus its fixup; the sync must fold the pair. */
const foldFixture = (): Fixture => {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-fold-"));
  const git = (args: ReadonlyArray<string>, cwd = base): string => {
    const result = runCommand("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} in ${cwd}: ${result.stderr.trim() || "failed"}`);
    return result.stdout.trim();
  };
  const configure = (cwd: string): void => {
    git(["config", "user.email", "fork@example.invalid"], cwd);
    git(["config", "user.name", "fork"], cwd);
    // The authoring workstation carries a global commit-msg hook that bans agent
    // attribution; fixtures commit with fork trailers, so they opt out locally
    // without touching the operator's global config.
    git(["config", "core.hooksPath", "/dev/null"], cwd);
  };
  const upstream = NodePath.join(base, "upstream.git");
  const origin = NodePath.join(base, "origin.git");
  const repo = NodePath.join(base, "repo");
  git(["init", "--quiet", "--bare", "--initial-branch", "main", upstream]);
  git(["init", "--quiet", "--bare", "--initial-branch", "main", origin]);
  git(["init", "--quiet", "--initial-branch", "main", repo]);
  configure(repo);
  NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), "line1\nline2\nline3\n");
  writeWorkflow(repo);
  git(["add", "."], repo);
  git(["commit", "--quiet", "-m", "base"], repo);
  git(["remote", "add", "origin", origin], repo);
  git(["remote", "add", "upstream", upstream], repo);
  git(["push", "--quiet", "origin", "main"], repo);
  git(["push", "--quiet", "upstream", "main"], repo);
  git(["checkout", "--quiet", "-b", "hyprws", "main"], repo);
  NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), "fork line1\nline2\nline3\n");
  git(["add", "shared.txt"], repo);
  git(
    [
      "commit",
      "--quiet",
      "-m",
      "feat(fork): owned change\n\nFork-Domain: fork-meta\nFork-Tier: core\nCo-authored-by: fork <fork@example.invalid>",
    ],
    repo,
  );
  NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), "fork line1 fixed\nline2\nline3\n");
  git(["add", "shared.txt"], repo);
  git(["commit", "--quiet", "-m", "fixup! feat(fork): owned change"], repo);
  git(["push", "--quiet", "origin", "hyprws"], repo);
  git(["checkout", "--quiet", "main"], repo);
  NodeFS.writeFileSync(NodePath.join(repo, "shared.txt"), "line1\nline2\nline3 upstream\n");
  git(["commit", "--quiet", "-am", "upstream change"], repo);
  git(["tag", "v1.0.0"], repo);
  git(["push", "--quiet", "upstream", "main", "v1.0.0"], repo);
  git(["checkout", "--quiet", "hyprws"], repo);
  return {
    root: repo,
    worktree: NodePath.join(repo, ".t3", "fork-sync", "worktree"),
    git,
  };
};

const withFoldFixture = (effect: (fixture: Fixture) => void): void => {
  const f = foldFixture();
  try {
    effect(f);
  } finally {
    NodeFS.rmSync(NodePath.dirname(f.root), { recursive: true, force: true });
  }
};

it("refuses a fixup whose subject names no fork commit above the target", () => {
  assert.deepStrictEqual(
    fixupRefusals(["feat(fork): owned change", "fixup! feat(fork): missing change"]),
    ['fixup "fixup! feat(fork): missing change" names no fork commit above the target'],
  );
});

it("refuses a fixup whose subject names more than one fork commit above the target", () => {
  assert.deepStrictEqual(
    fixupRefusals([
      "feat(fork): twice owned",
      "feat(fork): twice owned",
      "fixup! feat(fork): twice owned",
    ]),
    ['fixup "fixup! feat(fork): twice owned" names 2 fork commits above the target'],
  );
});

it("starts the sync rebase interactive with autosquash and no-op editors", () => {
  withFoldFixture((f) => {
    const seen: Array<{
      readonly args: ReadonlyArray<string>;
      readonly env: NodeJS.ProcessEnv | undefined;
    }> = [];
    const target = { tag: "v1.0.0", sha: f.git(["rev-parse", "v1.0.0"], f.root) };
    const oldSha = f.git(["rev-parse", "hyprws"], f.root);
    const runner: CommandRunner = {
      run: (command, args, spec) => {
        if (command === "git" && args.includes("rebase"))
          seen.push({ args: [...args], env: spec.env });
        return runCommand(command, args, {
          cwd: spec.cwd,
          ...(spec.env === undefined ? {} : { env: spec.env }),
          ...(spec.stream === undefined ? {} : { stream: spec.stream }),
        });
      },
    };
    const outcome = rebaseOnto(runner, f.root, target, oldSha);
    assert.strictEqual(outcome.status, "applied");
    const initial = seen[0];
    assert.notStrictEqual(initial, undefined);
    assert.ok(initial!.args.includes("-i"));
    assert.ok(initial!.args.includes("--autosquash"));
    assert.strictEqual(initial!.env?.GIT_EDITOR, "true");
    assert.strictEqual(initial!.env?.GIT_SEQUENCE_EDITOR, "true");
  });
});

it("folds the fixup into its owner so the applied series never carries fix-of-fix", () => {
  withFoldFixture((f) => {
    const fold = (): void => {
      const result = runCommand("git", ["rebase", "-i", "--autosquash", "v1.0.0"], {
        cwd: f.root,
        env: { ...process.env, GIT_SEQUENCE_EDITOR: "true" },
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0)
        throw new Error(`git rebase -i --autosquash in ${f.root}: ${result.stderr.trim()}`);
    };
    fold();
    const subjects = f
      .git(["log", "--format=%s", "v1.0.0..HEAD"], f.root)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    assert.deepStrictEqual(subjects, ["feat(fork): owned change"]);
    const folded = f.git(["rev-parse", "HEAD^{tree}"], f.root);
    // Rehearsal: folding the same base a second time reaches the same tree.
    f.git(["checkout", "--quiet", "hyprws@{1}"], f.root);
    fold();
    assert.strictEqual(f.git(["rev-parse", "HEAD^{tree}"], f.root), folded);
    // Trailers survive the fold as exactly one contiguous trailer block.
    const body = f.git(["log", "-1", "--format=%B", "HEAD"], f.root);
    const trailers = f.git(["log", "-1", "--format=%(trailers)", "HEAD"], f.root);
    assert.match(trailers, /Fork-Domain: fork-meta/);
    assert.match(trailers, /Fork-Tier: core/);
    assert.match(trailers, /Co-authored-by: fork <fork@example\.invalid>/);
    assert.strictEqual(body.trimEnd().endsWith(trailers.trimEnd()), true);
  });
});

it("scopes the sync battery's fork:ci to the rehearsal target", () => {
  withFixture(
    {
      forkContent: "fork line1\nline2\nline3\n",
      upstreamContent: "line1\nline2\nline3 upstream\n",
    },
    (f) => {
      const target = f.git(["rev-parse", "v1.0.0"], f.root);
      const seen: Array<ReadonlyArray<string>> = [];
      const recording = exec({
        vp: (args) => {
          seen.push(args);
          return ok();
        },
      });
      const code = capture(() => run(["v1.0.0"], { runner: recording.runner, root: f.root })).value;
      assert.strictEqual(code, 0);
      const ci = seen.find((args) => args[1] === "fork:ci");
      assert.notStrictEqual(ci, undefined);
      // The rehearsal head authors no commits: the battery guards the replayed
      // fork delta after the target, not every commit since the upstream base.
      assert.deepStrictEqual(ci, ["run", "fork:ci", "--since", target]);
      for (const args of seen) {
        if (args[1] === "fork:ci") continue;
        assert.strictEqual(
          args.includes("--since"),
          false,
          `only fork:ci takes --since: ${args.join(" ")}`,
        );
      }
    },
  );
});

it("keeps the combined check output tail in the failure detail", () => {
  const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
  const detail = checkFailureDetail({ status: 1, stdout: lines.join("\n"), stderr: "boom\n" });
  const kept = detail.replace(/ \(exit 1\)$/, "").split("\n");
  assert.strictEqual(kept.length, 40);
  assert.strictEqual(kept[0], "line 12");
  assert.strictEqual(kept[kept.length - 1], "boom");
  assert.match(detail, /exit 1/);
});

it("says no output only when both check streams are empty", () => {
  assert.strictEqual(
    checkFailureDetail({ status: 1, stdout: "", stderr: "" }),
    "no output (exit 1)",
  );
  assert.match(
    checkFailureDetail({ status: 1, stdout: "", stderr: "  \n " }),
    /no output \(exit 1\)/,
  );
});

it("records a non-empty detail tail when a streamed battery check fails", () => {
  withFixture(
    {
      forkContent: "fork line1\nline2\nline3\n",
      upstreamContent: "line1\nline2\nline3 upstream\n",
    },
    (f) => {
      // A nested vp failure whose output arrives the streamed way: captured
      // text present on the result, the way runCommand's stream mode returns.
      const nested = Array.from({ length: 45 }, (_, index) => `nested line ${index + 1}`);
      const recording = exec({
        vp: () => ({ status: 1, stdout: `${nested.join("\n")}\n`, stderr: "nested boom\n" }),
      });
      const printed = capture(() => run(["v1.0.0"], { runner: recording.runner, root: f.root }));
      assert.strictEqual(printed.value, 1);
      const report = readReport(f.root, "v1.0.0");
      const red = report.checks.find((check) => check.status === "failed");
      assert.notStrictEqual(red, undefined);
      assert.notMatch(red!.detail, /no output/);
      const kept = red!.detail.replace(/ \(exit 1\)$/, "").split("\n");
      assert.strictEqual(kept.length, 40);
      assert.strictEqual(kept[kept.length - 1], "nested boom");
      assert.match(red!.detail, /exit 1/);
    },
  );
});

// ---------------------------------------------------------------------------
// The setup step's install vs a second one: the dependency-set skew guard
// ---------------------------------------------------------------------------

/** A minimal repo (no upstream/origin remotes) for the dependency-diff guard. */
const dependencyRepo = (): { readonly root: string; readonly worktree: string } => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-deps-test-"));
  const git = (args: ReadonlyArray<string>): string => {
    const result = runCommand("git", args, { cwd: root });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} in ${root}: ${result.stderr.trim() || "failed"}`);
    return result.stdout.trim();
  };
  git(["init", "--quiet", "--initial-branch", "main"]);
  git(["config", "user.email", "fork@example.invalid"]);
  git(["config", "user.name", "fork"]);
  NodeFS.writeFileSync(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: 1\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "trunk"]);
  const worktree = NodePath.join(root, "replay-worktree");
  writeWorkflow(worktree);
  return { root, worktree };
};

it("installs again in the replay worktree when the tip changed the lockfile since setup", () => {
  const repo = dependencyRepo();
  try {
    const trunkSha = runCommand("git", ["rev-parse", "HEAD"], { cwd: repo.root }).stdout.trim();
    NodeFS.writeFileSync(NodePath.join(repo.root, "pnpm-lock.yaml"), "lockfileVersion: 2\n");
    runCommand("git", ["commit", "--quiet", "-am", "bump vite-plus"], { cwd: repo.root });
    const targetSha = runCommand("git", ["rev-parse", "HEAD"], { cwd: repo.root }).stdout.trim();

    assert.strictEqual(dependencySetChanged(realRunner, repo.root, trunkSha, targetSha), true);

    const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const runner: CommandRunner = {
      run: (command, args, spec) => {
        calls.push({ command, args });
        if (command === "vp") return ok();
        return runCommand(command, args, { cwd: spec.cwd });
      },
    };
    const target: ReleaseTag = { tag: "v1.0.0", sha: targetSha };
    const printed = capture(() => runChecks(runner, repo.root, repo.worktree, target, trunkSha));

    assert.match(printed.output, /sync: dependency set changed since/);
    const install = calls.find((call) => call.command === "vp" && call.args[0] === "i");
    assert.notStrictEqual(install, undefined);
    assert.deepStrictEqual(install!.args, ["i", "--frozen-lockfile"]);
  } finally {
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }
});

it("skips a second install when the tip kept the dependency set setup installed", () => {
  const repo = dependencyRepo();
  try {
    const trunkSha = runCommand("git", ["rev-parse", "HEAD"], { cwd: repo.root }).stdout.trim();
    NodeFS.writeFileSync(NodePath.join(repo.root, "unrelated.txt"), "hello\n");
    runCommand("git", ["add", "."], { cwd: repo.root });
    runCommand("git", ["commit", "--quiet", "-m", "unrelated change"], { cwd: repo.root });
    const targetSha = runCommand("git", ["rev-parse", "HEAD"], { cwd: repo.root }).stdout.trim();

    assert.strictEqual(dependencySetChanged(realRunner, repo.root, trunkSha, targetSha), false);

    const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const runner: CommandRunner = {
      run: (command, args, spec) => {
        calls.push({ command, args });
        if (command === "vp") return ok();
        return runCommand(command, args, { cwd: spec.cwd });
      },
    };
    const target: ReleaseTag = { tag: "v1.0.0", sha: targetSha };
    const printed = capture(() => runChecks(runner, repo.root, repo.worktree, target, trunkSha));

    assert.notMatch(printed.output, /installing/);
    const install = calls.find((call) => call.command === "vp" && call.args[0] === "i");
    assert.strictEqual(install, undefined);

    // a worktree no setup step installed gets the battery's own install
    const bare = capture(() => runChecks(runner, repo.root, repo.worktree, target, null));
    assert.match(bare.output, /nothing installed in the replay worktree/);
    assert.strictEqual(
      calls.filter((call) => call.command === "vp" && call.args[0] === "i").length,
      1,
    );
  } finally {
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }
});

it("runs every single-command step of the CI Check job before a direct trunk push", () => {
  // Setup steps, and steps `fork:ci` already runs in CI's shape.
  const coveredElsewhere = new Set([
    "vp run --filter @t3tools/desktop ensure:electron",
    "vp run fork:stale-delete",
    "vp check",
  ]);
  const workflow = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "..", ".github", "workflows", "hyprws-ci.yml"),
    "utf8",
  );
  const job = workflow.slice(
    workflow.indexOf("\n  check:\n"),
    workflow.indexOf("\n  merge-tree:\n"),
  );
  const steps = [...job.matchAll(/^\s+run: (vpr? .+)$/gm)].map((match) => match[1]!.trim());
  const battery = new Set(checkCommands().map((args) => args.join(" ")));
  const uncovered = steps.filter((step) => {
    const command = step.split(" --base ")[0]!;
    if (coveredElsewhere.has(command)) return false;
    return !battery.has(command.replace(/^vpr /, "run ").replace(/^vp /, ""));
  });
  assert.isAbove(steps.length, 3);
  assert.deepStrictEqual(uncovered, []);
});

it("runs every hyprws CI test job before a direct trunk push", () => {
  const source = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "..", FORK_CI_WORKFLOW_PATH),
    "utf8",
  );
  const jobs = deriveCiTestJobs(source);
  const derived = new Set(jobs.map((job) => job.id));
  // `check` is guarded by the Check-job test above; `merge-tree` gates a
  // pull-request head's conflicts against the trunk and tests nothing.
  assert.deepStrictEqual(
    workflowJobIds(source).filter((id) => !derived.has(id)),
    ["check", "merge-tree"],
  );

  const repo = dependencyRepo();
  try {
    writeWorkflow(repo.worktree, source);
    const trunkSha = runCommand("git", ["rev-parse", "HEAD"], { cwd: repo.root }).stdout.trim();
    const calls: Array<ReadonlyArray<string>> = [];
    const runner: CommandRunner = {
      run: (command, args, spec) => {
        if (command === "vp") {
          calls.push(args);
          return ok();
        }
        return runCommand(command, args, { cwd: spec.cwd });
      },
    };
    const target: ReleaseTag = { tag: "v1.0.0", sha: trunkSha };
    const rows = capture(() => runChecks(runner, repo.root, repo.worktree, target, trunkSha)).value;
    assert.deepStrictEqual(
      calls.slice(checkCommands().length),
      jobs.flatMap((job) => job.commands),
    );
    assert.deepStrictEqual(
      rows.flatMap((row) => (row.job === undefined ? [] : [row.job])),
      jobs.map((job) => job.name),
    );
  } finally {
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }
});

it("leaves the trunk alone and names the suite when one CI test job is red", () => {
  withFixture(
    {
      forkContent: "fork line1\nline2\nline3\n",
      upstreamContent: "line1\nline2\nline3 upstream\n",
    },
    (f) => {
      const shas = forkShas(f);
      const recording = exec({
        vp: (args) =>
          args.includes("2/2") ? refused("FAIL src/rateLimit.test.ts > probes GraphQL\n") : ok(),
      });
      const printed = capture(() => run(["v1.0.0"], { runner: recording.runner, root: f.root }));
      assert.strictEqual(printed.value, 1);
      const report = readReport(f.root, "v1.0.0");
      assert.strictEqual(report.outcome, "failed");
      assert.strictEqual(report.error, "the check battery is red: Test Server 2");
      assert.deepStrictEqual(
        report.checks.filter((check) => check.status === "failed").map((check) => check.job),
        ["Test Server 2"],
      );
      // the battery still runs every other job, so one report names every red suite
      assert.strictEqual(report.checks.length, BATTERY_ROWS);
      assert.match(printed.output, /❌ Test Server 2 · `vp run --filter t3 test --shard 2\/2`/);
      assert.strictEqual(
        recording.calls.some(({ command, args }) => command === "git" && args[0] === "push"),
        false,
      );
      assert.strictEqual(f.git(["rev-parse", "origin/hyprws"], f.root), shas.fork);
    },
  );
});

it("runs the battery with CI's umask and none of the live T3 instance's environment", () => {
  const repo = dependencyRepo();
  const inherited = {
    T3_SERVICE_LAUNCHER_CONTEXT: process.env.T3_SERVICE_LAUNCHER_CONTEXT,
    T3CODE_HOME: process.env.T3CODE_HOME,
  };
  const outer = process.umask(0o077);
  try {
    process.env.T3_SERVICE_LAUNCHER_CONTEXT = '{"childVersion":"9.9.9"}';
    process.env.T3CODE_HOME = NodePath.join(repo.root, "live-home");
    const trunkSha = runCommand("git", ["rev-parse", "HEAD"], { cwd: repo.root }).stdout.trim();
    const seen: Array<{ readonly umask: number; readonly keys: ReadonlyArray<string> }> = [];
    const runner: CommandRunner = {
      run: (command, args, spec) => {
        if (command !== "vp") return runCommand(command, args, { cwd: spec.cwd });
        const umask = process.umask(0o022);
        process.umask(umask);
        seen.push({
          umask,
          keys: Object.keys(spec.env ?? {}).filter((key) => key.startsWith("T3")),
        });
        return ok();
      },
    };
    const target: ReleaseTag = { tag: "v1.0.0", sha: trunkSha };
    capture(() => runChecks(runner, repo.root, repo.worktree, target, trunkSha));
    assert.strictEqual(seen.length, checkCommands().length + 3);
    for (const call of seen) assert.deepStrictEqual(call, { umask: 0o022, keys: [] });
    const restored = process.umask(outer);
    assert.strictEqual(restored, 0o077);
  } finally {
    process.umask(outer);
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    NodeFS.rmSync(repo.root, { recursive: true, force: true });
  }
});

it("takes no flag that drops a battery row", () => {
  withFixture(
    {
      forkContent: "fork line1\nline2\nline3\n",
      upstreamContent: "line1\nline2\nline3 upstream\n",
    },
    (f) => {
      const recording = exec();
      const code = capture(() =>
        run(["v1.0.0", "--skip-tests"], { runner: recording.runner, root: f.root }),
      ).value;
      assert.strictEqual(code, 1);
      assert.strictEqual(
        recording.calls.some(({ command }) => command === "vp"),
        false,
      );
    },
  );
});
