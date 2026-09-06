// @effect-diagnostics nodeBuiltinImport:off - Fixture repositories use synchronous Node helpers.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { crossedStableTags, snapshotCrossedStableTags } from "./fork-stable-crossing.ts";
import { SystemGit } from "./lib/fork-command.ts";

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();

interface Fixture {
  readonly container: string;
  readonly root: string;
  readonly remote: string;
  /** The upstream base the fork stack sits on, tagged `v0.9.0`. */
  readonly base: string;
  readonly firstStable: string;
  readonly secondStable: string;
  readonly fork: string;
}

const commit = (root: string, subject: string): string => {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", subject, "-m", "Fork-Domain: fork-meta\nFork-Tier: qol"]);
  return git(root, ["rev-parse", "HEAD"]);
};

/**
 * A fork stack one commit deep on `v0.9.0`, with two stable upstream tags and a
 * nightly between them ahead of it. `conflicting` decides whether the fork commit
 * can be replayed onto those tags.
 */
const fixtureRepository = (conflicting = false): Fixture => {
  const container = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-stable-crossing-"));
  const root = NodePath.join(container, "work");
  const remote = NodePath.join(container, "origin.git");
  NodeFS.mkdirSync(root);
  NodeFS.mkdirSync(remote);
  git(root, ["init", "-b", "base"]);
  git(remote, ["init", "--bare"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  NodeFS.writeFileSync(NodePath.join(root, "shared.txt"), "first\nshared\nthird\n");
  const base = commit(root, "base");
  git(root, ["tag", "v0.9.0"]);
  git(root, ["branch", "fork-stack"]);

  git(root, ["switch", "-c", "upstream-lane"]);
  NodeFS.writeFileSync(NodePath.join(root, "shared.txt"), "first\nupstream\nthird\n");
  const firstStable = commit(root, "feat: first stable upstream release");
  git(root, ["tag", "v1.0.0"]);
  NodeFS.writeFileSync(NodePath.join(root, "nightly.txt"), "nightly\n");
  commit(root, "fix: clean nightly change");
  git(root, ["tag", "v1.1.0-nightly.20260828.1208"]);
  NodeFS.writeFileSync(NodePath.join(root, "second.txt"), "second\n");
  const secondStable = commit(root, "feat: second stable upstream release");
  git(root, ["tag", "v1.1.0"]);

  git(root, ["switch", "fork-stack"]);
  if (conflicting) NodeFS.writeFileSync(NodePath.join(root, "shared.txt"), "first\nfork\nthird\n");
  else NodeFS.writeFileSync(NodePath.join(root, "fork.txt"), "fork\n");
  const fork = commit(root, "feat(test): fork stack change");
  git(root, ["push", "origin", `${secondStable}:refs/heads/main`, `${fork}:refs/heads/hyprws`]);
  return { container, root, remote, base, firstStable, secondStable, fork };
};

const remoteBranches = (fixture: Fixture): ReadonlyArray<string> =>
  git(fixture.root, ["ls-remote", "--heads", "origin"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]?.replace("refs/heads/", "") ?? "");

it("lists the stable upstream tags an apply crosses, oldest first, base excluded", () => {
  const fixture = fixtureRepository();
  try {
    const crossed = crossedStableTags(
      new SystemGit(fixture.root),
      fixture.base,
      fixture.secondStable,
    );
    assert.deepStrictEqual(
      crossed.map((tag) => tag.tag),
      ["v1.0.0", "v1.1.0"],
    );
    assert.strictEqual(crossed[1]?.sha, fixture.secondStable);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("crosses nothing when the apply leaves the upstream base where it was", () => {
  const fixture = fixtureRepository();
  try {
    assert.deepStrictEqual(
      crossedStableTags(new SystemGit(fixture.root), fixture.base, fixture.base),
      [],
    );
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("skips a crossed stable tag origin already carries as a snapshot or a cut tag", () => {
  const fixture = fixtureRepository();
  try {
    git(fixture.root, [
      "push",
      "origin",
      `${fixture.firstStable}:refs/heads/release/v1.0.0-hyprws`,
      `${fixture.secondStable}:refs/tags/v1.1.0-hyprws.1`,
    ]);
    assert.deepStrictEqual(
      crossedStableTags(new SystemGit(fixture.root), fixture.base, fixture.secondStable),
      [],
    );
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("snapshots each crossed stable tag as the fork series replayed onto it", () => {
  const fixture = fixtureRepository();
  const warnings: Array<string> = [];
  try {
    const candidates = snapshotCrossedStableTags({
      root: fixture.root,
      oldSha: fixture.fork,
      oldBaseSha: fixture.base,
      newBaseSha: fixture.secondStable,
      warn: (message) => warnings.push(message),
    });

    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(
      candidates.map((candidate) => candidate.branch),
      ["release/v1.0.0-hyprws", "release/v1.1.0-hyprws"],
    );
    assert.deepStrictEqual(
      candidates.map((candidate) => candidate.title),
      ["Stable candidate v1.0.0-hyprws", "Stable candidate v1.1.0-hyprws"],
    );
    for (const candidate of candidates) {
      assert.include(remoteBranches(fixture), candidate.branch);
      assert.include(candidate.body, "The unblock apply lane created");
      assert.include(candidate.body, `<!-- hyprws-stable-candidate: ${candidate.tag}-hyprws -->`);
      // The snapshot is the same fork series, one commit deep, on the stable tag.
      assert.strictEqual(
        git(fixture.root, ["rev-list", "--count", `${candidate.tag}..${candidate.sha}`]),
        "1",
      );
      assert.strictEqual(
        git(fixture.root, ["log", "-1", "--format=%s", candidate.sha]),
        "feat(test): fork stack change",
      );
    }
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("leaves an already published snapshot alone and still announces the rest", () => {
  const fixture = fixtureRepository();
  try {
    git(fixture.root, ["push", "origin", `${fixture.fork}:refs/heads/release/v1.0.0-hyprws`]);
    const candidates = snapshotCrossedStableTags({
      root: fixture.root,
      oldSha: fixture.fork,
      oldBaseSha: fixture.base,
      newBaseSha: fixture.secondStable,
      warn: () => assert.fail("a clean replay must not warn"),
    });

    assert.deepStrictEqual(
      candidates.map((candidate) => candidate.branch),
      ["release/v1.1.0-hyprws"],
    );
    assert.strictEqual(
      git(fixture.root, ["ls-remote", "origin", "refs/heads/release/v1.0.0-hyprws"]).split("\t")[0],
      fixture.fork,
    );
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("reports a snapshot it cannot replay and never fails the apply that crossed it", () => {
  const fixture = fixtureRepository(true);
  const warnings: Array<string> = [];
  try {
    const candidates = snapshotCrossedStableTags({
      root: fixture.root,
      oldSha: fixture.fork,
      oldBaseSha: fixture.base,
      newBaseSha: fixture.secondStable,
      warn: (message) => warnings.push(message),
    });

    assert.deepStrictEqual(candidates, []);
    assert.strictEqual(warnings.length, 2);
    assert.include(warnings[0] ?? "", "release/v1.0.0-hyprws not created");
    assert.include(warnings[0] ?? "", "Snapshot it by hand before cutting v1.0.0-hyprws.");
    assert.deepStrictEqual(remoteBranches(fixture).toSorted(), ["hyprws", "main"]);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});

it("reports an enumeration it cannot run instead of throwing into the apply", () => {
  const fixture = fixtureRepository();
  const warnings: Array<string> = [];
  try {
    const candidates = snapshotCrossedStableTags({
      root: fixture.root,
      oldSha: fixture.fork,
      oldBaseSha: "0".repeat(40),
      newBaseSha: fixture.secondStable,
      warn: (message) => warnings.push(message),
    });

    assert.deepStrictEqual(candidates, []);
    assert.strictEqual(warnings.length, 1);
    assert.include(warnings[0] ?? "", "crossed stable upstream tags not enumerated");
    assert.include(warnings[0] ?? "", `${"0".repeat(40)}..${fixture.secondStable}`);
    assert.deepStrictEqual(remoteBranches(fixture).toSorted(), ["hyprws", "main"]);
  } finally {
    NodeFS.rmSync(fixture.container, { recursive: true, force: true });
  }
});
