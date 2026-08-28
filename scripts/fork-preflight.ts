#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone Git preflight runs before an Effect runtime exists.

// Checks the preconditions the fork-sync gates depend on and names every unmet
// one before a gate acts. The two fetch checks are the reason this exists: a
// gate that reads `origin/hyprws` without fetching it compares a lease against a
// ref that may be hours stale, and reports `ready` for a head that already moved.
// Callers therefore take the published head from `PreflightReport.originHyprwsSha`
// rather than resolving the ref themselves.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { canonicalRepository } from "./fork-rebase-report.ts";

export const ORIGIN_REPOSITORY = "RSI-Software/t3code-hyprws";
export const UPSTREAM_REPOSITORY = "pingdotgg/t3code";

export const CHECK_ORIGIN_REMOTE = "origin remote";
export const CHECK_UPSTREAM_REMOTE = "upstream remote";
export const CHECK_RERERE = "rerere.enabled";
export const CHECK_ORIGIN_FETCH = "origin/hyprws fetched fresh";
export const CHECK_MIRROR = "upstream mirror current";
export const CHECK_DEPENDENCIES = "dependencies installed";

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PreflightEnv {
  readonly git: (args: ReadonlyArray<string>) => CommandResult;
  readonly directoryExists: (relativePath: string) => boolean;
}

export interface PreflightCheck {
  readonly name: string;
  readonly met: boolean;
  readonly detail: string;
  readonly remedy: string | null;
}

export interface PreflightReport {
  readonly checks: ReadonlyArray<PreflightCheck>;
  /** The published head read after this run's fetch, or null when it was not proved fresh. */
  readonly originHyprwsSha: string | null;
}

export class UsageError extends Error {}

const met = (name: string, detail: string): PreflightCheck => ({
  name,
  met: true,
  detail,
  remedy: null,
});

const unmet = (name: string, detail: string, remedy: string): PreflightCheck => ({
  name,
  met: false,
  detail,
  remedy,
});

const firstLine = (value: string): string => value.trim().split("\n")[0]?.trim() ?? "";

const failureDetail = (command: string, result: CommandResult): string => {
  const reason = firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.status}`;
  return `${command} failed: ${reason}`;
};

const checkRemote = (
  env: PreflightEnv,
  name: string,
  remote: string,
  expected: string,
): PreflightCheck => {
  const result = env.git(["remote", "get-url", remote]);
  const setUrl = `git remote add ${remote} git@github.com:${expected}.git`;
  if (result.status !== 0) {
    return unmet(name, `remote \`${remote}\` is not configured`, setUrl);
  }
  const url = result.stdout.trim();
  const slug = canonicalRepository(url).slug;
  if (slug === null || slug.toLowerCase() !== expected.toLowerCase()) {
    return unmet(
      name,
      `remote \`${remote}\` points at ${slug ?? url}, expected ${expected}`,
      setUrl,
    );
  }
  return met(name, `${remote} -> ${expected}`);
};

const checkRerere = (env: PreflightEnv): PreflightCheck => {
  const result = env.git(["config", "--get", "rerere.enabled"]);
  const value = result.stdout.trim();
  if (result.status === 0 && (value === "true" || value === "1")) {
    return met(CHECK_RERERE, "true, so a resolved conflict replays on the next sync");
  }
  return unmet(
    CHECK_RERERE,
    value.length === 0 ? "unset" : `set to ${value}`,
    "git config --global rerere.enabled true",
  );
};

interface OriginFetch {
  readonly check: PreflightCheck;
  readonly sha: string | null;
}

const checkOriginFetch = (env: PreflightEnv, remoteUsable: boolean): OriginFetch => {
  if (!remoteUsable) {
    return {
      check: unmet(
        CHECK_ORIGIN_FETCH,
        `not attempted: the ${CHECK_ORIGIN_REMOTE} precondition is unmet`,
        `resolve ${CHECK_ORIGIN_REMOTE} first`,
      ),
      sha: null,
    };
  }
  // A forced refspec, because an applied sync rewrites the published head and a
  // fast-forward-only fetch would leave the stale ref in place.
  const fetched = env.git(["fetch", "origin", "+refs/heads/hyprws:refs/remotes/origin/hyprws"]);
  if (fetched.status !== 0) {
    return {
      check: unmet(
        CHECK_ORIGIN_FETCH,
        failureDetail("git fetch origin hyprws", fetched),
        "restore network access or credentials for origin, then rerun",
      ),
      sha: null,
    };
  }
  const resolved = env.git(["rev-parse", "origin/hyprws^{commit}"]);
  if (resolved.status !== 0) {
    return {
      check: unmet(
        CHECK_ORIGIN_FETCH,
        failureDetail("git rev-parse origin/hyprws", resolved),
        "confirm origin publishes a hyprws branch",
      ),
      sha: null,
    };
  }
  const sha = resolved.stdout.trim();
  return {
    check: met(CHECK_ORIGIN_FETCH, `origin/hyprws ${sha} read after this run's fetch`),
    sha,
  };
};

