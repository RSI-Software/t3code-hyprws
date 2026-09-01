#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone Git orientation runs before an Effect runtime exists.

// Gate 1 of the fork-sync flow. One command reads the live refs, proves the
// picked tag, and prints the whole orientation plus its Stop block to stdout, so
// the gate is not hand-assembled from a generated report file and two JSON
// siblings. It imports only Node builtins and its sibling scripts, so it runs in
// a worktree with no dependencies installed.

import { UsageError } from "./lib/fork-cli.ts";
import {
  CHECK_DEPENDENCIES,
  CHECK_MIRROR,
  GATE_ONE_CHECKS,
  namedCheck,
  repositoryRoot,
  runPreflight,
  systemEnv,
  unmetRequired,
  type PreflightReport,
} from "./fork-preflight.ts";
import {
  buildReport,
  SystemGit as ReportGit,
  type ForkRebaseReport,
  type GitReader as ReportGitReader,
} from "./fork-rebase-report.ts";
import {
  buildSweep,
  SystemGitHub,
  type GitHubReader,
  type UpstreamWatchSweep,
} from "./fork-upstream-watch.ts";
import {
  readForkRetirementLedger,
  type ForkRetirementLedger,
} from "./lib/fork-retirement-ledger.ts";
import { FORK_REPOSITORY, isStableUpstreamTag, UPSTREAM_LANE } from "./lib/fork-policy.ts";

export { UsageError } from "./lib/fork-cli.ts";

export interface OrientOptions {
  readonly target: string;
  readonly source: string;
}

export interface TargetProof {
  readonly ref: string;
  readonly sha: string;
  readonly stable: boolean;
  readonly reachableFrom: string;
}

export interface FeasibilitySummary {
  readonly upstreamCommitCount: number;
  readonly cleanCommitCount: number;
  readonly firstConflict: string | null;
  readonly conflictFiles: ReadonlyArray<string>;
}

export interface OverlapSummary {
  readonly upstreamChanged: number;
  readonly forkChanged: number;
  readonly overlap: number;
  readonly hardConflict: number;
  readonly automerged: ReadonlyArray<string>;
}

export interface RetireCandidateSummary {
  readonly subject: string;
  readonly domain: string;
  readonly decision: string;
  readonly signals: ReadonlyArray<string>;
}

export interface WatchSummary {
  readonly target: string;
  readonly issues: ReadonlyArray<{
    readonly number: number;
    readonly status: string;
    readonly title: string;
  }>;
  readonly error: string | null;
}

export interface Orientation {
  readonly target: TargetProof;
  readonly source: { readonly ref: string; readonly sha: string };
  readonly sharedBase: string;
  readonly mirror: string;
  readonly dependencies: string;
  readonly feasibility: FeasibilitySummary;
  readonly overlap: OverlapSummary;
  readonly retireCandidates: ReadonlyArray<RetireCandidateSummary>;
  readonly watch: WatchSummary;
}

const HELP = `Usage: vp run fork:orient --target vX.Y.Z

Gate 1 of the fork-sync flow. Proves the picked tag, then prints the target,
source, shared base, feasibility, automerged overlap, retire candidates,
upstream-watch verdicts, mirror currency, and the Gate 1 Stop block to stdout.
Read-only: it never writes a file, a ref, or a GitHub thread.

Options:
  --target <tag>   Upstream tag to orient against (required)
  --source <ref>   Fork ref (default: origin/hyprws)
  -h, --help       Show help

Exit codes:
  0  the orientation is complete
  1  a precondition is unmet, the tag is unproved, or the watch sweep failed
  2  usage error
`;

