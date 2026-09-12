#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Forecasting is standalone Git plumbing.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { rehearseStopCensus } from "./fork-auto-rebase.ts";
import { readChurnState, writeChurnState, type ForecastEntry } from "./fork-churn-ledger.ts";
import { budgetFindings, parseForkBudget } from "./lib/fork-budget.ts";
import { acquireBotRefLease, CHURN_REF, publishBotRefLease } from "./lib/fork-bot-refs.ts";
import { runCommandText } from "./lib/fork-command.ts";
import { FORK_REPOSITORY } from "./lib/fork-policy.ts";

export const FORECAST_MARKER = "<!-- hyprws-fork-forecast -->";
export const FORECAST_STATE = /<!-- hyprws-fork-forecast-state:([0-9a-f]{40,64}) -->/;
// #443 is the longest-lived mission issue in this chain, so its standing forecast
// survives transient block and feature issues closing.
export const FORECAST_PARENT_ISSUE = 443;
export const PULL_REQUEST_FORECAST_MARKER = "<!-- hyprws-pull-request-forecast -->";

export interface PullRequestForecast extends ForecastEntry {
  readonly overBudgetDomains: ReadonlySet<string>;
}

const git = (root: string, args: ReadonlyArray<string>): string =>
  runCommandText("git", args, { cwd: root }).trim();

export const appendForecast = (
  forecasts: ReadonlyArray<ForecastEntry>,
  forecast: ForecastEntry,
): { readonly forecasts: ReadonlyArray<ForecastEntry>; readonly deduped: boolean } =>
  forecasts.some((row) => row.main === forecast.main)
    ? { forecasts, deduped: true }
    : { forecasts: [...forecasts, forecast], deduped: false };

const forkCommits = (root: string, base: string, head: string) =>
  git(root, ["log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", `${base}..${head}`])
    .split("\x1e")
    .filter(Boolean)
    .map((row) => {
      const [commit = "", subject = "", body = ""] = row.split("\x1f");
      return {
        commit,
        subject,
        domain: /^Fork-Domain:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "?",
      };
    });

export const forecastRange = (
  root: string,
  head: string,
  base: string,
  main: string,
): ForecastEntry => {
  const resolvedHead = git(root, ["rev-parse", `${head}^{commit}`]);
  const resolvedBase = git(root, ["rev-parse", `${base}^{commit}`]);
  const resolvedMain = git(root, ["rev-parse", `${main}^{commit}`]);
  const census = rehearseStopCensus(
    root,
    resolvedHead,
    resolvedBase,
    { tag: "origin/main", sha: resolvedMain, position: 0, stable: false },
    undefined,
    true,
  );
  const byCommit = new Map<string, Array<string>>();
  for (const row of census.evidence?.rows ?? []) {
    const paths = byCommit.get(row.commit) ?? [];
    paths.push(row.path);
    byCommit.set(row.commit, paths);
  }
  return {
    main: resolvedMain,
    base: resolvedBase,
    conflicts: forkCommits(root, resolvedBase, resolvedHead).map((commit) => {
      const files = [...new Set(byCommit.get(commit.commit) ?? [])].toSorted();
      const seam =
        files.length === 0
          ? null
          : git(root, [
              "log",
              "-1",
              "--format=%H",
              `${resolvedBase}..${resolvedMain}`,
              "--",
              ...files,
            ]) || null;
      return { ...commit, conflicts: files.length > 0, files, seam };
    }),
  };
};