const checkMirror = (env: PreflightEnv, remotesUsable: boolean): PreflightCheck => {
  if (!remotesUsable) {
    return unmet(
      CHECK_MIRROR,
      `not attempted: the ${CHECK_ORIGIN_REMOTE} or ${CHECK_UPSTREAM_REMOTE} precondition is unmet`,
      "resolve the remote preconditions first",
    );
  }
  const fetchedUpstream = env.git(["fetch", "upstream", "--tags"]);
  if (fetchedUpstream.status !== 0) {
    return unmet(
      CHECK_MIRROR,
      failureDetail("git fetch upstream --tags", fetchedUpstream),
      "restore network access to upstream, then rerun",
    );
  }
  const fetchedMain = env.git(["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  if (fetchedMain.status !== 0) {
    return unmet(
      CHECK_MIRROR,
      failureDetail("git fetch origin main", fetchedMain),
      "restore network access or credentials for origin, then rerun",
    );
  }
  const origin = env.git(["rev-parse", "origin/main^{commit}"]);
  const upstream = env.git(["rev-parse", "upstream/main^{commit}"]);
  if (origin.status !== 0 || upstream.status !== 0) {
    const failed = origin.status !== 0 ? origin : upstream;
    const ref = origin.status !== 0 ? "origin/main" : "upstream/main";
    return unmet(
      CHECK_MIRROR,
      failureDetail(`git rev-parse ${ref}`, failed),
      "fetch both remotes, then rerun",
    );
  }
  const originSha = origin.stdout.trim();
  const upstreamSha = upstream.stdout.trim();
  if (originSha !== upstreamSha) {
    return unmet(
      CHECK_MIRROR,
      `origin/main ${originSha.slice(0, 12)}, upstream/main ${upstreamSha.slice(0, 12)}`,
      "dispatch hyprws-rebase-report.yml, or push the mirror with git push origin upstream/main:main",
    );
  }
  return met(CHECK_MIRROR, `origin/main matches upstream/main at ${originSha.slice(0, 12)}`);
};

const checkDependencies = (env: PreflightEnv): PreflightCheck =>
  env.directoryExists("node_modules")
    ? met(CHECK_DEPENDENCIES, "node_modules is present")
    : unmet(CHECK_DEPENDENCIES, "node_modules is absent", "vp i");

export const runPreflight = (env: PreflightEnv): PreflightReport => {
  const originRemote = checkRemote(env, CHECK_ORIGIN_REMOTE, "origin", ORIGIN_REPOSITORY);
  const upstreamRemote = checkRemote(env, CHECK_UPSTREAM_REMOTE, "upstream", UPSTREAM_REPOSITORY);
  const originFetch = checkOriginFetch(env, originRemote.met);
  const mirror = checkMirror(env, originRemote.met && upstreamRemote.met);
  return {
    checks: [
      originRemote,
      upstreamRemote,
      checkRerere(env),
      originFetch.check,
      mirror,
      checkDependencies(env),
    ],
    originHyprwsSha: originFetch.sha,
  };
};

export const unmetChecks = (report: PreflightReport): ReadonlyArray<PreflightCheck> =>
  report.checks.filter((check) => !check.met);

export const renderReport = (report: PreflightReport): string => {
  const lines = ["fork-sync preflight"];
  for (const check of report.checks) {
    lines.push(`  ${check.met ? "met  " : "unmet"} ${check.name}: ${check.detail}`);
    if (check.remedy !== null) lines.push(`        fix: ${check.remedy}`);
  }
  const unmetNames = unmetChecks(report).map((check) => check.name);
  lines.push("");
  lines.push(
    unmetNames.length === 0
      ? `preflight passed: ${report.checks.length} preconditions met`
      : `${unmetNames.length} unmet precondition${unmetNames.length === 1 ? "" : "s"}: ${unmetNames.join(", ")}`,
  );
  return `${lines.join("\n")}\n`;
};

export const systemEnv = (root: string): PreflightEnv => ({
  git: (args) => {
    const result = NodeChildProcess.spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
  directoryExists: (relativePath) => NodeFS.existsSync(NodePath.join(root, relativePath)),
});

export const repositoryRoot = (cwd: string): string => {
  const result = NodeChildProcess.spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  const root = (result.stdout ?? "").trim();
  if (result.status !== 0 || root.length === 0) {
    throw new Error(`not inside a Git repository: ${cwd}`);
  }
  return root;
};

export interface PreflightOutput {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

const processOutput: PreflightOutput = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

const HELP = `Usage: vp run fork:preflight

Check every precondition the fork-sync gates depend on and name each unmet one.
Fetches origin/hyprws and upstream so ref freshness is proved, never assumed.

Options:
  -h, --help   Show help

Exit codes:
  0  every precondition is met
  1  at least one precondition is unmet
  2  usage error
`;

export const parseArgs = (argv: ReadonlyArray<string>): void => {
  for (const argument of argv) {
    if (argument === "-h" || argument === "--help") continue;
    throw new UsageError(`unknown option: ${argument}`);
  }
};

export const run = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  output: PreflightOutput = processOutput,
): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    output.stdout(HELP);
    return 0;
  }
  try {
    parseArgs(argv);
    const report = runPreflight(systemEnv(repositoryRoot(cwd)));
    output.stdout(renderReport(report));
    return unmetChecks(report).length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      output.stderr(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    output.stderr(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