export const parseOrientArgs = (argv: ReadonlyArray<string>): OrientOptions => {
  let target: string | null = null;
  let source = "origin/hyprws";
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "-h" || argument === "--help") continue;
    if (argument !== "--target" && argument !== "--source") {
      throw new UsageError(`unknown option: ${argument}`);
    }
    if (seen.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new UsageError(`missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--target") target = value;
    else source = value;
  }

  if (target === null) throw new UsageError("expected --target <tag>");
  if (source.length === 0) throw new UsageError("--source cannot be empty");
  return { target, source };
};

/**
 * A version-shaped name is not a target. The tag has to exist as a tag and its
 * commit has to be contained in the upstream lane, or the fork would rebase onto
 * something upstream never released.
 */
export const proveTarget = (git: ReportGitReader, target: string): TargetProof => {
  const resolved = git.runResult(["rev-parse", "--verify", `refs/tags/${target}^{commit}`]);
  if (resolved.status !== 0) {
    throw new Error(
      `target ${target} is not a tag in this repository; fetch upstream tags and pick one it publishes`,
    );
  }
  const sha = resolved.stdout.trim();
  const contained = git.runResult(["merge-base", "--is-ancestor", sha, UPSTREAM_LANE]);
  if (contained.status !== 0) {
    throw new Error(
      `target ${target} (${sha}) is not reachable from ${UPSTREAM_LANE}; it is not on the upstream release lane`,
    );
  }
  return { ref: target, sha, stable: isStableUpstreamTag(target), reachableFrom: UPSTREAM_LANE };
};

const summarizeFeasibility = (report: ForkRebaseReport): FeasibilitySummary => {
  const { ffBoundary, conflicts } = report.feasibility;
  const first = ffBoundary.firstConflict;
  return {
    upstreamCommitCount: ffBoundary.upstreamCommitCount,
    cleanCommitCount: ffBoundary.cleanCommitCount,
    firstConflict: first === null ? null : `${first.shortSha} ${first.subject}`,
    conflictFiles: conflicts.map((conflict) => `${conflict.path} (${conflict.hunkCount} hunks)`),
  };
};

const summarizeRetireCandidates = (
  report: ForkRebaseReport,
): ReadonlyArray<RetireCandidateSummary> =>
  report.retireCandidates.map((candidate) => ({
    subject: candidate.subject,
    domain: candidate.domain ?? "?",
    decision: candidate.decision === "none" ? "candidate" : candidate.decision,
    signals: candidate.signals.map((signal) => `${signal.kind}: ${signal.evidence}`),
  }));

const summarizeWatch = (
  target: string,
  sweep: UpstreamWatchSweep | null,
  error: string | null,
): WatchSummary => ({
  target,
  issues:
    sweep === null
      ? []
      : sweep.issues.map((issue) => ({
          number: issue.number,
          status: issue.status,
          title: issue.title,
        })),
  error,
});

export interface OrientReaders {
  readonly git: ReportGitReader;
  readonly gh: GitHubReader;
}

export const buildOrientation = (
  readers: OrientReaders,
  options: OrientOptions,
  preflight: PreflightReport,
  ledger: ForkRetirementLedger,
): Orientation => {
  const target = proveTarget(readers.git, options.target);
  const report = buildReport(readers.git, options.source, target.ref, ledger);

  let sweep: UpstreamWatchSweep | null = null;
  let sweepError: string | null = null;
  try {
    sweep = buildSweep(readers.gh, readers.git, {
      fork: FORK_REPOSITORY,
      upstream: "pingdotgg/t3code",
      target: target.ref,
      json: false,
    });
  } catch (error) {
    sweepError = error instanceof Error ? error.message : String(error);
  }

  return {
    target,
    source: { ref: options.source, sha: report.hyprws.sha },
    sharedBase: report.sharedBase.sha,
    mirror: namedCheck(preflight, CHECK_MIRROR)?.detail ?? "not checked",
    dependencies: namedCheck(preflight, CHECK_DEPENDENCIES)?.detail ?? "not checked",
    feasibility: summarizeFeasibility(report),
    overlap: report.feasibility.overlap,
    retireCandidates: summarizeRetireCandidates(report),
    watch: summarizeWatch(target.ref, sweep, sweepError),
  };
};

const watchCounts = (watch: WatchSummary): string => {
  if (watch.error !== null) return `sweep failed: ${watch.error}`;
  if (watch.issues.length === 0) return "no open upstream-watch issues";
  const counts = new Map<string, number>();
  for (const issue of watch.issues) counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
  return `${watch.issues.length} open: ${breakdown}`;
};

const feasibilityLine = (feasibility: FeasibilitySummary): string =>
  feasibility.firstConflict === null
    ? `all ${feasibility.upstreamCommitCount} upstream commits merge clean`
    : `${feasibility.cleanCommitCount} of ${feasibility.upstreamCommitCount} upstream commits clean; first conflict ${feasibility.firstConflict}`;

export const renderOrientation = (orientation: Orientation): string => {
  const { target, source, feasibility, overlap, retireCandidates, watch } = orientation;
  const lines: Array<string> = [
    "fork-sync gate 1 orientation",
    "",
    `target:       ${target.ref}@${target.sha}`,
    `              ${target.stable ? "stable tag" : "nightly tag; the apply gate needs --allow-nightly"}, reachable from ${target.reachableFrom}`,
    `source:       ${source.ref}@${source.sha}`,
    `shared base:  ${orientation.sharedBase}`,
    `mirror:       ${orientation.mirror}`,
    `dependencies: ${orientation.dependencies}`,
    "",
    "## Feasibility",
    "",
    feasibilityLine(feasibility),
    "",
  ];

  if (feasibility.conflictFiles.length === 0) {
    lines.push("No conflicting file.");
  } else {
    lines.push(`${feasibility.conflictFiles.length} conflicting files:`);
    for (const file of feasibility.conflictFiles) lines.push(`  - ${file}`);
  }

  lines.push(
    "",
    "## Automerged overlap",
    "",
    `${overlap.upstreamChanged} upstream-changed, ${overlap.forkChanged} fork-changed, ${overlap.overlap} overlap (${overlap.hardConflict} hard-conflict, ${overlap.automerged.length} automerged)`,
    "",
  );
  if (overlap.automerged.length === 0) {
    lines.push("No automerged overlap.");
  } else {
    lines.push(
      "Automerged files are a semantic review surface, not proof the fork behavior survived:",
    );
    for (const path of overlap.automerged) lines.push(`  - ${path}`);
  }

  lines.push("", "## Retire candidates", "");
  if (retireCandidates.length === 0) {
    lines.push("None.");
  } else {
    for (const candidate of retireCandidates) {
      lines.push(`  [${candidate.decision}] ${candidate.subject} (${candidate.domain})`);
      for (const signal of candidate.signals) lines.push(`      ${signal}`);
    }
  }

  lines.push("", `## upstream-watch against ${watch.target}`, "");
  if (watch.error !== null) {
    lines.push(`sweep failed: ${watch.error}`);
  } else if (watch.issues.length === 0) {
    lines.push("No open upstream-watch issues. Nothing waits on upstream.");
  } else {
    for (const issue of watch.issues) {
      lines.push(`  #${issue.number} [${issue.status}] ${issue.title}`);
    }
  }

  lines.push(
    "",
    "## Stop",
    "",
    "Stop. This report is orientation, not permission to modify a ref.",
    "",
    "Show the human:",
    `  target:             ${target.ref}@${target.sha}`,
    `  source:             ${source.ref}@${source.sha}`,
    `  shared base:        ${orientation.sharedBase}`,
    `  mirror:             ${orientation.mirror}`,
    `  feasibility:        ${feasibilityLine(feasibility)}`,
    `  automerged overlap: ${overlap.automerged.length} files`,
    `  retire candidates:  ${retireCandidates.length}`,
    `  upstream-watch:     ${watchCounts(watch)}`,
    "",
    "Continue only after the human confirms the target.",
    "",
  );
  return lines.join("\n");
};

export interface OrientOutput {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const processOutput: OrientOutput = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

export interface OrientDependencies {
  readonly preflight: (root: string) => PreflightReport;
  readonly orient: (
    root: string,
    options: OrientOptions,
    preflight: PreflightReport,
  ) => Orientation;
}

const readLedger = (root: string): ForkRetirementLedger => readForkRetirementLedger(root);

const systemDependencies: OrientDependencies = {
  preflight: (root) => runPreflight(systemEnv(root)),
  orient: (root, options, preflight) =>
    buildOrientation(
      { git: new ReportGit(root), gh: new SystemGitHub(root) },
      options,
      preflight,
      readLedger(root),
    ),
};

export const run = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  output: OrientOutput = processOutput,
  dependencies: OrientDependencies = systemDependencies,
): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    output.stdout(HELP);
    return 0;
  }
  try {
    const options = parseOrientArgs(argv);
    const root = repositoryRoot(cwd);

    const preflight = dependencies.preflight(root);
    const unmet = unmetRequired(preflight, GATE_ONE_CHECKS);
    if (unmet.length > 0) {
      for (const check of unmet) {
        output.stderr(`blocked: precondition unmet: ${check.name}: ${check.detail}\n`);
        if (check.remedy !== null) output.stderr(`        fix: ${check.remedy}\n`);
      }
      return 1;
    }

    const orientation = dependencies.orient(root, options, preflight);
    output.stdout(renderOrientation(orientation));
    return orientation.watch.error === null ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      output.stderr(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    output.stderr(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

export { parseOrientArgs as parseArgs };

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
