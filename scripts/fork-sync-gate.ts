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

const TARGET = /^- Target: `(?<tag>[^`\s@]+)@(?<sha>[0-9a-f]{40})`\s*$/m;
const EXPECTED_OLD = /^- `expected_old`: `(?<sha>[0-9a-f]{40})`\s*$/m;
const REBASED_HEAD = /^- Rebased head: `(?<sha>[0-9a-f]{40})`\s*$/m;
const STACK_SIZE = /^- Stack size: `(?<count>0|[1-9]\d*)` fork commits\s*$/m;

export { UsageError } from "./lib/fork-cli.ts";

export interface GateOptions {
  readonly tag: string;
  readonly recordPath: string;
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
    values: ["--tag", "--record"],
    flags: ["--allow-nightly"],
  });
  const tag = parsed.values.get("--tag") ?? null;
  const recordPath = parsed.values.get("--record") ?? null;
  const allowNightly = parsed.flags.has("--allow-nightly");
  if (tag === null || recordPath === null) {
    throw new UsageError("expected --tag <tag> --record <path> [--allow-nightly]");
  }
  const parsedTag = parseUpstreamReleaseTag(tag);
  if (parsedTag === null || (parsedTag.channel === "nightly" && !allowNightly)) {
    throw new UsageError(
      allowNightly
        ? `tag must be vX.Y.Z or vX.Y.Z-nightly.YYYYMMDD.N: ${tag}`
        : `tag must be stable vX.Y.Z: ${tag}`,
    );
  }
  return { tag, recordPath, allowNightly };
};

export { parseGateArgs as parseArgs };

const headerBody = (record: string): string => {
  const heading = /^## Header\s*$/m.exec(record);
  if (heading === null) return "";
  const rest = record.slice(heading.index + heading[0].length).replace(/^\s*\n/, "");
  const nextHeading = /^## /m.exec(rest);
  return nextHeading === null ? rest : rest.slice(0, nextHeading.index);
};

export interface CheckoutBinding {
  readonly targetTag: string;
  readonly targetSha: string;
  readonly expectedOld: string;
  readonly rebasedHead: string;
  readonly stackSize: string;
}

export const inspectRecord = (record: string, observed: CheckoutBinding): ReadonlyArray<string> => {
  const findings: Array<string> = [];
  const header = headerBody(record);
  const expectedOld = EXPECTED_OLD.exec(header)?.groups?.sha;
  if (expectedOld === undefined) {
    findings.push("record header missing `expected_old` full SHA");
  } else if (expectedOld !== observed.expectedOld) {
    findings.push(
      `expected_old mismatch: record ${expectedOld}, origin/hyprws ${observed.expectedOld}`,
    );
  }

  const target = TARGET.exec(header)?.groups;
  if (!target?.tag || !target.sha) {
    findings.push("record header missing Target tag and full SHA");
  } else {
    const recordedTarget = `${target.tag}@${target.sha}`;
    const observedTarget = `${observed.targetTag}@${observed.targetSha}`;
    if (recordedTarget !== observedTarget) {
      findings.push(`Target mismatch: record ${recordedTarget}, checkout ${observedTarget}`);
    }
  }

  const rebasedHead = REBASED_HEAD.exec(header)?.groups?.sha;
  if (rebasedHead === undefined) {
    findings.push("record header missing Rebased head full SHA");
  } else if (rebasedHead !== observed.rebasedHead) {
    findings.push(`Rebased head mismatch: record ${rebasedHead}, checkout ${observed.rebasedHead}`);
  }

  const stackSize = STACK_SIZE.exec(header)?.groups?.count;
  if (stackSize === undefined) {
    findings.push("record header missing Stack size");
  } else if (stackSize !== observed.stackSize) {
    findings.push(`Stack size mismatch: record ${stackSize}, checkout ${observed.stackSize}`);
  }
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
    const { tag, recordPath } = parseGateArgs(argv);
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

    const resolvedRecordPath = NodePath.resolve(cwd, recordPath);
    if (!NodeFS.existsSync(resolvedRecordPath)) {
      output.stderr(`blocked: missing rehearsal record ${resolvedRecordPath}\n`);
      return 1;
    }
    if (!NodeFS.statSync(resolvedRecordPath).isFile()) {
      output.stderr(`blocked: rehearsal record is not a file: ${resolvedRecordPath}\n`);
      return 1;
    }
    const realRoot = NodeFS.realpathSync(root);
    const realRecordPath = NodeFS.realpathSync(resolvedRecordPath);
    if (isInside(root, resolvedRecordPath) || isInside(realRoot, realRecordPath)) {
      output.stderr(
        `blocked: rehearsal record must be outside the repository: ${resolvedRecordPath}\n`,
      );
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
    const findings = inspectRecord(NodeFS.readFileSync(realRecordPath, "utf8"), {
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
