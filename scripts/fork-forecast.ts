#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Forecasting is standalone Git plumbing.

import { rehearseStopCensus } from "./fork-stop-census.ts";
import type { ForecastEntry } from "./fork-churn-ledger.ts";
import { runCommand, runCommandText } from "./lib/fork-command.ts";
import type { RebaseStopCensus, SequentialCensusEvidence } from "./lib/fork-rebase-issues.ts";

/**
 * A forecast is evidence, never a publication: it replays the fork stack against live
 * `origin/main` for one blocked-issue column and one pull-request comment
 * (RSI-Software/t3code-hyprws#1143). It selects no tag, applies nothing, retires nothing.
 */
export interface MainForecast extends ForecastEntry {
  /** The fork tip the forecast replayed, so a join can refuse mismatched evidence. */
  readonly source: string;
  /** False when the rehearsal was truncated; a partial forecast is never clean. */
  readonly complete: boolean;
}

/** Why a census row has no usable `upstream/main` verdict. */
export type MainStateReason = "partial" | "unavailable" | "stale" | "source-mismatch";

export type MainState = "conflict" | "not observed" | `unknown (${MainStateReason})`;

const git = (root: string, args: ReadonlyArray<string>): string =>
  runCommandText("git", args, { cwd: root }).trim();

// merge-base --is-ancestor signals its verdict in the exit code, not stdout.
const isAncestor = (root: string, commit: string, ancestor: string): boolean =>
  runCommand("git", ["merge-base", "--is-ancestor", commit, ancestor], { cwd: root }).status === 0;

const forkCommits = (root: string, base: string, head: string) =>
  git(root, ["log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", `${base}..${head}`])
    .split("\x1e")
    // Git separates entries with a newline after the record terminator; the
    // whole output is trimmed only at the ends, so later rows keep a leading one.
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const [commit = "", subject = "", body = ""] = row.split("\x1f");
      return {
        commit,
        subject,
        domain: /^Fork-Domain:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? "?",
      };
    });

/**
 * Partial is never clean: a truncated walk saw part of the stack, and absent evidence
 * proves nothing, so neither is complete (RSI-Software/t3code-hyprws#942).
 */
export const forecastComplete = (
  census: Pick<RebaseStopCensus, "truncated" | "evidence">,
): boolean => !census.truncated && (census.evidence?.complete ?? false);

export const forecastRange = (
  root: string,
  head: string,
  base: string,
  main: string,
): MainForecast => {
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
    source: resolvedHead,
    complete: forecastComplete(census),
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

export const forecast = (root: string): MainForecast => {
  const head = git(root, ["rev-parse", "hyprws^{commit}"]);
  git(root, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const main = git(root, ["rev-parse", "origin/main^{commit}"]);
  const base = git(root, ["merge-base", head, main]);
  return forecastRange(root, head, base, main);
};

export const forecastPullRequest = (root: string, head: string): MainForecast => {
  // On a hyprws checkout the trunk is the checked-out branch; on a workflow
  // dispatch of another branch only the remote-tracking ref exists.
  const trunk =
    runCommand("git", ["rev-parse", "--verify", "--quiet", "hyprws"], { cwd: root }).status === 0
      ? "hyprws"
      : "origin/hyprws";
  const pullBase = git(root, ["merge-base", trunk, head]);
  git(root, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const main = git(root, ["rev-parse", "origin/main^{commit}"]);
  // The pull request rides on the fork stack: rehearse from the upstream merge
  // base so the stack beneath the pull request replays too, then keep only the
  // stops that land on commits inside the pull-request range.
  const stackBase = git(root, ["merge-base", main, head]);
  const census = forecastRange(root, head, stackBase, main);
  const conflicts = census.conflicts.filter((commit) => !isAncestor(root, commit.commit, pullBase));
  return { ...census, conflicts };
};

export const PULL_REQUEST_FORECAST_MARKER = "<!-- hyprws-pull-request-forecast -->";

/**
 * The `upstream/main state` cell, joined on the exact `(source, fork commit, path)` key.
 * `not observed` needs a complete forecast whose source matches the census's.
 */
export const mainState = (
  forecast: MainForecast | null,
  row: { readonly commit: string; readonly path: string },
  evidence: Pick<SequentialCensusEvidence, "sourceSha">,
): MainState => {
  if (forecast === null) return "unknown (unavailable)";
  if (forecast.source !== evidence.sourceSha) return "unknown (source-mismatch)";
  if (!forecast.complete) return "unknown (partial)";
  const entry = forecast.conflicts.find((commit) => commit.commit === row.commit);
  if (entry === undefined) return "unknown (stale)";
  return entry.files.includes(row.path) ? "conflict" : "not observed";
};

/** The same-key conflict rows the tagged census never recorded, never joined by subject. */
export const mainOnlyRows = (
  forecast: MainForecast | null,
  evidence: SequentialCensusEvidence,
): ReadonlyArray<{
  readonly commit: string;
  readonly subject: string;
  readonly domain: string;
  readonly path: string;
}> => {
  if (forecast === null || forecast.source !== evidence.sourceSha) return [];
  const tagged = new Set(evidence.rows.map((row) => `${row.commit}\u0000${row.path}`));
  return forecast.conflicts.flatMap((commit) =>
    commit.files
      .filter((path) => !tagged.has(`${commit.commit}\u0000${path}`))
      .map((path) => ({
        commit: commit.commit,
        subject: commit.subject,
        domain: commit.domain,
        path,
      })),
  );
};

/** The sticky comment, conflict rows only; a clean walk renders nothing to post. */
export const renderPullRequestForecast = (row: MainForecast): string | null => {
  const conflicts = row.conflicts.filter((commit) => commit.conflicts);
  if (conflicts.length === 0) return null;
  return [
    PULL_REQUEST_FORECAST_MARKER,
    "## Fork conflict forecast",
    "",
    `Forecast against origin/main ${row.main} from source ${row.source}.`,
    ...(row.complete
      ? []
      : ["", "Partial observation set: these rows are a lower bound, not the whole walk."]),
    "",
    "| Fork commit | Fork-Domain | Conflicting files |",
    "| --- | --- | --- |",
    ...conflicts.map(
      (commit) =>
        `| \`${commit.commit.slice(0, 12)} ${commit.subject}\` | \`${commit.domain}\` | ${commit.files.map((path) => `\`${path}\``).join(", ")} |`,
    ),
  ].join("\n");
};
