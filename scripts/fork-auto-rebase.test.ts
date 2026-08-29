// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { findUpstreamReferences } from "./fork-upstream-refs.ts";
import {
  buildAutoRebasePlan,
  executeAutoRebase,
  parseArgs,
  renderSummary,
  selectNewestTag,
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
    `${conflict}:refs/internal/upstream`,
  ]);
  git(root, ["update-ref", "refs/remotes/origin/hyprws", fork]);
  NodeFS.writeFileSync(pushLog, "");
  return { container, root, remote, pushLog, base, stable, cleanNightly, conflict, fork };
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

    const result = executeAutoRebase(fixture.root, dryRunOptions, plan, () => "shared-install");
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
    assert.strictEqual(
      result.blocked?.title,
      `[📡#217] 🔔 hyprws auto-rebase is blocked at upstream ${fixture.conflict.slice(0, 7)}`,
    );
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