export const forecast = (root: string): ForecastEntry => {
  const head = git(root, ["rev-parse", "hyprws^{commit}"]);
  git(root, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const main = git(root, ["rev-parse", "origin/main^{commit}"]);
  const base = git(root, ["merge-base", head, main]);
  return forecastRange(root, head, base, main);
};

type BudgetStatusReader = (root: string, head: string) => ReadonlySet<string>;

const readOverBudgetDomains: BudgetStatusReader = (root, head) => {
  const inventory = JSON.parse(
    runCommandText(
      process.execPath,
      [
        "scripts/fork-delta.ts",
        "--inventory",
        "--json",
        "--head",
        head,
        "--upstream",
        "origin/main",
      ],
      { cwd: root },
    ),
  ) as {
    readonly domains: ReadonlyArray<{
      readonly domain: string;
      readonly commits: number;
      readonly added: number;
      readonly deleted: number;
      readonly overlaps: number;
    }>;
  };
  const budget = parseForkBudget(git(root, ["show", `${head}:docs/internals/fork-budget.md`]));
  return new Set(budgetFindings(inventory.domains, budget).map((finding) => finding.domain));
};

export const forecastPullRequest = (
  root: string,
  head: string,
  readBudget: BudgetStatusReader = readOverBudgetDomains,
): PullRequestForecast => {
  const base = git(root, ["merge-base", "hyprws", head]);
  git(root, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const main = git(root, ["rev-parse", "origin/main^{commit}"]);
  return { ...forecastRange(root, head, base, main), overBudgetDomains: readBudget(root, head) };
};

export const renderForecast = (row: ForecastEntry, deduped: boolean): string => {
  const conflicts = row.conflicts.filter((commit) => commit.conflicts);
  return [
    FORECAST_MARKER,
    "## Forecast",
    "",
    deduped
      ? `Deduped forecast for origin/main ${"`"}${row.main}${"`"}.`
      : conflicts.length === 0
        ? `clean at ${"`"}${row.main}${"`"}`
        : `Forecast for origin/main ${"`"}${row.main}${"`"}: ${conflicts.length} fork commit(s) conflict.`,
    "",
    "| Fork commit | Conflicts | Files | Upstream seam |",
    "| --- | --- | --- | --- |",
    ...row.conflicts.map(
      (commit) =>
        `| \`${commit.commit.slice(0, 12)} ${commit.subject}\` | ${commit.conflicts ? "yes" : "no"} | ${commit.files.map((path) => `\`${path}\``).join(", ") || "—"} | ${commit.seam === null ? "—" : `\`${commit.seam}\``} |`,
    ),
    "",
    `<!-- hyprws-fork-forecast-state:${row.main} -->`,
  ].join("\n");
};

export const renderPullRequestForecast = (row: PullRequestForecast): string => {
  const conflicts = row.conflicts.filter((commit) => commit.conflicts);
  return [
    PULL_REQUEST_FORECAST_MARKER,
    "## Fork conflict forecast",
    "",
    conflicts.length === 0 ? `clean at ${row.main}` : `Forecast against origin/main ${row.main}.`,
    ...(conflicts.length === 0
      ? []
      : [
          "",
          "| Fork commit | Fork-Domain | Over ceiling | Conflicting files |",
          "| --- | --- | --- | --- |",
          ...conflicts.map(
            (commit) =>
              `| \`${commit.commit.slice(0, 12)} ${commit.subject}\` | \`${commit.domain}\` | ${row.overBudgetDomains.has(commit.domain) ? "yes" : "no"} | ${commit.files.map((path) => `\`${path}\``).join(", ")} |`,
          ),
        ]),
  ].join("\n");
};

const post = (root: string, body: string): void => {
  const issues = JSON.parse(
    runCommandText(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "rebase-blocked",
        "--repo",
        FORK_REPOSITORY,
        "--json",
        "number",
      ],
      { cwd: root },
    ),
  ) as ReadonlyArray<{ readonly number: number }>;
  const issue = issues[0]?.number ?? FORECAST_PARENT_ISSUE;
  if (issues.length > 1) throw new Error("expected at most one open rebase-blocked issue");
  const view = JSON.parse(
    runCommandText(
      "gh",
      ["issue", "view", String(issue), "--repo", FORK_REPOSITORY, "--json", "comments"],
      { cwd: root },
    ),
  ) as { comments: ReadonlyArray<{ url: string; body: string }> };
  const existing = view.comments.findLast((comment) => comment.body.includes(FORECAST_MARKER));
  const file = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-forecast-")),
    "forecast.md",
  );
  NodeFS.writeFileSync(file, body);
  if (existing === undefined) {
    runCommandText(
      "gh",
      ["issue", "comment", String(issue), "--repo", FORK_REPOSITORY, "--body-file", file],
      { cwd: root },
    );
  } else {
    const id = /#issuecomment-(\d+)$/.exec(existing.url)?.[1];
    if (id === undefined) throw new Error("forecast comment URL has no REST id");
    runCommandText(
      "gh",
      [
        "api",
        "--method",
        "PATCH",
        `repos/${FORK_REPOSITORY}/issues/comments/${id}`,
        "--field",
        `body=@${file}`,
      ],
      { cwd: root },
    );
  }
  process.stdout.write(`forecast section on #${issue}\n`);
};

export const run = (root: string, publish = true): void => {
  const row = forecast(root);
  const lease = acquireBotRefLease(root, CHURN_REF, publish);
  const state = readChurnState(root);
  const appended = appendForecast(state.forecasts, row);
  if (!appended.deduped) {
    const commit = writeChurnState(
      root,
      { ...state, forecasts: appended.forecasts },
      `forecast: ${row.main}`,
    );
    if (publish && lease !== null) publishBotRefLease(root, lease, commit);
  }
  process.stdout.write(`${appended.deduped ? "dedupe hit" : "forecast recorded"}: ${row.main}\n`);
  post(root, renderForecast(row, appended.deduped));
};

if (import.meta.main) run(process.cwd());
