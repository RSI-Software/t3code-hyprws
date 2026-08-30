// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { findUpstreamReferences } from "./fork-upstream-refs.ts";
import { buildBlockedIssue } from "./lib/fork-rebase-issues.ts";
import { buildPushInvocation } from "./lib/fork-rebase-push.ts";
import {
  buildAutoRebasePlan,
  executeAutoRebase,
  parseArgs,
  rehearseStopCensus,
  renderSummary,
  selectNewestTag,
  selectVerificationDependencySetup,
  SystemGit,
  UsageError,
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
    },
  );
  assert.throws(() => parseArgs(["--mode", "maybe"]), UsageError);
  assert.throws(() => parseArgs(["--fetch", "--fetch"]), UsageError);
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

it("verifies replay count and byte-identical subjects plus trailers", () => {
  assert.doesNotThrow(() => verifyReplayMetadata(2, 2, "same\n", "same\n"));
  assert.throws(() => verifyReplayMetadata(2, 1, "same", "same"), /commit count changed/);
  assert.throws(() => verifyReplayMetadata(2, 2, "first", "changed"), /trailers changed/);
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

const fixtureRepository = (): Fixture => {
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

it("plans a no-op at the base and rejects an override beyond the clean window", () => {
  const fixture = fixtureRepository();
  try {
    const reader = new SystemGit(fixture.root);
    const noOp = buildAutoRebasePlan(reader, fixture.fork, "v0.9.0");
    const result = executeAutoRebase(fixture.root, dryRunOptions, noOp, () => "shared-install");
    assert.strictEqual(noOp.target?.sha, fixture.base);
    assert.strictEqual(result.status, "no-op");
    assert.strictEqual(result.newSha, null);
    assert.throws(
      () => buildAutoRebasePlan(reader, fixture.fork, "v1.1.0-nightly.20260828.1209"),
      UsageError,
    );
    assert.throws(() => buildAutoRebasePlan(reader, fixture.fork, fixture.stable), UsageError);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("advances to the newest clean tag, reports the block, and enumerates stable snapshots", () => {
  const fixture = fixtureRepository();
  try {
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.fork, null);
    assert.strictEqual(plan.target?.tag, "v1.1.0-nightly.20260828.1208");
    assert.strictEqual(plan.target?.sha, fixture.cleanNightly);
    assert.strictEqual(plan.feasibility.ffBoundary.firstConflict?.sha, fixture.conflict);
    assert.strictEqual(plan.newestTagBeyondWindow?.tag, "v1.1.0-nightly.20260828.1209");
    assert.deepStrictEqual(
      plan.stableTags.map((tag) => tag.tag),
      ["v1.0.0"],
    );

    const stalePath = "already-resolved-by-the-advance.txt";
    const stalePlan = {
      ...plan,
      feasibility: {
        ...plan.feasibility,
        ffBoundary: {
          ...plan.feasibility.ffBoundary,
          firstConflict:
            plan.feasibility.ffBoundary.firstConflict === null
              ? null
              : {
                  ...plan.feasibility.ffBoundary.firstConflict,
                  sha: fixture.cleanNightly,
                  shortSha: fixture.cleanNightly.slice(0, 7),
                  subject: "stale pre-advance blocker",
                },
        },
        conflicts: [
          ...(plan.feasibility.conflicts[0] === undefined
            ? []
            : [{ ...plan.feasibility.conflicts[0], path: stalePath }]),
          ...plan.feasibility.conflicts,
        ],
      },
    };
    let censusHead = "";
    let censusBase = "";
    const result = executeAutoRebase(
      fixture.root,
      dryRunOptions,
      stalePlan,
      () => "shared-install",
      {
        rehearseStopCensus: (_root, headSha, baseSha, target) => {
          censusHead = headSha;
          censusBase = baseSha;
          return {
            targetTag: target.tag,
            conflictingForkCommitCount: 2,
            conflictingFileCount: 3,
            truncated: false,
            truncatedBy: null,
            stopLimit: 128,
            timeLimitSeconds: 360,
          };
        },
      },
    );
    assert.strictEqual(result.status, "advanced");
    assert.notStrictEqual(result.newSha, fixture.fork);
    assert.strictEqual(
      git(fixture.root, ["merge-base", result.newSha ?? "", fixture.cleanNightly]),
      fixture.cleanNightly,
    );
    assert.deepStrictEqual(
      result.stableCandidates.map(({ tag, branch }) => ({ tag, branch })),
      [{ tag: "v1.0.0", branch: "release/v1.0.0-hyprws" }],
    );
    assert.strictEqual(result.blocked?.blockingSha, fixture.conflict);
    assert.notStrictEqual(censusHead, fixture.fork);
    assert.strictEqual(censusHead, result.newSha);
    assert.strictEqual(censusBase, fixture.cleanNightly);
    assert.notInclude(result.blocked?.body ?? "", fixture.fork);
    assert.notInclude(result.blocked?.body ?? "", stalePath);
    assert.deepStrictEqual(result.blocked?.stopCensus, {
      targetTag: "v1.1.0-nightly.20260828.1209",
      conflictingForkCommitCount: 2,
      conflictingFileCount: 3,
      truncated: false,
      truncatedBy: null,
      stopLimit: 128,
      timeLimitSeconds: 360,
    });
    assert.include(
      result.blocked?.body ?? "",
      "## Sequential rebase census\n\nA throwaway rebase rehearsal to `v1.1.0-nightly.20260828.1209` found 2 conflicting fork commits and 3 conflict-file resolutions.",
    );
    assert.strictEqual(
      result.blocked?.title,
      `[📡#217] 🔔 hyprws auto-rebase is blocked at upstream ${fixture.conflict.slice(0, 7)}`,
    );
    assert.include(result.blocked?.body ?? "", `<!-- blocking-sha:${fixture.conflict} -->`);
    assert.notInclude(result.blocked?.body ?? "", "stale pre-advance blocker");
    assert.include(
      result.blocked?.body ?? "",
      `The fork stack advances to \`v1.1.0-nightly.20260828.1208\`, the newest clean upstream tag.\n1 upstream commit sits behind the blocking commit \`${fixture.conflict}\`.`,
    );
    assert.include(
      result.blocked?.body ?? "",
      "Parent: RSI-Software/t3code-hyprws#217\n\n<!-- gh-bot:relationships:start -->\nRelationships: none (`--no-relationship`).",
    );
    assert.strictEqual(result.blocked?.conflicts[0]?.domain, "fork-meta");
    assert.deepStrictEqual(result.verificationDependencySetup, ["shared-install"]);
    assert.include(
      result.stableCandidates[0]?.body ?? "",
      result.stableCandidates[0]?.marker ?? "",
    );
    assert.include(result.stableCandidates[0]?.body ?? "", "trunk has not adopted");
    assert.deepStrictEqual(findUpstreamReferences(result.blocked?.body ?? ""), []);
    assert.include(
      buildBlockedIssue(plan, {
        targetTag: "v1.1.0-nightly.20260828.1209",
        conflictingForkCommitCount: 128,
        conflictingFileCount: 140,
        truncated: true,
        truncatedBy: "stop-limit",
        stopLimit: 128,
        timeLimitSeconds: 360,
      })?.body ?? "",
      "The census stopped at its conflict-stop limit of 128, so these are lower-bound counts.",
    );
    assert.include(
      buildBlockedIssue(plan, {
        targetTag: "v1.1.0-nightly.20260828.1209",
        conflictingForkCommitCount: 12,
        conflictingFileCount: 20,
        truncated: true,
        truncatedBy: "time-limit",
        stopLimit: 128,
        timeLimitSeconds: 360,
      })?.body ?? "",
      "The census stopped at its wall-clock limit of 360 seconds, so these are lower-bound counts.",
    );
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("rehearses sequential conflict stops in a disposable worktree", () => {
  const fixture = fixtureRepository();
  try {
    const before = git(fixture.root, ["worktree", "list", "--porcelain"]);
    const census = rehearseStopCensus(fixture.root, fixture.fork, fixture.base, {
      tag: "v1.1.0-nightly.20260828.1209",
      sha: fixture.conflict,
      position: 3,
      stable: false,
    });
    assert.deepStrictEqual(census, {
      targetTag: "v1.1.0-nightly.20260828.1209",
      conflictingForkCommitCount: 1,
      conflictingFileCount: 1,
      truncated: false,
      truncatedBy: null,
      stopLimit: 128,
      timeLimitSeconds: 360,
    });
    assert.strictEqual(git(fixture.root, ["worktree", "list", "--porcelain"]), before);
    assert.deepStrictEqual(
      rehearseStopCensus(
        fixture.root,
        fixture.fork,
        fixture.base,
        {
          tag: "v1.1.0-nightly.20260828.1209",
          sha: fixture.conflict,
          position: 3,
          stable: false,
        },
        { stopLimit: 128, timeLimitMs: 0, now: () => 0 },
      ),
      {
        targetTag: "v1.1.0-nightly.20260828.1209",
        conflictingForkCommitCount: 0,
        conflictingFileCount: 0,
        truncated: true,
        truncatedBy: "time-limit",
        stopLimit: 128,
        timeLimitSeconds: 0,
      },
    );
    assert.strictEqual(git(fixture.root, ["worktree", "list", "--porcelain"]), before);
    assert.throws(
      () =>
        rehearseStopCensus(fixture.root, fixture.fork, fixture.base, {
          tag: "v9.9.9",
          sha: "f".repeat(40),
          position: 4,
          stable: true,
        }),
      /census rebase failed/,
    );
    assert.strictEqual(git(fixture.root, ["worktree", "list", "--porcelain"]), before);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("keeps blocked reports available when the optional census fails", () => {
  const fixture = fixtureRepository();
  try {
    const plan = buildAutoRebasePlan(new SystemGit(fixture.root), fixture.fork, null);
    let censusCalls = 0;
    const blocked = executeAutoRebase(
      fixture.root,
      { ...dryRunOptions, mode: "off" },
      plan,
      () => "shared-install",
      {
        rehearseStopCensus: () => {
          censusCalls += 1;
          throw new Error("synthetic census failure");
        },
      },
    );
    assert.strictEqual(blocked.status, "off");
    assert.strictEqual(censusCalls, 1);
    assert.strictEqual(blocked.blocked?.stopCensus, null);
    assert.strictEqual(blocked.blocked?.stopCensusUnavailableReason, "synthetic census failure");
    assert.include(
      blocked.blocked?.body ?? "",
      "The sequential rebase census was unavailable: `synthetic census failure`.",
    );

    const clearPlan = {
      ...plan,
      feasibility: {
        ...plan.feasibility,
        ffBoundary: { ...plan.feasibility.ffBoundary, firstConflict: null },
      },
    };
    const clear = executeAutoRebase(
      fixture.root,
      { ...dryRunOptions, mode: "off" },
      clearPlan,
      () => "shared-install",
      {
        rehearseStopCensus: () => {
          censusCalls += 1;
          throw new Error("must not run");
        },
      },
    );
    assert.strictEqual(clear.blocked, null);
    assert.strictEqual(censusCalls, 1);
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
