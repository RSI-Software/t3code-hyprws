#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This standalone Git gate runs before an Effect runtime exists.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  repositoryRoot,
  runPreflight,
  systemEnv,
  unmetChecks,
  type PreflightReport,
} from "./fork-preflight.ts";

const RECORD_DIRECTORY = "docs/operations/fork-sync-records";
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
const EXPECTED_OLD = /^- `expected_old`: `(?<sha>[0-9a-f]{40})`\s*$/m;
const HUMAN_SANITY =
  /^- Human sanity: (?<login>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})) (?<date>\d{4}-\d{2}-\d{2})\s*$/m;

export class UsageError extends Error {}

export interface GateOptions {
  readonly tag: string;
  readonly allowNightly: boolean;
}

export interface GateDependencies {
  readonly preflight: (root: string) => PreflightReport;
}

const systemDependencies: GateDependencies = {
  preflight: (root) => runPreflight(systemEnv(root)),
};

export const parseArgs = (argv: ReadonlyArray<string>): GateOptions => {
  let tag: string | null = null;
  let allowNightly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-nightly") {
      if (allowNightly) throw new UsageError("duplicate option: --allow-nightly");
      allowNightly = true;
      continue;
    }
    if (argument !== "--tag" || tag !== null) {
      throw new UsageError("expected --tag <tag> [--allow-nightly]");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new UsageError("missing value for --tag");
    tag = value;
    index += 1;
  }
  if (tag === null) throw new UsageError("expected --tag <tag> [--allow-nightly]");
  if (!STABLE_TAG.test(tag) && !(allowNightly && NIGHTLY_TAG.test(tag))) {
    throw new UsageError(
      allowNightly
        ? `tag must be vX.Y.Z or vX.Y.Z-nightly.YYYYMMDD.N: ${tag}`
        : `tag must be stable vX.Y.Z: ${tag}`,
    );
  }
  return { tag, allowNightly };
};

const isCalendarDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};

const headerBody = (record: string): string => {
  const heading = /^## Header\s*$/m.exec(record);
  if (heading === null) return "";
  const rest = record.slice(heading.index + heading[0].length).replace(/^\s*\n/, "");
  const nextHeading = /^## /m.exec(rest);
  return nextHeading === null ? rest : rest.slice(0, nextHeading.index);
};

export const inspectRecord = (record: string, liveExpectedOld: string): ReadonlyArray<string> => {
  const findings: Array<string> = [];
  const header = headerBody(record);
  const expectedOld = EXPECTED_OLD.exec(header)?.groups?.sha;
  if (expectedOld === undefined) {
    findings.push("record header missing `expected_old` full SHA");
  } else if (expectedOld !== liveExpectedOld) {
    findings.push(`expected_old mismatch: record ${expectedOld}, origin/hyprws ${liveExpectedOld}`);
  }

  const sanity = HUMAN_SANITY.exec(header)?.groups;
  if (!sanity?.login || !sanity.date || !isCalendarDate(sanity.date)) {
    findings.push('missing Human sanity mark: expected "Human sanity: <login> YYYY-MM-DD"');
  }
  return findings;
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
    const { tag } = parseArgs(argv);
    const root = repositoryRoot(cwd);

    // Preconditions first, and the published head only from the preflight that
    // fetched it. Resolving `origin/hyprws` here would compare the lease against
    // whatever the last unrelated fetch happened to leave behind.
    const preflight = dependencies.preflight(root);
    const unmet = unmetChecks(preflight);
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

    const relativeRecord = `${RECORD_DIRECTORY}/${tag}.md`;
    const recordPath = NodePath.join(root, relativeRecord);
    if (!NodeFS.existsSync(recordPath)) {
      output.stderr(`blocked: missing rehearsal record ${relativeRecord}\n`);
      return 1;
    }

    const findings = inspectRecord(NodeFS.readFileSync(recordPath, "utf8"), liveExpectedOld);
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
