it("the replay proof excludes start-empty commits and still refuses became-empty drops", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-empty-proof-"));
  try {
    git(root, ["init", "--quiet", "-b", "base"]);
    git(root, ["config", "user.name", "Test User"]);
    git(root, ["config", "user.email", "test@example.com"]);
    NodeFS.writeFileSync(NodePath.join(root, "shared.txt"), "one\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const baseSha = git(root, ["rev-parse", "HEAD"]);

    git(root, ["switch", "--quiet", "-c", "upstream-lane"]);
    NodeFS.writeFileSync(NodePath.join(root, "upstream.txt"), "upstream\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fix: upstream change"]);
    // dup.txt already holds this exact content upstream, so a fork commit writing it becomes
    // empty during the replay — but on the fork stack it starts non-empty (its parent lacks it).
    NodeFS.writeFileSync(NodePath.join(root, "dup.txt"), "same\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fix: upstream adds dup"]);
    const targetSha = git(root, ["rev-parse", "HEAD"]);

    git(root, ["switch", "--quiet", "-c", "fork-stack", "base"]);
    NodeFS.writeFileSync(NodePath.join(root, "fork.txt"), "fork\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feat(test): fork adds its own file"]);
    NodeFS.writeFileSync(NodePath.join(root, "dup.txt"), "same\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feat(test): fork mirrors dup"]);
    git(root, ["commit", "--allow-empty", "-m", "chore(fork): empty distribution"]);
    const withEmpty = git(root, ["rev-parse", "HEAD"]);
    assert.strictEqual(git(root, ["rev-list", "--count", `${baseSha}..${withEmpty}`]), "3");

    // The startup rebase drops the start-empty commit (`--no-keep-empty`) but keeps the
    // became-empty one (`--empty=keep`), so the replayed side holds two of the three commits.
    git(root, ["worktree", "add", "--detach", NodePath.join(root, "replay"), withEmpty]);
    const replay = NodePath.join(root, "replay");
    git(replay, [
      "-c",
      "rerere.enabled=false",
      "rebase",
      "--no-keep-empty",
      "--empty=keep",
      "--onto",
      targetSha,
      baseSha,
      withEmpty,
    ]);
    const newSha = git(replay, ["rev-parse", "HEAD"]);
    assert.strictEqual(git(replay, ["rev-list", "--count", `${targetSha}..${newSha}`]), "2");

    // The proof pairs with the rebase: expected 3 - 1 start-empty = 2, series matches.
    assert.strictEqual(
      verifyReplayShape(root, replay, withEmpty, baseSha, targetSha, newSha),
      "shared-install",
    );

    // A lane that dropped the became-empty commit too would hold one commit: the proof refuses —
    // retirement of a became-empty commit stays a human decision.
    git(replay, ["reset", "--hard", "HEAD~1"]);
    assert.throws(
      () =>
        verifyReplayShape(
          root,
          replay,
          withEmpty,
          baseSha,
          targetSha,
          git(replay, ["rev-parse", "HEAD"]),
        ),
      /replay commit count changed: 2 -> 1/,
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import "./lib/fork-test-quiet.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";

import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const verificationSpawns: Array<{
  command: string;
  args: ReadonlyArray<string>;
  cwd?: string;
}> = vi.hoisted(() => []);

// Record every non-git spawn so replay verification can be observed without running vp,
// while SystemGit and every fixture keeps using the real runner for git.
vi.mock("./lib/fork-command.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/fork-command.ts")>();
  return {
    ...actual,
    runCommand: (command: string, args: ReadonlyArray<string>, options: CommandOptions = {}) => {
      if (command !== "git") {
        verificationSpawns.push({
          command,
          args,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        });
        if (command === "vp" && args[0] === "i" && options.cwd !== undefined) {
          NodeFS.mkdirSync(NodePath.join(options.cwd, "node_modules", ".bin"), {
            recursive: true,
          });
          NodeFS.writeFileSync(NodePath.join(options.cwd, "node_modules", ".bin", "vp"), "");
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      return actual.runCommand(command, args, options);
    },
  };
});

import { findUpstreamReferences } from "./fork-upstream-refs.ts";
import type { CommandOptions } from "./lib/fork-command.ts";
import { buildBlockedIssue } from "./lib/fork-rebase-issues.ts";
import {
  encodeFeasibilityArtifact,
  parseFeasibilityArtifact,
} from "./lib/fork-feasibility-artifact.ts";
import { buildFeasibility, MergeTreeMemo } from "./lib/fork-rebase-feasibility.ts";
import { buildPushInvocation } from "./lib/fork-rebase-push.ts";
import { createRebasedStack, verifyReplayShape } from "./fork-auto-rebase-plan.ts";
import {
  autoFailureReason,
  buildAutoRebasePlan,
  executeAutoRebase,
  parseArgs,
  renderSummary,
  selectNewestTag,
  selectVerificationDependencySetup,
  SystemGit,
  UsageError,
  verificationLauncher,
  verifyReplay,
  verifyReplayMetadata,
  type PositionedTag,
} from "./fork-auto-rebase.ts";

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();

it("parses bot modes and output flags", () => {
  assert.deepStrictEqual(
    parseArgs([
      "--mode",
      "on",
      "--fetch",
      "--target",
      "v1.2.3",
      "--dry-run",
      "--github-output",
      "--summary",
      "summary.md",
      "--issue-json",
      "issues.json",
    ]),
    {
      mode: "on",
      fetch: true,
      target: "v1.2.3",
      dryRun: true,
      githubOutput: true,
      summary: "summary.md",
      issueJson: "issues.json",
      feasibility: null,
    },
  );
  assert.throws(() => parseArgs(["--mode", "maybe"]), UsageError);
  assert.throws(() => parseArgs(["--fetch", "--fetch"]), UsageError);
});

it("bounds the auto-rebase failure reason deterministically", () => {
  // Machine-dependent text never reaches the stored receipt: the root and temporary
  // worktrees are stripped, whitespace collapses, and the reason is bounded
  // (RSI-Software/t3code-hyprws#1018, RSI-Software/t3code-hyprws#1012).
  const root = "/repository/checkout";
  const reason = autoFailureReason(
    root,
    new Error(
      `leased push failed at ${root}/lane pid 12345\n  /tmp/fork-rebase-census-abc123 Steele\nsecond   line`,
    ),
  );
  assert.strictEqual(
    reason,
    "leased push failed at <repository>/lane pid 12345 <temporary-worktree> Steele second line",
  );
  assert.isTrue(reason.length <= 500);
  assert.strictEqual(autoFailureReason(root, new Error("")), "unknown auto-rebase failure");
});

it("keeps push authentication in git config environment variables", () => {
  const token = "ghs_EXAMPLE-token-123";
  const invocation = buildPushInvocation(["origin", "hyprws"], token, { PATH: "/bin" });
  const encodedCredentials = Buffer.from(`x-access-token:${token}`).toString("base64");

  assert.deepStrictEqual(invocation.args, ["push", "origin", "hyprws"]);
  assert.notInclude(JSON.stringify(invocation.args), token);
  assert.notInclude(JSON.stringify(invocation.args), encodedCredentials);
  assert.notInclude(JSON.stringify(invocation.args), "extraheader");
  assert.deepStrictEqual(invocation.env, {
    PATH: "/bin",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encodedCredentials}`,
  });
});

it("selects the latest clean position and prefers a stable tag on a tie", () => {
  const tag = (name: string, position: number, stable: boolean): PositionedTag => ({
    tag: name,
    position,
    stable,
    sha: String(position).repeat(40).slice(0, 40),
  });
  assert.strictEqual(
    selectNewestTag([
      tag("v1.0.0", 1, true),
      tag("v1.1.0-nightly.20260828.1", 2, false),
      tag("v1.1.0", 2, true),
    ])?.tag,
    "v1.1.0",
  );
  assert.strictEqual(selectNewestTag([]), null);
});

it("accepts git's own message cleanup on replay but not an edited line", () => {
  assert.doesNotThrow(() => verifyReplayMetadata(2, 2, "same\n", "same\n"));
  assert.throws(() => verifyReplayMetadata(2, 1, "same", "same"), /commit count changed/);

  // The two rewrites `git rebase` applies to a stored message: a `%B` captured without its
  // trailing newline comes back with one, and a blank run before the trailers collapses.
  const driftedOriginal =
    "feat(web): add sidebar group membership actions\nFork-Domain: project-windows\nFork-Tier: core" +
    "\x1e\n" +
    "fix(server): reconcile managed sessions after branch changes\n\n\nFork-Domain: fork-meta\nFork-Tier: bugfix\n" +
    "\x1e";
  const cleanedReplay =
    "feat(web): add sidebar group membership actions\nFork-Domain: project-windows\nFork-Tier: core\n" +
    "\x1e\n" +
    "fix(server): reconcile managed sessions after branch changes\n\nFork-Domain: fork-meta\nFork-Tier: bugfix\n" +
    "\x1e";
  assert.doesNotThrow(() => verifyReplayMetadata(2, 2, driftedOriginal, cleanedReplay));

  // Normalization moves whitespace only: a trailer whose value changed is still a change.
  assert.throws(
    () =>
      verifyReplayMetadata(
        2,
        2,
        driftedOriginal,
        cleanedReplay.replace("Fork-Tier: bugfix", "Fork-Tier: core"),
      ),
    /commit messages changed/,
  );
  assert.throws(
    () =>
      verifyReplayMetadata(
        2,
        2,
        driftedOriginal,
        cleanedReplay.replace(
          "feat(web): add sidebar group membership actions",
          "feat(web): add sidebar group membership",
        ),
      ),
    /commit messages changed/,
  );

  const original = `feat: preserve the body

## Intent
The behavior remains replayable.

Fork-Domain: fork-meta
Fork-Tier: qol
\x1e`;
  const commentLinesStripped = `feat: preserve the body

The behavior remains replayable.

Fork-Domain: fork-meta
Fork-Tier: qol
\x1e`;
  assert.throws(
    () => verifyReplayMetadata(1, 1, original, commentLinesStripped),
    /commit messages changed/,
  );

  // The failure names the first offending record: index, subject, and first differing line.
  const twoCommitOriginal = `${driftedOriginal}feat: third commit stays clean\n\nFork-Domain: fork-meta\nFork-Tier: qol\n\x1e`;
  const twoCommitReplayed = twoCommitOriginal.replace("Fork-Tier: bugfix", "Fork-Tier: core");
  try {
    verifyReplayMetadata(3, 3, twoCommitOriginal, twoCommitReplayed);
    assert.fail("expected replay message mismatch to throw");
  } catch (error) {
    assert.match(String(error), /commit messages changed/);
    assert.match(
      String(error),
      /commit 1: fix\(server\): reconcile managed sessions after branch changes/,
    );
    assert.match(String(error), /"Fork-Tier: bugfix" -> "Fork-Tier: core"/);
  }

  // The gained-line direction: the original is a matching prefix of the replayed message, so
  // scanning the original alone finds no differing index. The message must still name both sides.
  const gainedLineReplay = twoCommitOriginal.replace(
    "Fork-Tier: bugfix\n\x1e",
    "Fork-Tier: bugfix\na stray line appeared\n\x1e",
  );
  try {
    verifyReplayMetadata(3, 3, twoCommitOriginal, gainedLineReplay);
    assert.fail("expected replay message mismatch to throw");
  } catch (error) {
    assert.match(String(error), /commit messages changed/);
    assert.match(String(error), /"\(absent\)" -> "a stray line appeared"/);
  }
});

interface Fixture {
  readonly container: string;
  readonly root: string;
  readonly remote: string;
  readonly pushLog: string;
  readonly base: string;
  readonly stable: string;
  readonly cleanNightly: string;
  readonly conflict: string;
  readonly fork: string;
}

const commit = (root: string, subject: string): string => {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", subject]);
  return git(root, ["rev-parse", "HEAD"]);
};

// The five-commit history with tags, hook and pushed refs is built once; each test
// copies the seeded container so fixture construction stops dominating the file.
let seededContainer: Fixture | null = null;

const seedRepository = (): Fixture => {
  const container = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-auto-rebase-test-"));
  const root = NodePath.join(container, "work");
  const remote = NodePath.join(container, "origin.git");
  const pushLog = NodePath.join(remote, "push-order.log");
  NodeFS.mkdirSync(root);
  NodeFS.mkdirSync(remote);
  git(root, ["init", "-b", "base"]);
  git(remote, ["init", "--bare"]);
  git(root, ["remote", "add", "origin", remote]);
  const hook = NodePath.join(remote, "hooks/post-receive");
  NodeFS.writeFileSync(
    hook,
    `#!/bin/sh\nwhile read old new ref; do printf '%s\\n' "$ref" >> ${JSON.stringify(pushLog)}; done\n`,
  );
  NodeFS.chmodSync(hook, 0o755);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  NodeFS.writeFileSync(NodePath.join(root, "shared.txt"), "first\nshared\nthird\n");
  const base = commit(root, "base");
  git(root, ["tag", "v0.9.0"]);
  git(root, ["branch", "fork-stack"]);

  git(root, ["switch", "-c", "upstream-lane"]);
  NodeFS.writeFileSync(NodePath.join(root, "stable.txt"), "stable\n");
  const stable = commit(root, "feat: stable upstream release");
  git(root, ["tag", "v1.0.0"]);
  NodeFS.writeFileSync(NodePath.join(root, "nightly.txt"), "nightly\n");
  const cleanNightly = commit(root, "fix: clean nightly change");
  git(root, ["tag", "v1.1.0-nightly.20260828.1208"]);
  NodeFS.writeFileSync(NodePath.join(root, "shared.txt"), "first\nupstream\nthird\n");
  const conflict = commit(root, "fix: blocking upstream change (#8483)");
  git(root, ["tag", "v1.1.0-nightly.20260828.1209"]);
  git(root, ["update-ref", "refs/remotes/upstream/main", conflict]);

  git(root, ["switch", "fork-stack"]);
  NodeFS.writeFileSync(NodePath.join(root, "shared.txt"), "first\nfork\nthird\n");
  git(root, ["add", "shared.txt"]);
  git(root, [
    "commit",
    "-m",
    "feat(test): fork stack change",
    "-m",
    "Fork-Domain: fork-meta\nFork-Tier: qol",
  ]);
  const fork = git(root, ["rev-parse", "HEAD"]);
  git(root, [
    "push",
    "origin",
    `${base}:refs/heads/main`,
    `${fork}:refs/heads/hyprws`,
    `${base}:refs/tags/v0.9.0-hyprws.1`,
    `${conflict}:refs/internal/upstream`,
  ]);
  git(root, ["update-ref", "refs/remotes/origin/hyprws", fork]);
  NodeFS.writeFileSync(pushLog, "");
  return { container, root, remote, pushLog, base, stable, cleanNightly, conflict, fork };
};

const fixtureRepository = (): Fixture => {
  if (seededContainer === null) seededContainer = seedRepository();
  const container = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-auto-rebase-test-"));
  NodeFS.cpSync(seededContainer.container, container, { recursive: true });
  const root = NodePath.join(container, "work");
  const remote = NodePath.join(container, "origin.git");
  const pushLog = NodePath.join(remote, "push-order.log");
  // The copy carries the seed's absolute paths: rebind the origin URL and the
  // hook's hardcoded pushLog path to this container. Refs, hooks and remote
  // state come along and stay per-test.
  git(root, ["remote", "set-url", "origin", remote]);
  const hook = NodePath.join(remote, "hooks/post-receive");
  NodeFS.writeFileSync(
    hook,
    `#!/bin/sh\nwhile read old new ref; do printf '%s\\n' "$ref" >> ${JSON.stringify(pushLog)}; done\n`,
  );
  NodeFS.chmodSync(hook, 0o755);
  return {
    container,
    root,
    remote,
    pushLog,
    base: seededContainer.base,
    stable: seededContainer.stable,
    cleanNightly: seededContainer.cleanNightly,
    conflict: seededContainer.conflict,
    fork: seededContainer.fork,
  };
};

interface ManualApplyFixture extends Fixture {
  readonly manualHead: string;
}

const manualApplyFixture = (): ManualApplyFixture => {
  const fixture = fixtureRepository();
  git(fixture.root, ["switch", "fork-stack"]);
  git(fixture.root, ["rebase", "--onto", fixture.stable, fixture.base]);
  NodeFS.writeFileSync(NodePath.join(fixture.root, "nightly.txt"), "fork\n");
  const manualHead = commit(fixture.root, "fix(test): resolve the stable apply");
  git(fixture.root, [
    "push",
    "--force-with-lease=refs/heads/hyprws:" + fixture.fork,
    "origin",
    `${manualHead}:refs/heads/hyprws`,
  ]);
  git(fixture.root, ["update-ref", "refs/remotes/origin/hyprws", manualHead]);
  NodeFS.writeFileSync(fixture.pushLog, "");
  return { ...fixture, manualHead };
};

const dryRunOptions = {
  mode: "candidate" as const,
  fetch: false,
  target: null,
  dryRun: true,
  githubOutput: false,
  summary: null,
  issueJson: null,
  feasibility: null,
};

it("selects dependency setup from shared-base-to-target manifest changes", () => {
  const fixture = fixtureRepository();
  try {
    const reader = new SystemGit(fixture.root);
    assert.strictEqual(
      selectVerificationDependencySetup(reader, fixture.base, fixture.cleanNightly),
      "shared-install",
    );

    git(fixture.root, ["switch", "--detach", fixture.cleanNightly]);
    NodeFS.writeFileSync(NodePath.join(fixture.root, "package.json"), '{"private":true}\n');
    const manifestTarget = commit(fixture.root, "build: change upstream manifest");
    assert.strictEqual(
      selectVerificationDependencySetup(reader, fixture.base, manifestTarget),
      "fresh-install",
    );
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("selects fresh install when only pnpm-workspace.yaml changes", () => {
  const fixture = fixtureRepository();
  try {
    const reader = new SystemGit(fixture.root);
    git(fixture.root, ["switch", "--detach", fixture.cleanNightly]);
    NodeFS.writeFileSync(
      NodePath.join(fixture.root, "pnpm-workspace.yaml"),
      "onlyBuiltDependencies:\n  - esbuild\n",
    );
    const workspaceTarget = commit(fixture.root, "build: change upstream workspace config");
    assert.strictEqual(
      selectVerificationDependencySetup(reader, fixture.base, workspaceTarget),
      "fresh-install",
    );
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("plans a no-op at the base and rejects an override beyond the clean window", () => {
  const fixture = fixtureRepository();
  try {
    const reader = new SystemGit(fixture.root);
    const noOp = buildAutoRebasePlan(reader, fixture.fork, "v0.9.0");
    const result = executeAutoRebase(fixture.root, dryRunOptions, noOp, () => "shared-install");
    assert.strictEqual(noOp.target?.sha, fixture.base);
    assert.strictEqual(result.status, "no-op");
    assert.strictEqual(result.newSha, null);
    // On the walk but past the clean fast-forward boundary: position, clean count,
    // boundary commit, and the omit --target escape hatch.
    assert.throws(
      () => buildAutoRebasePlan(reader, fixture.fork, "v1.1.0-nightly.20260828.1209"),
      UsageError,
      /^--target v1\.1\.0-nightly\.20260828\.1209 is past the clean fast-forward boundary \(position 3, 2 clean commits, boundary [0-9a-f]+ fix: blocking upstream change \(#8483\)\); omit --target to stop at the newest clean tag$/,
    );
    assert.throws(() => buildAutoRebasePlan(reader, fixture.fork, fixture.stable), UsageError);
    // A real upstream commit that is not on the first-parent walk from the merge base.
    git(fixture.root, ["switch", "-c", "upstream-side", fixture.base]);
    NodeFS.writeFileSync(NodePath.join(fixture.root, "side.txt"), "side\n");
    const side = commit(fixture.root, "feat: side upstream commit");
    git(fixture.root, ["tag", "v1.2.0-nightly.20260828.1210", side]);
    git(fixture.root, ["switch", "fork-stack"]);
    assert.throws(
      () => buildAutoRebasePlan(reader, fixture.fork, "v1.2.0-nightly.20260828.1210"),
      UsageError,
      /--target is not on the upstream first-parent walk from the merge base: v1\.2\.0-nightly\.20260828\.1210/,
    );
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

// The report job walks the same source and base an hour before the rebase job does;
// these two cover what the rebase job may take from it and what it must redo.
const carriedArtifactFor = (fixture: Fixture, targetSha: string) => {
  const reader = new SystemGit(fixture.root);
  const baseSha = reader.run(["merge-base", fixture.fork, "upstream/main"]).trim();
  const memo = new MergeTreeMemo();
  const feasibility = buildFeasibility(reader, fixture.fork, targetSha, baseSha, memo);
  return parseFeasibilityArtifact(
    encodeFeasibilityArtifact(
      "vp run fork:rebase-report",
      { sourceSha: fixture.fork, targetSha, baseSha },
      feasibility,
      memo,
    ),
  );
};

it("carries a feasibility walk computed against the same three shas", () => {
  const fixture = fixtureRepository();
  try {
    const reader = new SystemGit(fixture.root);
    const walked = buildAutoRebasePlan(reader, fixture.fork, null);
    const carried = buildAutoRebasePlan(
      reader,
      fixture.fork,
      null,
      carriedArtifactFor(fixture, walked.horizon?.sha ?? walked.baseSha),
    );
    assert.deepStrictEqual(carried.feasibility, walked.feasibility);
    assert.deepStrictEqual(carried.target, walked.target);
    assert.strictEqual(carried.feasibilitySource.carried, true);
    assert.strictEqual(carried.feasibilitySource.refusal, null);
    assert.strictEqual(carried.feasibilitySource.mergesComputed, 0);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("refuses a feasibility walk whose target moved and recomputes the same result", () => {
  const fixture = fixtureRepository();
  try {
    const reader = new SystemGit(fixture.root);
    const walked = buildAutoRebasePlan(reader, fixture.fork, null);
    // The stable tag is a real upstream commit, just not the one the plan targets.
    const stale = buildAutoRebasePlan(
      reader,
      fixture.fork,
      null,
      carriedArtifactFor(fixture, fixture.stable),
    );
    assert.strictEqual(stale.feasibilitySource.carried, false);
    assert.match(
      stale.feasibilitySource.refusal ?? "",
      /^targetSha [0-9a-f]{12} is now [0-9a-f]{12}$/,
    );
    assert.deepStrictEqual(stale.feasibility, walked.feasibility);
    assert.deepStrictEqual(stale.target, walked.target);
    // Every merge is addressed by its two commits, so the refused artifact still pays
    // for the merges both walks share.
    assert.ok(stale.feasibilitySource.mergesCarried > 0);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

// The report job writes its merge trees into its own object store, so the rebase job
// holds those ids without the objects (RSI-Software/t3code-hyprws#1009).
it("re-walks a carried merge whose tree this object store cannot read", () => {
  const fixture = fixtureRepository();
  try {
    const reader = new SystemGit(fixture.root);
    const walked = buildAutoRebasePlan(reader, fixture.fork, null);
    assert.ok(walked.feasibility.conflicts.length > 0, "the walk must read merged content");
    const artifact = carriedArtifactFor(fixture, walked.horizon?.sha ?? walked.baseSha);
    const absent = "c6344b641a87c3594d4f9ec5061775c1b649c294";
    assert.notStrictEqual(reader.runResult(["cat-file", "-e", absent]).status, 0);
    const unreadable = buildAutoRebasePlan(reader, fixture.fork, null, {
      ...artifact,
      // A moved base refuses the finished walk and leaves the memo, which is the shape
      // the rebase job sees whenever the report job walked a different window.
      baseSha: fixture.stable,
      mergeTree: artifact.mergeTree.map((entry) => ({ ...entry, tree: absent })),
    });
    assert.strictEqual(unreadable.feasibilitySource.carried, false);
    assert.deepStrictEqual(unreadable.feasibility, walked.feasibility);
    assert.strictEqual(unreadable.feasibilitySource.mergesRewalked, 1);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("ignores an untagged conflict beyond the newest upstream tag", () => {
  const fixture = fixtureRepository();
  try {
    git(fixture.root, ["tag", "--delete", "v1.1.0-nightly.20260828.1209"]);
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.fork, null);
    assert.strictEqual(plan.horizon?.tag, "v1.1.0-nightly.20260828.1208");
    assert.strictEqual(plan.target?.sha, fixture.cleanNightly);
    assert.strictEqual(plan.feasibility.ffBoundary.firstConflict, null);

    const result = executeAutoRebase(fixture.root, dryRunOptions, plan, () => "shared-install");
    assert.strictEqual(result.status, "advanced");
    assert.strictEqual(result.blocked, null);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("reports a conflict before the newest upstream tag in that tag's context", () => {
  const fixture = fixtureRepository();
  try {
    git(fixture.root, ["switch", "upstream-lane"]);
    NodeFS.writeFileSync(NodePath.join(fixture.root, "after-conflict.txt"), "tagged horizon\n");
    const horizon = commit(fixture.root, "feat: tagged horizon after conflict");
    git(fixture.root, ["tag", "v1.2.0-nightly.20260828.1210"]);
    git(fixture.root, ["update-ref", "refs/remotes/upstream/main", horizon]);

    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.fork, null);
    assert.strictEqual(plan.horizon?.sha, horizon);
    assert.strictEqual(plan.feasibility.ffBoundary.firstConflict?.sha, fixture.conflict);
    assert.strictEqual(plan.newestTagBeyondWindow?.tag, "v1.2.0-nightly.20260828.1210");
    assert.strictEqual(
      buildBlockedIssue(plan)?.newestUpstreamTagBeyondWindow,
      "v1.2.0-nightly.20260828.1210",
    );
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("returns a no-op when no upstream tag exists in the scan window", () => {
  const fixture = fixtureRepository();
  try {
    for (const tag of [
      "v0.9.0",
      "v1.0.0",
      "v1.1.0-nightly.20260828.1208",
      "v1.1.0-nightly.20260828.1209",
    ]) {
      git(fixture.root, ["tag", "--delete", tag]);
    }
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.fork, null);
    assert.strictEqual(plan.horizon, null);
    assert.strictEqual(plan.target, null);
    assert.strictEqual(plan.feasibility.ffBoundary.upstreamCommitCount, 0);

    const result = executeAutoRebase(fixture.root, dryRunOptions, plan, () => "shared-install");
    assert.strictEqual(result.status, "no-op");
    assert.strictEqual(result.blocked, null);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

// The suite runs quiet; these two turn that off for their own scope, because what they
// assert on is the operator's stream.
const spoken = (quiet: boolean, run: () => void): Array<string> => {
  const lines: Array<string> = [];
  const original = process.stderr.write.bind(process.stderr);
  const previous = process.env.FORK_QUIET;
  if (quiet) process.env.FORK_QUIET = "1";
  else delete process.env.FORK_QUIET;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
    if (previous === undefined) delete process.env.FORK_QUIET;
    else process.env.FORK_QUIET = previous;
  }
  return lines;
};

it("counts the feasibility walk's two loops on the operator's stream", () => {
  const fixture = fixtureRepository();
  const reader = new SystemGit(fixture.root);
  const baseSha = reader.run(["merge-base", fixture.fork, "upstream/main"]).trim();
  const walk = (): void => {
    buildFeasibility(reader, fixture.fork, fixture.conflict, baseSha);
  };
  try {
    const lines = spoken(false, walk);
    assert.isTrue(lines.some((line) => /^feasibility: upstream \d+\/\d+\n$/.test(line)));
    assert.isTrue(lines.some((line) => /^feasibility: fork \d+\/\d+\n$/.test(line)));
    assert.deepStrictEqual(spoken(true, walk), []);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

const remoteHeads = (fixture: Fixture): Readonly<Record<string, string>> =>
  Object.fromEntries(
    git(fixture.remote, [
      "for-each-ref",
      "--format=%(refname:strip=2)%09%(objectname)",
      "refs/heads",
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name = "", sha = ""] = line.split("\t");
        return [name, sha];
      }),
  );

const pushOrder = (fixture: Fixture): ReadonlyArray<string> =>
  NodeFS.readFileSync(fixture.pushLog, "utf8").split("\n").filter(Boolean);

const options = (mode: "off" | "candidate" | "on", dryRun = false) => ({
  ...dryRunOptions,
  mode,
  dryRun,
});

it("does not snapshot a crossed stable tag that was already published", () => {
  const fixture = fixtureRepository();
  try {
    git(fixture.remote, ["update-ref", "refs/tags/v1.0.0-hyprws.1", fixture.stable]);
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.fork, null);
    assert.strictEqual(plan.target?.sha, fixture.cleanNightly);
    assert.deepStrictEqual(plan.stableTags, []);

    const result = executeAutoRebase(fixture.root, dryRunOptions, plan, () => "shared-install");
    assert.deepStrictEqual(result.stableCandidates, []);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("creates the stable snapshot at the trunk head after a manual apply", () => {
  const fixture = manualApplyFixture();
  try {
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.manualHead, null);
    assert.strictEqual(plan.target?.tag, "v1.0.0");
    assert.deepStrictEqual(
      plan.stableTags.map(({ tag, position }) => ({ tag, position })),
      [{ tag: "v1.0.0", position: 0 }],
    );

    const result = executeAutoRebase(fixture.root, options("on"), plan, () => "shared-install");
    assert.strictEqual(result.status, "no-op");
    assert.strictEqual(result.newSha, null);
    assert.strictEqual(result.blocked?.blockingSha, fixture.cleanNightly);
    assert.deepStrictEqual(
      result.stableCandidates.map(({ tag, branch, sha }) => ({ tag, branch, sha })),
      [
        {
          tag: "v1.0.0",
          branch: "release/v1.0.0-hyprws",
          sha: fixture.manualHead,
        },
      ],
    );
    assert.strictEqual(remoteHeads(fixture)["release/v1.0.0-hyprws"], fixture.manualHead);
    assert.deepStrictEqual(pushOrder(fixture), ["refs/heads/release/v1.0.0-hyprws"]);
    assert.include(renderSummary(result), "Push ordering: create-only release/*");
    assert.include(
      renderSummary(result),
      `- Created snapshot: \`release/v1.0.0-hyprws\` at \`${fixture.manualHead}\``,
    );
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("a manual-apply dry run leaves every remote ref untouched", () => {
  const fixture = manualApplyFixture();
  try {
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.manualHead, null);
    const before = remoteHeads(fixture);
    const result = executeAutoRebase(
      fixture.root,
      options("on", true),
      plan,
      () => "shared-install",
    );
    assert.deepStrictEqual(
      result.stableCandidates.map(({ tag }) => tag),
      ["v1.0.0"],
    );
    assert.deepStrictEqual(remoteHeads(fixture), before);
    assert.deepStrictEqual(pushOrder(fixture), []);
    assert.include(
      renderSummary(result),
      `- Snapshot pending: \`release/v1.0.0-hyprws\` at \`${fixture.manualHead}\``,
    );
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("skips a base stable snapshot created after planning", () => {
  const fixture = manualApplyFixture();
  try {
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.manualHead, null);
    assert.deepStrictEqual(
      plan.stableTags.map(({ tag }) => tag),
      ["v1.0.0"],
    );
    git(fixture.remote, ["update-ref", "refs/heads/release/v1.0.0-hyprws", fixture.manualHead]);
    NodeFS.writeFileSync(fixture.pushLog, "");

    const result = executeAutoRebase(fixture.root, options("on"), plan, () => "shared-install");
    assert.deepStrictEqual(result.stableCandidates, []);
    assert.deepStrictEqual(pushOrder(fixture), []);
    assert.strictEqual(result.blocked?.blockingSha, fixture.cleanNightly);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("does not recreate a base stable snapshot that already exists", () => {
  const fixture = manualApplyFixture();
  try {
    git(fixture.remote, ["update-ref", "refs/heads/release/v1.0.0-hyprws", fixture.manualHead]);
    NodeFS.writeFileSync(fixture.pushLog, "");
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.manualHead, null);
    assert.deepStrictEqual(plan.stableTags, []);

    const result = executeAutoRebase(fixture.root, options("on"), plan, () => "shared-install");
    assert.deepStrictEqual(result.stableCandidates, []);
    assert.deepStrictEqual(pushOrder(fixture), []);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("does not snapshot a base stable tag that was already published", () => {
  const fixture = manualApplyFixture();
  try {
    git(fixture.remote, ["update-ref", "refs/tags/v1.0.0-hyprws.1", fixture.manualHead]);
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.manualHead, null);
    assert.deepStrictEqual(plan.stableTags, []);

    const result = executeAutoRebase(fixture.root, options("on"), plan, () => "shared-install");
    assert.deepStrictEqual(result.stableCandidates, []);
    assert.deepStrictEqual(pushOrder(fixture), []);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("off and dry-run modes leave every bare-remote ref untouched", () => {
  const fixture = fixtureRepository();
  try {
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.fork, null);
    const before = remoteHeads(fixture);
    executeAutoRebase(fixture.root, options("off"), plan, () => "shared-install");
    executeAutoRebase(fixture.root, options("candidate", true), plan, () => "shared-install");
    assert.deepStrictEqual(remoteHeads(fixture), before);
    assert.deepStrictEqual(pushOrder(fixture), []);
    assert.strictEqual(remoteHeads(fixture).main, fixture.base);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("candidate pushes create-only releases before hyprws-next and never changes main", () => {
  const fixture = fixtureRepository();
  try {
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.fork, null);
    const result = executeAutoRebase(
      fixture.root,
      options("candidate"),
      plan,
      () => "shared-install",
    );
    assert.deepStrictEqual(Object.keys(remoteHeads(fixture)).toSorted(), [
      "hyprws",
      "hyprws-next",
      "main",
      "release/v1.0.0-hyprws",
    ]);
    assert.strictEqual(remoteHeads(fixture).hyprws, fixture.fork);
    assert.strictEqual(remoteHeads(fixture).main, fixture.base);
    assert.strictEqual(remoteHeads(fixture)["hyprws-next"], result.newSha);
    assert.deepStrictEqual(pushOrder(fixture), [
      "refs/heads/release/v1.0.0-hyprws",
      "refs/heads/hyprws-next",
    ]);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("on pushes snapshots, previous, then the leased trunk without changing main", () => {
  const fixture = fixtureRepository();
  try {
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.fork, null);
    const result = executeAutoRebase(fixture.root, options("on"), plan, () => "shared-install");
    assert.strictEqual(remoteHeads(fixture).main, fixture.base);
    assert.strictEqual(remoteHeads(fixture)["hyprws-previous"], fixture.fork);
    assert.strictEqual(remoteHeads(fixture).hyprws, result.newSha);
    assert.strictEqual(remoteHeads(fixture)["hyprws-next"], undefined);
    assert.deepStrictEqual(pushOrder(fixture), [
      "refs/heads/release/v1.0.0-hyprws",
      "refs/heads/hyprws-previous",
      "refs/heads/hyprws",
    ]);
    assert.include(
      renderSummary(result),
      "a lease failure rolls back snapshots and hyprws-previous",
    );
    assert.include(renderSummary(result), "Dependency setup: shared-install");
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("a lease race restores previous and snapshots while preserving the racing trunk", () => {
  const fixture = fixtureRepository();
  try {
    git(fixture.remote, ["update-ref", "refs/heads/hyprws-previous", fixture.base]);
    NodeFS.writeFileSync(fixture.pushLog, "");
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.fork, null);
    assert.throws(
      () =>
        executeAutoRebase(fixture.root, options("on"), plan, () => "shared-install", {
          beforeHyprwsPush: () =>
            void git(fixture.remote, [
              "update-ref",
              "refs/heads/hyprws",
              fixture.stable,
              fixture.fork,
            ]),
        }),
      /leased push hyprws failed/,
    );
    assert.deepStrictEqual(remoteHeads(fixture), {
      hyprws: fixture.stable,
      "hyprws-previous": fixture.base,
      main: fixture.base,
    });
    assert.strictEqual(remoteHeads(fixture)["release/v1.0.0-hyprws"], undefined);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("refuses an existing create-only release before changing any remote ref", () => {
  const fixture = fixtureRepository();
  try {
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.fork, null);
    git(fixture.remote, ["update-ref", "refs/heads/release/v1.0.0-hyprws", fixture.stable]);
    NodeFS.writeFileSync(fixture.pushLog, "");
    const before = remoteHeads(fixture);
    assert.throws(
      () => executeAutoRebase(fixture.root, options("candidate"), plan, () => "shared-install"),
      /refusing to replace create-only branch/,
    );
    assert.deepStrictEqual(remoteHeads(fixture), before);
    assert.deepStrictEqual(pushOrder(fixture), []);
    assert.strictEqual(remoteHeads(fixture).main, fixture.base);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

const replayWorktree = (fixture: Fixture, target: string): { worktree: string; head: string } => {
  const worktree = NodePath.join(fixture.container, "replay");
  git(fixture.root, ["worktree", "add", "--detach", worktree, fixture.fork]);
  git(worktree, [
    "-c",
    "rerere.enabled=false",
    "rebase",
    "--onto",
    target,
    fixture.base,
    fixture.fork,
  ]);
  return { worktree, head: git(worktree, ["rev-parse", "HEAD"]) };
};

it("resolves the replay worktree's own vp launcher, not the root's and not bare vp", () => {
  const worktree = NodePath.join(NodeOS.tmpdir(), "some-replay-worktree");
  const launcher = verificationLauncher(worktree);
  assert.strictEqual(launcher, NodePath.join(worktree, "node_modules", ".bin", "vp"));
  assert.strictEqual(NodePath.isAbsolute(launcher), true);
  assert.notStrictEqual(launcher, "vp");
  assert.notStrictEqual(launcher, NodePath.join(process.cwd(), "node_modules", ".bin", "vp"));
});

it("spawns the four replay verification commands through the worktree's own vp launcher", () => {
  const fixture = fixtureRepository();
  const { worktree, head } = replayWorktree(fixture, fixture.base);
  try {
    NodeFS.mkdirSync(NodePath.join(worktree, "node_modules", ".bin"), { recursive: true });
    const launcher = NodePath.join(worktree, "node_modules", ".bin", "vp");
    NodeFS.writeFileSync(launcher, "");
    verificationSpawns.length = 0;
    assert.strictEqual(
      verifyReplay(fixture.root, worktree, fixture.fork, fixture.base, fixture.base, head),
      "shared-install",
    );
    const spawns = verificationSpawns.filter((spawn) => spawn.command !== "git");
    assert.deepStrictEqual(
      spawns.map((spawn) => [spawn.command, [...spawn.args]]),
      [
        [launcher, ["run", "fork:delta", "--check"]],
        [launcher, ["check"]],
        [launcher, ["run", "typecheck"]],
        [launcher, ["run", "test"]],
      ],
    );
    assert.deepStrictEqual(new Set(spawns.map((spawn) => spawn.cwd)), new Set([worktree]));
  } finally {
    git(fixture.root, ["worktree", "remove", "--force", worktree]);
    git(fixture.root, ["worktree", "prune"]);
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("still installs with a bare vp on the fresh-install path before using the local launcher", () => {
  const fixture = fixtureRepository();
  git(fixture.root, ["switch", "--detach", fixture.base]);
  NodeFS.writeFileSync(NodePath.join(fixture.root, "package.json"), '{"private":true}\n');
  const manifestTarget = commit(fixture.root, "build: change upstream manifest");
  const { worktree, head } = replayWorktree(fixture, manifestTarget);
  try {
    verificationSpawns.length = 0;
    assert.strictEqual(
      verifyReplay(fixture.root, worktree, fixture.fork, fixture.base, manifestTarget, head),
      "fresh-install",
    );
    const launcher = NodePath.join(worktree, "node_modules", ".bin", "vp");
    const spawns = verificationSpawns.filter((spawn) => spawn.command !== "git");
    assert.deepStrictEqual(spawns[0], { command: "vp", args: ["i"], cwd: worktree });
    assert.deepStrictEqual(
      spawns.slice(1).map((spawn) => [spawn.command, [...spawn.args]]),
      [
        [launcher, ["run", "fork:delta", "--check"]],
        [launcher, ["check"]],
        [launcher, ["run", "typecheck"]],
        [launcher, ["run", "test"]],
      ],
    );
  } finally {
    git(fixture.root, ["worktree", "remove", "--force", worktree]);
    git(fixture.root, ["worktree", "prune"]);
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("raises instead of falling back to bare vp when the replay worktree has no launcher", () => {
  const fixture = fixtureRepository();
  const { worktree, head } = replayWorktree(fixture, fixture.base);
  try {
    verificationSpawns.length = 0;
    assert.throws(
      () => verifyReplay(fixture.root, worktree, fixture.fork, fixture.base, fixture.base, head),
      /verification launcher missing after install/,
    );
    const spawns = verificationSpawns.filter((spawn) => spawn.command !== "git");
    assert.deepStrictEqual(spawns, []);
  } finally {
    git(fixture.root, ["worktree", "remove", "--force", worktree]);
    git(fixture.root, ["worktree", "prune"]);
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("drops a commit that starts empty from the clean-replay stack", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-empty-replay-"));
  try {
    git(root, ["init", "--quiet", "-b", "base"]);
    git(root, ["config", "user.name", "Test User"]);
    git(root, ["config", "user.email", "test@example.com"]);
    NodeFS.writeFileSync(NodePath.join(root, "shared.txt"), "one\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const baseSha = git(root, ["rev-parse", "HEAD"]);

    git(root, ["switch", "--quiet", "-c", "upstream-lane"]);
    NodeFS.writeFileSync(NodePath.join(root, "upstream.txt"), "upstream\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fix: upstream change"]);
    const targetSha = git(root, ["rev-parse", "HEAD"]);

    git(root, ["switch", "--quiet", "-c", "fork-stack", "base"]);
    NodeFS.writeFileSync(NodePath.join(root, "fork.txt"), "fork\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feat(test): fork adds its own file"]);
    git(root, ["commit", "--allow-empty", "-m", "chore(fork): empty replay"]);
    const withEmpty = git(root, ["rev-parse", "HEAD"]);
    assert.strictEqual(git(root, ["rev-list", "--count", `${baseSha}..${withEmpty}`]), "2");

    const replayed = createRebasedStack(
      root,
      withEmpty,
      baseSha,
      targetSha,
      () => "shared-install",
    );
    // Only the real fork commit replays; the start-empty commit is gone from the result.
    assert.strictEqual(git(root, ["rev-list", "--count", `${targetSha}..${replayed.sha}`]), "1");
    assert.strictEqual(
      git(root, ["log", "--format=%s", `${targetSha}..${replayed.sha}`]),
      "feat(test): fork adds its own file",
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
