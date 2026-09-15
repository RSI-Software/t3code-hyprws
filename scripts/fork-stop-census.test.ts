// @effect-diagnostics nodeBuiltinImport:off - The census drives real git in real fixture worktrees.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { rehearseStopCensus, CENSUS_EMPTY_COMMIT_ARGS } from "./fork-stop-census.ts";
import { autoResolveConflicts } from "./fork-sync.ts";
import {
  SystemCommandRunner,
  type CommandRunner,
  type CwdCommandRunner,
} from "./lib/fork-command.ts";
import { resolveConflictPath } from "./lib/fork-conflict-resolution.ts";
import {
  censusResolutionSplit,
  censusRowReason,
  censusTotals,
  requireSequentialCensusEvidence,
} from "./lib/fork-rebase-issues.ts";

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

const write = (root: string, path: string, contents: string): void => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), contents);
};

const commit = (root: string, subject: string, domain = "fork-meta"): string => {
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", subject, "-m", `Fork-Domain: ${domain}\nFork-Tier: qol`]);
  return git(root, ["rev-parse", "HEAD"]);
};

const repository = (prefix: string): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  git(root, ["init", "--quiet", "-b", "base"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  return root;
};

/** Stage the three rebase index stages for one path, exactly as a conflicted replay leaves them. */
const stageConflict = (
  root: string,
  path: string,
  contents: { readonly base: string; readonly ours: string; readonly theirs: string },
): void => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  const entries = ([1, 2, 3] as const)
    .map((stage) => {
      const value = stage === 1 ? contents.base : stage === 2 ? contents.ours : contents.theirs;
      const written = NodeChildProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: root,
        input: value,
        encoding: "utf8",
      }).trim();
      return `100644 ${written} ${stage}\t${path}`;
    })
    .join("\n");
  NodeChildProcess.execFileSync("git", ["update-index", "--index-info"], {
    cwd: root,
    input: `${entries}\n`,
  });
};

/** A runner that fails the test if the census ever spends a scoped typecheck. */
const noTypecheckRunner = (): CwdCommandRunner => {
  const system = new SystemCommandRunner();
  return {
    run: (command, args, cwd, input, env) => {
      if (command === "vp") throw new Error(`the census ran a scoped check: vp ${args.join(" ")}`);
      return system.run(command, args, cwd, input, env);
    },
  };
};

const VERIFIABLE = "apps/web/src/window.ts";

