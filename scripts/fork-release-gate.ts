#!/usr/bin/env node

// The release gate: cut only the origin/hyprws tip (what the lease push landed) with a green
// `hyprws CI` conclusion. A stable cut may take an older sha carrying a fork nightly tag, since
// that nightly proves it was once the landed tip. Anything else cuts nothing.
// Preflight runs this before any install, so it imports only node builtins.

import * as NodeUtil from "node:util";

export interface ReleaseGateInput {
  readonly releaseSha: string;
  readonly trunkTip: string;
  /** The hyprws CI conclusion on the release sha; null when no completed run exists. */
  readonly ciConclusion: string | null;
  /** Stable cuts only: a fork nightly tag on the release sha; null for none. */
  readonly landedNightly?: string | null;
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
  const landedNightly = input.landedNightly?.trim() ?? "";
  if (releaseSha !== trunkTip && landedNightly.length === 0) {
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
    reason:
      releaseSha === trunkTip
        ? `release gate open: ${short(releaseSha)} is the hyprws tip with green hyprws CI`
        : `release gate open: ${short(releaseSha)} landed as ${landedNightly} with green hyprws CI`,
  };
};

interface Options {
  readonly releaseSha: string;
  readonly trunkTip: string;
  readonly ciConclusion: string | null;
  readonly landedNightly: string | null;
}

const usage =
  "Usage: node scripts/fork-release-gate.ts --release-sha <sha> --trunk-tip <sha> [--ci-conclusion <conclusion>] [--landed-nightly <tag>]";

export const parseReleaseGateOptions = (argv: ReadonlyArray<string>): Options => {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    options: {
      "release-sha": { type: "string" },
      "trunk-tip": { type: "string" },
      "ci-conclusion": { type: "string" },
      "landed-nightly": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  const releaseSha = values["release-sha"] ?? "";
  const trunkTip = values["trunk-tip"] ?? "";
  if (releaseSha.length === 0) throw new Error("--release-sha requires a sha");
  if (trunkTip.length === 0) throw new Error("--trunk-tip requires a sha");
  return {
    releaseSha,
    trunkTip,
    ciConclusion: values["ci-conclusion"] ?? null,
    landedNightly: values["landed-nightly"] ?? null,
  };
};

if (import.meta.main) {
  try {
    const options = parseReleaseGateOptions(process.argv.slice(2));
    const decision = decideReleaseGate(options);
    process.stdout.write(`${decision.proceed ? "proceed" : "skip"}: ${decision.reason}\n`);
    if (!decision.proceed) process.stdout.write("missing or red means no cut\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
