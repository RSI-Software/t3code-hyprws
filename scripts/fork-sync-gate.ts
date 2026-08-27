#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This standalone Git gate runs before an Effect runtime exists.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const RECORD_DIRECTORY = "docs/operations/fork-sync-records";
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const EXPECTED_OLD = /^- `expected_old`: `(?<sha>[0-9a-f]{40})`\s*$/m;
const HUMAN_SANITY =
  /^- Human sanity: (?<login>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})) (?<date>\d{4}-\d{2}-\d{2})\s*$/m;

export class UsageError extends Error {}

export interface GateOptions {
  readonly tag: string;
}

export interface GitReader {
  run(args: ReadonlyArray<string>): string;
}

export class SystemGit implements GitReader {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  run(args: ReadonlyArray<string>): string {
    return NodeChildProcess.execFileSync("git", [...args], {
      cwd: this.cwd,
      encoding: "utf8",
    });
  }
}

export const parseArgs = (argv: ReadonlyArray<string>): GateOptions => {
  if (argv.length !== 2 || argv[0] !== "--tag" || !argv[1]) {
    throw new UsageError("expected --tag <stable-tag>");
  }
  if (!STABLE_TAG.test(argv[1])) {
    throw new UsageError(`tag must be stable vX.Y.Z: ${argv[1]}`);
  }
  return { tag: argv[1] };
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
): number => {
  try {
    const { tag } = parseArgs(argv);
    const bootstrapGit = new SystemGit(cwd);
    const root = bootstrapGit.run(["rev-parse", "--show-toplevel"]).trim();
    const git = new SystemGit(root);
    const relativeRecord = `${RECORD_DIRECTORY}/${tag}.md`;
    const recordPath = NodePath.join(root, relativeRecord);
    if (!NodeFS.existsSync(recordPath)) {
      output.stderr(`blocked: missing rehearsal record ${relativeRecord}\n`);
      return 1;
    }

    const liveExpectedOld = git.run(["rev-parse", "origin/hyprws^{commit}"]).trim();
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