it("names the outcome source that resolved each path, and only a declined path is a human stop", () => {
  const root = repository("fork-census-stage-");
  const runner = new SystemCommandRunner();
  const options = { rerereRemaining: null, verifyHookReapply: false } as const;
  try {
    // Only upstream moved: the fork side still carries the base text.
    stageConflict(root, VERIFIABLE, { base: "a\n", ours: "a\nup\n", theirs: "a\n" });
    assert.strictEqual(
      resolveConflictPath(runner, root, VERIFIABLE, options).stage,
      "upstream-only",
    );

    // Only the fork moved, so the fork feature keeps working.
    stageConflict(root, VERIFIABLE, { base: "a\n", ours: "a\n", theirs: "a\nfork\n" });
    assert.strictEqual(resolveConflictPath(runner, root, VERIFIABLE, options).stage, "fork-only");

    // Both added text where the base had none: a co-insertion the executor keeps whole.
    stageConflict(root, VERIFIABLE, { base: "a\n", ours: "a\nup\n", theirs: "a\nfork\n" });
    assert.strictEqual(resolveConflictPath(runner, root, VERIFIABLE, options).stage, "keep-both");

    // Both rewrote the same line: a union would say two things at once, so a maintainer owns it.
    stageConflict(root, VERIFIABLE, { base: "a\n", ours: "b\n", theirs: "c\n" });
    const declined = resolveConflictPath(runner, root, VERIFIABLE, options);
    assert.strictEqual(declined.stage, "unresolved");
    if (declined.stage !== "unresolved") return;
    assert.include(declined.outcome.reason, "rewrote the same lines");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("counts a rerere replay as mechanical without re-deciding it", () => {
  const root = repository("fork-census-rerere-");
  const runner = new SystemCommandRunner();
  try {
    stageConflict(root, VERIFIABLE, { base: "a\n", ours: "b\n", theirs: "c\n" });
    // What a replay leaves behind: an unmerged index and a worktree file with no markers left.
    write(root, VERIFIABLE, "replayed\n");
    assert.strictEqual(
      resolveConflictPath(runner, root, VERIFIABLE, {
        rerereRemaining: new Set(),
        verifyHookReapply: false,
      }).stage,
      "rerere",
    );
    // The same path while rerere still lists it: no replay, so the executor decides it, and this
    // seam is one it declines.
    assert.strictEqual(
      resolveConflictPath(runner, root, VERIFIABLE, {
        rerereRemaining: new Set([VERIFIABLE]),
        verifyHookReapply: false,
      }).stage,
      "unresolved",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

const MARKED_HOOK = "upstream-fixes/settings-patch-field";
const HOOK_PATH = "packages/contracts/src/settings.ts";
const HOOK_MANIFEST = {
  [MARKED_HOOK]: {
    path: HOOK_PATH,
    anchor: { kind: "collection", symbol: "ServerSettingsPatch" },
  },
} as const;

it("records a hook re-apply as unverified rather than paying the walk's scoped typecheck", () => {
  const root = repository("fork-census-reapply-");
  try {
    stageConflict(root, HOOK_PATH, {
      base: "export interface ServerSettingsPatch {\n  rename: string;\n}\n\nexport const tail = 0;\n",
      ours: "export interface ServerSettingsPatch {\n  name: string;\n  mount: boolean;\n}\n\nexport const tail = 0;\nexport const up = 1;\n",
      theirs: `export interface ServerSettingsPatch {\n  rename: string;\n  restoreSymlinks: boolean; // fork-hook: ${MARKED_HOOK}\n}\n\nexport const tail = 0;\nexport const fsf = 1; // fork-hook: ${MARKED_HOOK}\n`,
    });
    const resolution = resolveConflictPath(noTypecheckRunner(), root, HOOK_PATH, {
      rerereRemaining: null,
      verifyHookReapply: false,
      manifest: HOOK_MANIFEST,
    });
    assert.strictEqual(resolution.stage, "hook-reapply");
    if (resolution.stage !== "hook-reapply") return;
    // The row says what was not run; nothing downstream may read it as a checked resolution.
    assert.isFalse(resolution.outcome.verified);
    assert.include(resolution.outcome.resolution, "scoped typecheck not run");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * One fork stack over one upstream change: a co-insertion the executor resolves, and a rewritten
 * seam it declines. The census must see one conflict per commit and one human stop.
 */
const stackFixture = (): {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly target: string;
  readonly mechanical: string;
  readonly human: string;
} => {
  const root = repository("fork-census-stack-");
  write(root, VERIFIABLE, "first\nshared\nthird\n");
  write(root, "apps/web/src/other.ts", "alpha\n");
  const base = commit(root, "base");
  git(root, ["branch", "fork-stack"]);

  git(root, ["switch", "--quiet", "-c", "upstream-lane"]);
  // The appended lines are bare identifiers: a kept-both resolution must parse, so fixture text
  // that is two adjacent identifiers (e.g. "upstream tail") would decline instead (RSI-Software/t3code-hyprws#665).
  write(root, VERIFIABLE, "first\nshared\nthird\nupstreamTail\n");
  write(root, "apps/web/src/other.ts", "upstream alpha\n");
  const target = commit(root, "fix: upstream change");

  git(root, ["switch", "--quiet", "fork-stack"]);
  write(root, VERIFIABLE, "first\nshared\nthird\nforkTail\n");
  const mechanical = commit(root, "feat(test): fork appends its own tail");
  write(root, "apps/web/src/other.ts", "fork alpha\n");
  const human = commit(root, "feat(test): fork rewrites the same line");
  return { root, base, head: human, target, mechanical, human };
};

it("separates the mechanical rows from the human stops without moving the conflict total", () => {
  const fixture = stackFixture();
  try {
    const census = rehearseStopCensus(fixture.root, fixture.head, fixture.base, {
      tag: "v2.0.0",
      sha: fixture.target,
      position: 1,
      stable: true,
    });
    const rows = census.evidence?.rows ?? [];
    assert.strictEqual(census.evidence?.method, "sequential-rebase-walk-resolution");
    assert.deepStrictEqual(
      rows.map(({ stop, path, stage, commit: sha }) => ({ stop, path, stage, sha })),
      [
        { stop: 1, path: VERIFIABLE, stage: "keep-both", sha: fixture.mechanical },
        { stop: 2, path: "apps/web/src/other.ts", stage: "unresolved", sha: fixture.human },
      ],
    );
    // The conflict measure is the one forecast and churn read, and it is unchanged: every
    // conflicted path observation still counts, whoever resolves it.
    assert.deepStrictEqual(censusTotals(rows), {
      conflictingForkCommitCount: 2,
      conflictingFileCount: 2,
    });
    assert.strictEqual(census.conflictingForkCommitCount, 2);
    assert.strictEqual(census.conflictingFileCount, 2);
    // What the conflict measure never said: only one of the two reaches a human.
    assert.deepStrictEqual(censusResolutionSplit(rows), {
      mechanicalFileCount: 1,
      unverifiedFileCount: 0,
      humanFileCount: 1,
      unmeasuredFileCount: 0,
      humanForkCommitCount: 1,
      humanStopCount: 1,
    });
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("records why a stop reached a human, and records nothing on a row that resolved", () => {
  const fixture = stackFixture();
  try {
    const rows =
      rehearseStopCensus(fixture.root, fixture.head, fixture.base, {
        tag: "v2.0.0",
        sha: fixture.target,
        position: 1,
        stable: true,
      }).evidence?.rows ?? [];
    assert.deepStrictEqual(
      rows.map((row) => ({ path: row.path, reason: censusRowReason(row) })),
      [
        { path: VERIFIABLE, reason: null },
        {
          path: "apps/web/src/other.ts",
          reason:
            "upstream and the fork rewrote the same lines; keeping both would say two things at once, so a maintainer owns this seam",
        },
      ],
    );
    // A mechanical row carries no key at all, so a record written from it stays byte-identical to
    // one written before the field existed.
    assert.notProperty(rows[0], "reason");
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("never materialises a reason the stored evidence did not carry", () => {
  const row = {
    stop: 1,
    commit: "c".repeat(40),
    subject: "feat(test): a stored seam",
    domain: "fork-meta",
    kind: "content" as const,
    path: VERIFIABLE,
    stage: "unresolved" as const,
  };
  const stored = {
    version: 1 as const,
    method: "sequential-rebase-walk-resolution" as const,
    sourceSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    targetSha: "d".repeat(40),
    targetTag: "v2.0.0",
    complete: true,
    rows: [row],
  };
  // The parser is a pure validator: a record is re-digested from what it returns, so a default
  // here would move every id ever written (RSI-Software/t3code-hyprws#1012).
  const parsed = requireSequentialCensusEvidence(JSON.parse(JSON.stringify(stored)));
  assert.deepStrictEqual(parsed, stored);
  assert.notProperty(parsed.rows[0], "reason");
  assert.strictEqual(censusRowReason(parsed.rows[0]!), null);
  // A stored reason survives the round trip unchanged.
  const withReason = { ...stored, rows: [{ ...row, reason: "a recorded stop" }] };
  assert.deepStrictEqual(
    requireSequentialCensusEvidence(JSON.parse(JSON.stringify(withReason))),
    withReason,
  );
  assert.throws(
    () => requireSequentialCensusEvidence({ ...stored, rows: [{ ...row, reason: 7 }] }),
    /invalid census stop row/,
  );
});

it("counts a census that predates the resolution stages as unmeasured, never as mechanical", () => {
  assert.deepStrictEqual(
    censusResolutionSplit([
      {
        stop: 1,
        commit: "a".repeat(40),
        subject: "legacy row",
        kind: "content",
        domain: null,
        path: VERIFIABLE,
        stage: "unmeasured",
      },
    ]),
    {
      mechanicalFileCount: 0,
      unverifiedFileCount: 0,
      humanFileCount: 0,
      unmeasuredFileCount: 1,
      humanForkCommitCount: 0,
      humanStopCount: 0,
    },
  );
});

/** The real system runner with the walk's formatter stubbed: a fixture repository has no `vp`. */
const walkRunner = (): CommandRunner => {
  const system = new SystemCommandRunner();
  return {
    run: (command, args, cwd, input, env, stream, timeout) =>
      command === "vp"
        ? { status: 0, stdout: "", stderr: "" }
        : system.run(command, args, cwd ?? process.cwd(), input, env, stream, timeout),
  };
};

const rebaseInProgress = (lane: string): boolean =>
  NodeFS.existsSync(NodePath.join(lane, ".git", "rebase-merge")) ||
  NodeFS.existsSync(NodePath.join(lane, ".git", "rebase-apply"));

/**
 * What the real walk says about the same range: a real `git rebase`, and `autoResolveConflicts` at
 * every stop it reaches. The walk stops at the first path it declines, which is where the
 * comparison ends.
 */
const walkResolution = (
  fixture: ReturnType<typeof stackFixture>,
): { readonly mechanical: ReadonlyArray<string>; readonly human: ReadonlyArray<string> } => {
  const lane = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-walk-lane-"));
  const reports = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-walk-report-"));
  const runner = walkRunner();
  const mechanical: Array<string> = [];
  const human: Array<string> = [];
  NodeChildProcess.execFileSync("git", ["clone", "--quiet", fixture.root, lane]);
  git(lane, ["config", "user.name", "Test User"]);
  git(lane, ["config", "user.email", "test@example.com"]);
  git(lane, ["checkout", "--quiet", "--detach", fixture.head]);
  runner.run("git", ["rebase", "--onto", fixture.target, fixture.base], lane);
  while (rebaseInProgress(lane)) {
    const paths = git(lane, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    const commit = git(lane, ["rev-parse", "REBASE_HEAD"]);
    const message = git(lane, ["show", "-s", "--format=%B", commit]);
    const outcome = autoResolveConflicts(
      {
        schemaVersion: 1,
        stage: "conflicts",
        repositoryRoot: lane,
        reportPath: NodePath.join(reports, "report.json"),
        recordPath: NodePath.join(reports, "record.md"),
        issue: { number: 1, blockingSha: fixture.target, title: "blocked" },
        candidates: [{ tag: "v2.0.0", sha: fixture.target }],
        lane: { branch: "rehearse/v2.0.0", worktree: lane },
        conflicts: paths.map((path) => ({
          commit,
          subject: message.split("\n")[0] ?? "",
          domain: "fork-meta",
          path,
          class: "TODO" as const,
          resolution: "TODO",
          agentSafe: "TODO",
          decidedBy: "human" as const,
        })),
        verification: [],
      },
      runner,
    );
    if (outcome.kind === "unresolved") {
      human.push(...outcome.rows.map((row) => row.path));
      break;
    }
    mechanical.push(...paths);
    runner.run("git", ["rebase", "--continue"], lane, undefined, {
      ...process.env,
      GIT_EDITOR: "true",
    });
  }
  NodeFS.rmSync(lane, { recursive: true, force: true });
  NodeFS.rmSync(reports, { recursive: true, force: true });
  return { mechanical, human };
};

it("agrees with a real walk over the same range about which paths reach a human", () => {
  const fixture = stackFixture();
  try {
    const rows =
      rehearseStopCensus(fixture.root, fixture.head, fixture.base, {
        tag: "v2.0.0",
        sha: fixture.target,
        position: 1,
        stable: true,
      }).evidence?.rows ?? [];
    const walk = walkResolution(fixture);
    // Census output against walk output, not one function against itself: both drove a real
    // rebase of the same range, and the walk stopped where the census says a human owns the seam.
    assert.deepStrictEqual(
      rows.filter((row) => row.stage === "unresolved").map((row) => row.path),
      [...walk.human],
    );
    assert.deepStrictEqual(
      rows.filter((row) => row.stage !== "unresolved").map((row) => row.path),
      [...walk.mechanical],
    );
    // Both sides did real work: the walk resolved the first seam and declined the second.
    assert.deepStrictEqual([...walk.mechanical], [VERIFIABLE]);
    assert.deepStrictEqual([...walk.human], ["apps/web/src/other.ts"]);
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("counts a generated path as an operator stop, because it cannot run the generator", () => {
  const root = repository("fork-census-generated-");
  const generated = "apps/web/src/routeTree.gen.ts";
  try {
    write(root, generated, "first\nshared\nthird\n");
    const base = commit(root, "base");
    git(root, ["branch", "fork-stack"]);
    git(root, ["switch", "--quiet", "-c", "upstream-lane"]);
    write(root, generated, "first\nupstream\nthird\n");
    const target = commit(root, "fix: upstream regenerates");
    git(root, ["switch", "--quiet", "fork-stack"]);
    write(root, generated, "first\nfork\nthird\n");
    const head = commit(root, "feat(test): fork regenerates");

    const rows =
      rehearseStopCensus(root, head, base, {
        tag: "v2.0.0",
        sha: target,
        position: 1,
        stable: true,
      }).evidence?.rows ?? [];
    // The real walk restores HEAD and reruns the generator. This rehearsal has no toolchain to
    // run, so it says a human owns the path rather than claiming a resolution it never saw.
    assert.deepStrictEqual(
      rows.map(({ path, stage }) => ({ path, stage })),
      [{ path: generated, stage: "unresolved" }],
    );
    assert.strictEqual(censusResolutionSplit(rows).mechanicalFileCount, 0);
    assert.strictEqual(censusResolutionSplit(rows).humanFileCount, 1);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps an unverified hook re-apply out of both the mechanical and the human total", () => {
  const row = {
    stop: 1,
    commit: "b".repeat(40),
    subject: "feat(test): a marked seam",
    domain: "fork-meta",
    kind: "content" as const,
    path: HOOK_PATH,
  };
  assert.deepStrictEqual(
    censusResolutionSplit([
      { ...row, stage: "hook-reapply-unverified" },
      { ...row, stop: 2, path: VERIFIABLE, stage: "keep-both" },
      { ...row, stop: 3, path: "apps/web/src/other.ts", stage: "unresolved" },
    ]),
    {
      mechanicalFileCount: 1,
      unverifiedFileCount: 1,
      humanFileCount: 1,
      unmeasuredFileCount: 0,
      humanForkCommitCount: 1,
      humanStopCount: 1,
    },
  );
});

it("carries both empty-commit drops on the census startup rebase, and neither on skip", () => {
  // --empty=drop alone is not enough: it only removes commits that become empty during the
  // replay, while --no-keep-empty removes commits that start empty. Both are startup-only
  // flags — invalid on `rebase --skip`/`--continue` — so they must stay a startup-only tuple.
  assert.deepStrictEqual([...CENSUS_EMPTY_COMMIT_ARGS], ["--empty=drop", "--no-keep-empty"]);
});

it("drops a commit that starts empty from the census replay without moving the census", () => {
  const fixture = stackFixture();
  try {
    git(fixture.root, ["commit", "--allow-empty", "-m", "chore(fork): empty replay"]);
    const head = git(fixture.root, ["rev-parse", "HEAD"]);
    const census = rehearseStopCensus(fixture.root, head, fixture.base, {
      tag: "v2.0.0",
      sha: fixture.target,
      position: 1,
      stable: true,
    });
    // The empty commit adds no stop and survives nowhere: the rows still attribute both
    // conflicts to the two real fork commits, and the totals are the two-commit measure.
    const rows = census.evidence?.rows ?? [];
    assert.deepStrictEqual(
      rows.map(({ stop, path, stage, commit: sha }) => ({ stop, path, stage, sha })),
      [
        { stop: 1, path: VERIFIABLE, stage: "keep-both", sha: fixture.mechanical },
        { stop: 2, path: "apps/web/src/other.ts", stage: "unresolved", sha: fixture.human },
      ],
    );
    assert.deepStrictEqual(censusTotals(rows), {
      conflictingForkCommitCount: 2,
      conflictingFileCount: 2,
    });
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});
