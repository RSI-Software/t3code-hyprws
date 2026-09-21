// @effect-diagnostics nodeBuiltinImport:off - The fixture builds a real git repository.
import "./lib/fork-test-quiet.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  forecast,
  forecastComplete,
  forecastPullRequest,
  type MainForecast,
  mainOnlyRows,
  mainState,
  PULL_REQUEST_FORECAST_MARKER,
  renderPullRequestForecast,
} from "./fork-forecast.ts";
import { botForecastComment, publication } from "./fork-pr-forecast.ts";

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

it("reads a clean main tip as `not observed` and publishes no pull-request comment", () => {
  const item = fixture(false);
  try {
    const result = forecast(item.root);
    assert.strictEqual(result.main, item.main);
    assert.deepStrictEqual(
      result.conflicts.map((row) => row.conflicts),
      [false],
    );
    const row = { commit: result.conflicts[0]!.commit, path: "seam.txt" };
    assert.strictEqual(mainState(result, row, { sourceSha: result.source }), "not observed");
    assert.strictEqual(renderPullRequestForecast(result), null);
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
    assert.strictEqual(renderPullRequestForecast({ ...result, conflicts: [] }), null);
    assert.include(renderPullRequestForecast(result)!, `Forecast against origin/main ${main}`);
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
    assert.strictEqual(
      mainState(result, { commit: row.commit, path: "seam.txt" }, { sourceSha: result.source }),
      "conflict",
    );
    assert.strictEqual(
      mainState(null, { commit: row.commit, path: "seam.txt" }, { sourceSha: result.source }),
      "unknown (unavailable)",
    );
    assert.strictEqual(
      mainState(result, { commit: row.commit, path: "seam.txt" }, { sourceSha: "0".repeat(40) }),
      "unknown (source-mismatch)",
    );
    assert.strictEqual(
      mainState(
        { ...result, complete: false },
        { commit: row.commit, path: "seam.txt" },
        { sourceSha: result.source },
      ),
      "unknown (partial)",
    );
    assert.strictEqual(
      mainState(result, { commit: "1".repeat(40), path: "seam.txt" }, { sourceSha: result.source }),
      "unknown (stale)",
    );
    // A partial forecast publishes its rows as a lower bound, never as a clean claim.
    assert.include(renderPullRequestForecast({ ...result, complete: false })!, "lower bound");
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

const evidenceOf = (source: string, rows: ReadonlyArray<{ commit: string; path: string }>) => ({
  version: 2 as const,
  method: "sequential-rebase-walk-resolution" as const,
  sourceSha: source,
  baseSha: "b".repeat(40),
  targetSha: "t".repeat(40),
  targetTag: "v1.0.0",
  complete: true,
  rows: rows.map((row, index) => ({
    stop: index + 1,
    commit: row.commit,
    subject: "feat: fork",
    domain: "fork-meta",
    path: row.path,
    kind: "content" as const,
  })),
});

const forecastOf = (
  source: string,
  files: ReadonlyArray<string>,
  complete = true,
): MainForecast => ({
  main: "m".repeat(40),
  base: "b".repeat(40),
  source,
  complete,
  conflicts: [
    {
      commit: "f".repeat(40),
      subject: "feat: fork",
      domain: "fork-meta",
      conflicts: files.length > 0,
      files,
      seam: null,
    },
  ],
});

it("never reads absent or inconsistent census evidence as complete", () => {
  const complete = { version: 2 as const, complete: true };
  assert.isFalse(forecastComplete({ truncated: false }));
  assert.isFalse(forecastComplete({ truncated: true }));
  assert.isFalse(
    forecastComplete({
      truncated: false,
      evidence: { ...evidenceOf("s".repeat(40), []), complete: false },
    }),
  );
  // Truncated wins over a census that still called its own rows complete.
  assert.isFalse(
    forecastComplete({
      truncated: true,
      evidence: { ...evidenceOf("s".repeat(40), []), ...complete },
    }),
  );
  assert.isTrue(forecastComplete({ truncated: false, evidence: evidenceOf("s".repeat(40), []) }));
});

it("unions a main-only conflict into the blocked rows on the exact key", () => {
  const source = "s".repeat(40);
  const fork = "f".repeat(40);
  const evidence = evidenceOf(source, [{ commit: fork, path: "tagged.ts" }]);
  const forecast = forecastOf(source, ["tagged.ts", "main-only.ts"]);
  assert.deepStrictEqual(
    mainOnlyRows(forecast, evidence).map((row) => row.path),
    ["main-only.ts"],
  );
  assert.strictEqual(
    mainState(forecast, { commit: fork, path: "tagged.ts" }, evidence),
    "conflict",
  );
  // A forecast taken from another source never contributes rows to this census.
  assert.deepStrictEqual(mainOnlyRows(forecastOf("0".repeat(40), ["main-only.ts"]), evidence), []);
  assert.deepStrictEqual(mainOnlyRows(null, evidence), []);
});

it("publishes conflicts, retires a stale comment, and never claims a partial walk clean", () => {
  const source = "s".repeat(40);
  const conflict = publication(forecastOf(source, ["seam.ts"]));
  assert.strictEqual(conflict.kind, "upsert");
  assert.include(conflict.kind === "upsert" ? conflict.body : "", "`seam.ts`");
  // conflict -> clean: the comment goes, with no warning.
  const clean = publication(forecastOf(source, []));
  assert.deepStrictEqual(clean, { kind: "delete", warning: null });
  // conflict -> partial with rows: published as an explicit lower bound.
  const partialRows = publication(forecastOf(source, ["seam.ts"], false));
  assert.strictEqual(partialRows.kind, "upsert");
  assert.include(partialRows.kind === "upsert" ? partialRows.body : "", "lower bound");
  // conflict -> partial with no rows, and conflict -> unavailable: the obsolete claim
  // is removed rather than left standing, and the run warns instead of claiming clean.
  for (const row of [
    forecastOf(source, [], false),
    { ...forecastOf(source, [], false), conflicts: [] },
  ]) {
    const stale = publication(row);
    assert.strictEqual(stale.kind, "delete");
    assert.isNotNull(stale.kind === "delete" ? stale.warning : null);
  }
});

it("owns only the comment the bot authored, never a human copy of its marker", () => {
  const body = `quoting ${PULL_REQUEST_FORECAST_MARKER} for context`;
  assert.isNull(botForecastComment([{ id: 1, body, user: { type: "User" } }]));
  assert.isNull(botForecastComment([{ id: 2, body: "unrelated", user: { type: "Bot" } }]));
  assert.isNull(botForecastComment([{ id: 3, body }]));
  assert.strictEqual(
    botForecastComment([
      { id: 4, body, user: { type: "User" } },
      { id: 5, body, user: { type: "Bot" } },
    ]),
    5,
  );
});
