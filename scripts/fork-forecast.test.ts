// @effect-diagnostics nodeBuiltinImport:off - The fixture builds a real git repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  appendForecast,
  forecast,
  forecastPullRequest,
  renderForecast,
  renderPullRequestForecast,
} from "./fork-forecast.ts";

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const commit = (root: string, message: string): string => {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
};

const fixture = (conflict: boolean) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-forecast-test-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  NodeFS.writeFileSync(NodePath.join(root, "seam.txt"), "base\n");
  const base = commit(root, "base");
  git(root, ["tag", "forecast-base"]);
  git(root, ["remote", "add", "origin", root]);
  git(root, ["branch", "hyprws"]);
  git(root, ["switch", "hyprws"]);
  NodeFS.writeFileSync(NodePath.join(root, "fork.txt"), "fork\n");
  if (conflict) NodeFS.writeFileSync(NodePath.join(root, "seam.txt"), "fork\n");
  commit(root, "feat: fork\n\nFork-Domain: fork-meta\nFork-Tier: qol");
  git(root, ["switch", "main"]);
  if (conflict) NodeFS.writeFileSync(NodePath.join(root, "seam.txt"), "upstream\n");
  else NodeFS.writeFileSync(NodePath.join(root, "upstream.txt"), "upstream\n");
  const main = commit(root, "upstream seam");
  git(root, ["update-ref", "refs/remotes/origin/main", main]);
  git(root, ["update-ref", "refs/heads/main", main]);
  return { root, base, main };
};

it("reports a clean main tip and records dedupe by main SHA", () => {
  const item = fixture(false);
  try {
    const result = forecast(item.root);
    assert.strictEqual(result.main, item.main);
    assert.deepStrictEqual(
      result.conflicts.map((row) => row.conflicts),
      [false],
    );
    assert.include(renderForecast(result, false), `clean at \`${item.main}\``);
    const appended = appendForecast([], result);
    assert.strictEqual(appended.deduped, false);
    assert.strictEqual(appendForecast(appended.forecasts, result).deduped, true);
  } finally {
    NodeFS.rmSync(item.root, { recursive: true, force: true });
  }
});

it("forecasts only the pull request range and renders the exact clean string", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-pr-forecast-test-"));
  try {
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "test"]);
    git(root, ["config", "user.email", "test@example.com"]);
    NodeFS.writeFileSync(NodePath.join(root, "seam.txt"), "base\n");
    commit(root, "base");
    git(root, ["remote", "add", "origin", root]);
    git(root, ["branch", "hyprws"]);
    git(root, ["switch", "hyprws"]);
    NodeFS.writeFileSync(NodePath.join(root, "trunk.txt"), "trunk\n");
    commit(root, "feat: trunk\n\nFork-Domain: fork-meta\nFork-Tier: qol");
    git(root, ["switch", "-c", "feature"]);
    NodeFS.writeFileSync(NodePath.join(root, "seam.txt"), "feature\n");
    const feature = commit(root, "feat: feature\n\nFork-Domain: fork-meta\nFork-Tier: qol");
    git(root, ["switch", "main"]);
    NodeFS.writeFileSync(NodePath.join(root, "seam.txt"), "upstream\n");
    const main = commit(root, "upstream seam");
    git(root, ["update-ref", "refs/remotes/origin/main", main]);
    git(root, ["update-ref", "refs/heads/main", main]);
    git(root, ["switch", "feature"]);

    const result = forecastPullRequest(root, feature);
    assert.deepStrictEqual(
      result.conflicts.map((row) => row.commit),
      [feature],
    );
    assert.deepStrictEqual(result.conflicts[0]?.files, ["seam.txt"]);
    assert.include(renderPullRequestForecast({ ...result, conflicts: [] }), `clean at ${main}`);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("uses the census conflict rows without moving fork refs or tags", () => {
  const item = fixture(true);
  try {
    const beforeHead = git(item.root, ["rev-parse", "hyprws"]);
    const beforeTags = git(item.root, ["tag", "--list"]);
    const result = forecast(item.root);
    const row = result.conflicts[0]!;
    assert.strictEqual(row.conflicts, true);
    assert.deepStrictEqual(row.files, ["seam.txt"]);
    assert.strictEqual(row.seam, item.main);
    assert.strictEqual(git(item.root, ["rev-parse", "hyprws"]), beforeHead);
    assert.strictEqual(git(item.root, ["tag", "--list"]), beforeTags);
  } finally {
    NodeFS.rmSync(item.root, { recursive: true, force: true });
  }
});

// A fork stack rides beneath the pull requests under test: the trunk commit is
// fork-only, and upstream has moved seam.txt since the stack base.
const stackedFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-pr-stack-forecast-test-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  NodeFS.writeFileSync(NodePath.join(root, "seam.txt"), "base\n");
  commit(root, "base");
  git(root, ["remote", "add", "origin", root]);
  git(root, ["branch", "hyprws"]);
  git(root, ["switch", "hyprws"]);
  NodeFS.writeFileSync(NodePath.join(root, "fork.txt"), "fork\n");
  commit(root, "feat: trunk\n\nFork-Domain: fork-meta\nFork-Tier: qol");
  git(root, ["switch", "main"]);
  NodeFS.writeFileSync(NodePath.join(root, "seam.txt"), "upstream\n");
  const main = commit(root, "upstream seam");
  git(root, ["update-ref", "refs/remotes/origin/main", main]);
  git(root, ["update-ref", "refs/heads/main", main]);
  return { root, main };
};

it("reports a fork-only pull-request commit as clean on top of a colliding stack", () => {
  const item = stackedFixture();
  try {
    const { root } = item;
    git(root, ["switch", "hyprws"]);
    git(root, ["switch", "-c", "fork-only"]);
    // Edits fork.txt, the fork-only file the stack added: replaying the PR
    // commit alone onto main hits modify/delete, but replaying the stack plus
    // the pull request does not.
    NodeFS.writeFileSync(NodePath.join(root, "fork.txt"), "pr\n");
    const prCommit = commit(
      root,
      "feat: edit the stack's fork-only file\n\nFork-Domain: fork-meta\nFork-Tier: qol",
    );

    const result = forecastPullRequest(root, "fork-only");
    assert.deepStrictEqual(
      result.conflicts.map((row) => row.commit),
      [prCommit],
    );
    assert.strictEqual(result.conflicts[0]?.conflicts, false);
    assert.deepStrictEqual(result.conflicts[0]?.files, []);
  } finally {
    NodeFS.rmSync(item.root, { recursive: true, force: true });
  }
});

it("attributes a seam the pull request shares with upstream to the pull-request commit", () => {
  const item = stackedFixture();
  try {
    const { root, main } = item;
    git(root, ["switch", "hyprws"]);
    git(root, ["switch", "-c", "collision"]);
    NodeFS.writeFileSync(NodePath.join(root, "seam.txt"), "pull request\n");
    const prCommit = commit(
      root,
      "fix: collision\n\nFork-Domain: fork-meta\nFork-Tier: bugfix\nFork-Upstreamable: no",
    );

    const result = forecastPullRequest(root, "collision");
    assert.deepStrictEqual(
      result.conflicts.map((row) => row.commit),
      [prCommit],
    );
    assert.strictEqual(result.conflicts[0]?.conflicts, true);
    assert.deepStrictEqual(result.conflicts[0]?.files, ["seam.txt"]);
    assert.strictEqual(result.conflicts[0]?.seam, main);
  } finally {
    NodeFS.rmSync(item.root, { recursive: true, force: true });
  }
});
