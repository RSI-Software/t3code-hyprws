#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This standalone Git gate runs before an Effect runtime exists.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseArgs as parseCliArgs, UsageError } from "./lib/fork-cli.ts";
import { runCommandText } from "./lib/fork-command.ts";
import {
  repositoryRoot,
  runPreflight,
  systemEnv,
  TAG_PINNED_CHECKS,
  unmetRequired,
  type PreflightReport,
} from "./fork-preflight.ts";
import { parseUpstreamReleaseTag } from "./lib/fork-policy.ts";
import { readReport, type SyncReport } from "./fork-sync-state.ts";

export { UsageError } from "./lib/fork-cli.ts";

export interface GateOptions {
  readonly tag: string;
  readonly reportPath: string;
  readonly allowNightly: boolean;
}

export interface GateDependencies {
  readonly preflight: (root: string) => PreflightReport;
  readonly git: (root: string, args: ReadonlyArray<string>) => string;
}

const systemDependencies: GateDependencies = {
  preflight: (root) => runPreflight(systemEnv(root)),
  git: (root, args) => runCommandText("git", args, { cwd: root }).trim(),
};

export const parseGateArgs = (argv: ReadonlyArray<string>): GateOptions => {
  const parsed = parseCliArgs(argv, {
    values: ["--tag", "--report"],
    flags: ["--allow-nightly"],
  });
  const tag = parsed.values.get("--tag") ?? null;
  const reportPath = parsed.values.get("--report") ?? null;
  const allowNightly = parsed.flags.has("--allow-nightly");
  if (tag === null || reportPath === null) {
    throw new UsageError("expected --tag <tag> --report <path> [--allow-nightly]");
  }
  const parsedTag = parseUpstreamReleaseTag(tag);
  if (parsedTag === null || (parsedTag.channel === "nightly" && !allowNightly)) {
    throw new UsageError(
      allowNightly
        ? `tag must be vX.Y.Z or vX.Y.Z-nightly.YYYYMMDD.N: ${tag}`
        : `tag must be stable vX.Y.Z: ${tag}`,
    );
  }
  return { tag, reportPath, allowNightly };
};

export { parseGateArgs as parseArgs };

export interface CheckoutBinding {
  readonly targetTag: string;
  readonly targetSha: string;
  readonly expectedOld: string;
  readonly rebasedHead: string;
  readonly stackSize: string;
}

/** Compare the walk's own typed report against what this checkout actually holds. */
export const inspectReport = (
  report: SyncReport,
  observed: CheckoutBinding,
): ReadonlyArray<string> => {
  const findings: Array<string> = [];
  const compare = (field: string, recorded: string | undefined, seen: string): void => {
    if (recorded === undefined || recorded === "") findings.push(`report is missing ${field}`);
    else if (recorded !== seen) findings.push(`${field} mismatch: report ${recorded}, ${seen}`);
  };
  compare("expected_old", report.source?.expectedOld, observed.expectedOld);
  compare(
    "Target",
    report.target === undefined ? undefined : `${report.target.tag}@${report.target.sha}`,
    `${observed.targetTag}@${observed.targetSha}`,
  );
  compare("Rebased head", report.rebasedHead, observed.rebasedHead);
  compare(
    "Stack size",
    report.stackSize === undefined ? undefined : String(report.stackSize),
    observed.stackSize,
  );
  return findings;
};

const isInside = (directory: string, candidate: string): boolean => {
  const relative = NodePath.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== "..");
};

export interface GateOutput {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const processOutput: GateOutput = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

export const run = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  output: GateOutput = processOutput,
  dependencies: GateDependencies = systemDependencies,
): number => {
  try {
    const { tag, reportPath } = parseGateArgs(argv);
    const root = repositoryRoot(cwd);

    // Preconditions first, and the published head only from the preflight that
    // fetched it. Resolving `origin/hyprws` here would compare the lease against
    // whatever the last unrelated fetch happened to leave behind. The slice is
    // pinned to a tag by the time it reaches this gate, so mirror currency is
    // reported by the preflight and not required here.
    const preflight = dependencies.preflight(root);
    const unmet = unmetRequired(preflight, TAG_PINNED_CHECKS);
    if (unmet.length > 0) {
      for (const check of unmet) {
        output.stderr(`blocked: precondition unmet: ${check.name}: ${check.detail}\n`);
        if (check.remedy !== null) output.stderr(`        fix: ${check.remedy}\n`);
      }
      return 1;
    }
    const liveExpectedOld = preflight.originHyprwsSha;
    if (liveExpectedOld === null) {
      output.stderr("blocked: preflight reported no freshly fetched origin/hyprws head\n");
      return 1;
    }

    const resolvedReportPath = NodePath.resolve(cwd, reportPath);
    if (!NodeFS.existsSync(resolvedReportPath) || !NodeFS.statSync(resolvedReportPath).isFile()) {
      output.stderr(`blocked: missing walk report ${resolvedReportPath}\n`);
      return 1;
    }
    const realRoot = NodeFS.realpathSync(root);
    if (
      isInside(root, resolvedReportPath) ||
      isInside(realRoot, NodeFS.realpathSync(resolvedReportPath))
    ) {
      output.stderr(`blocked: walk report must be outside the repository: ${resolvedReportPath}\n`);
      return 1;
    }

    const targetSha = dependencies.git(root, [
      "rev-parse",
      "--verify",
      `refs/tags/${tag}^{commit}`,
    ]);
    const rebasedHead = dependencies.git(root, ["rev-parse", "HEAD"]);
    const stackSize = dependencies.git(root, [
      "rev-list",
      "--count",
      `${targetSha}..${rebasedHead}`,
    ]);
    const findings = inspectReport(readReport(resolvedReportPath), {
      targetTag: tag,
      targetSha,
      expectedOld: liveExpectedOld,
      rebasedHead,
      stackSize,
    });
    if (findings.length > 0) {
      for (const finding of findings) output.stderr(`blocked: ${finding}\n`);
      return 1;
    }
    output.stdout(`ready: ${tag} apply gate passed at ${liveExpectedOld}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      output.stderr(`usage: ${error.message}\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    output.stderr(`failed: ${message}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
