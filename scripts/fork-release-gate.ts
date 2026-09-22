#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off - This release helper runs before an Effect runtime exists.

// The release gate: a cut happens only for what the lease push landed, proven
// green. The release sha must be the current tip of origin/hyprws (so it is
// what the lease push moved the trunk to) AND that sha must carry a green
// `hyprws CI` conclusion. A green sha that is no longer the tip, or a tip
// whose battery never ran green, cuts nothing. Missing or red means no cut.

import * as NodeFS from "node:fs";

import { parseArgs, UsageError } from "./lib/fork-cli.ts";

export interface ReleaseGateInput {
  readonly releaseSha: string;
  readonly trunkTip: string;
  /** The hyprws CI conclusion on the release sha; null when no completed run exists. */
  readonly ciConclusion: string | null;
}

export interface ReleaseGateDecision {
  readonly proceed: boolean;
  readonly reason: string;
}

const short = (sha: string): string => sha.slice(0, 12);

export const decideReleaseGate = (input: ReleaseGateInput): ReleaseGateDecision => {
  const releaseSha = input.releaseSha.trim().toLowerCase();
  const trunkTip = input.trunkTip.trim().toLowerCase();
  if (releaseSha.length === 0 || trunkTip.length === 0) {
    return {
      proceed: false,
      reason: "release gate closed: the release sha or the hyprws tip is missing",
    };
  }
  if (releaseSha !== trunkTip) {
    return {
      proceed: false,
      reason:
        `release gate closed: ${short(releaseSha)} is not the hyprws tip ${short(trunkTip)}, ` +
        "so it is not what the lease push landed",
    };
  }
  const conclusion = (input.ciConclusion ?? "").trim().toLowerCase();
  if (conclusion !== "success") {
    return {
      proceed: false,
      reason:
        `release gate closed: hyprws CI on ${short(releaseSha)} is ` +
        `${conclusion.length === 0 ? "missing" : conclusion}, not success`,
    };
  }
  return {
    proceed: true,
    reason: `release gate open: ${short(releaseSha)} is the hyprws tip with green hyprws CI`,
  };
};

interface Options {
  readonly releaseSha: string;
  readonly trunkTip: string;
  readonly ciConclusion: string | null;
  readonly githubOutput: boolean;
}

const usage =
  "Usage: node scripts/fork-release-gate.ts --release-sha <sha> --trunk-tip <sha> [--ci-conclusion <conclusion>] [--github-output]";

export const parseReleaseGateOptions = (argv: ReadonlyArray<string>): Options => {
  const parsed = parseArgs(argv, {
    values: ["--release-sha", "--trunk-tip", "--ci-conclusion"],
    flags: ["--github-output", "--help", "-h"],
  });
  if (parsed.flags.has("--help") || parsed.flags.has("-h")) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  const releaseSha = parsed.values.get("--release-sha") ?? "";
  const trunkTip = parsed.values.get("--trunk-tip") ?? "";
  if (releaseSha.length === 0) throw new UsageError("--release-sha requires a sha");
  if (trunkTip.length === 0) throw new UsageError("--trunk-tip requires a sha");
  return {
    releaseSha,
    trunkTip,
    ciConclusion: parsed.values.get("--ci-conclusion") ?? null,
    githubOutput: parsed.flags.has("--github-output"),
  };
};

export const renderGateOutput = (decision: ReleaseGateDecision): string =>
  `gate_proceed=${decision.proceed ? "true" : "false"}\ngate_reason=${decision.reason}\n`;

if (import.meta.main) {
  try {
    const options = parseReleaseGateOptions(process.argv.slice(2));
    const decision = decideReleaseGate(options);
    if (options.githubOutput) {
      const outputPath = process.env.GITHUB_OUTPUT;
      if (outputPath === undefined || outputPath.length === 0) {
        throw new Error("GITHUB_OUTPUT is required with --github-output");
      }
      NodeFS.appendFileSync(outputPath, renderGateOutput(decision));
    } else {
      process.stdout.write(`${decision.proceed ? "proceed" : "skip"}: ${decision.reason}\n`);
    }
    if (!decision.proceed) process.stdout.write("missing or red means no cut\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
