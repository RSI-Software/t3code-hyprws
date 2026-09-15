// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Fork seams for `scripts/setup-worktree.ts`. Managed zmux sessions type the
 * setup command into a long-lived shell that never received the runner's
 * `T3CODE_PROJECT_ROOT`, so the main checkout falls back to Git discovery.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const GIT_DISCOVERY_ENVIRONMENT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_PREFIX",
] as const;

export function withoutGitEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
  variableNames: readonly string[],
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  const excluded = new Set(variableNames.map((variableName) => variableName.toUpperCase()));
  for (const variableName of Object.keys(sanitized)) {
    if (excluded.has(variableName.toUpperCase())) delete sanitized[variableName];
  }
  return sanitized;
}

function runGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
  try {
    return NodeChildProcess.execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { readonly stderr?: Buffer | string }).stderr;
    const detail = String(stderr ?? (error instanceof Error ? error.message : error)).trim();
    throw new Error(`git ${args.join(" ")} failed in '${cwd}': ${detail}`, { cause: error });
  }
}

/** The main checkout owning `cwd`, resolved with every inherited `GIT_*` override stripped. */
function gitDiscoveryEnvironment(
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const bootstrap = withoutGitEnvironment(environment, GIT_DISCOVERY_ENVIRONMENT);
  const localNames = runGit(cwd, ["rev-parse", "--local-env-vars"], bootstrap)
    .split(/\r?\n/u)
    .filter(Boolean);
  return withoutGitEnvironment(bootstrap, localNames);
}

export function resolveMainCheckoutFromGit(
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const env = gitDiscoveryEnvironment(cwd, environment);
  const commonDirectory = runGit(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    env,
  );
  if (!NodePath.isAbsolute(commonDirectory) || NodePath.basename(commonDirectory) !== ".git") {
    throw new Error(`unsupported Git common directory layout: '${commonDirectory}'`);
  }
  return NodePath.dirname(commonDirectory);
}

/** `T3CODE_PROJECT_ROOT` when it names an existing directory, else the Git-derived main checkout. */
export function resolveSetupProjectRoot(
  environment: Readonly<NodeJS.ProcessEnv>,
  cwd: string,
): string {
  const fromEnvironment = environment.T3CODE_PROJECT_ROOT;
  if (fromEnvironment && NodeFS.statSync(fromEnvironment, { throwIfNoEntry: false })?.isDirectory())
    return fromEnvironment;
  return resolveMainCheckoutFromGit(cwd, environment);
}

/** A regular file at the link target is user-owned and kept; only links or absence are replaced. */
export function shouldReplaceEnvTarget(target: string): boolean {
  const stats = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  return stats === undefined || stats.isSymbolicLink();
}

export type GitCapture = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CaptureGit = (cwd: string, args: readonly string[]) => GitCapture;

export type TrunkBaseAssessment =
  | {
      readonly kind: "assessed";
      readonly contained: boolean;
      readonly headSha: string;
      readonly publishedSha: string;
      readonly localTrunkSha: string | undefined;
    }
  | { readonly kind: "skipped"; readonly reason: string };

export function captureGit(cwd: string, args: readonly string[]): GitCapture {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: gitDiscoveryEnvironment(cwd, process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status ?? -1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function lastErrorLine(value: string): string {
  const lines = value.trim().split(/\r?\n/u);
  return lines[lines.length - 1] ?? "";
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function assessTrunkBase(capture: CaptureGit, worktreeRoot: string): TrunkBaseAssessment {
  const fetch = capture(worktreeRoot, ["fetch", "origin", "hyprws"]);
  if (fetch.code !== 0) {
    return {
      kind: "skipped",
      reason: `could not fetch origin hyprws: ${lastErrorLine(fetch.stderr) || "unknown error"}`,
    };
  }
  const published = capture(worktreeRoot, ["rev-parse", "--verify", "refs/remotes/origin/hyprws"]);
  if (published.code !== 0) {
    return { kind: "skipped", reason: "origin/hyprws not found after the fetch" };
  }
  const head = capture(worktreeRoot, ["rev-parse", "HEAD"]);
  if (head.code !== 0) {
    return { kind: "skipped", reason: "the worktree HEAD does not resolve" };
  }
  const reachability = capture(worktreeRoot, ["branch", "-r", "--contains", head.stdout.trim()]);
  if (reachability.code !== 0) {
    return {
      kind: "skipped",
      reason: `could not list remote refs containing HEAD: ${lastErrorLine(reachability.stderr) || "unknown error"}`,
    };
  }
  const localTrunk = capture(worktreeRoot, ["rev-parse", "--verify", "refs/heads/hyprws"]);
  return {
    kind: "assessed",
    contained: reachability.stdout.trim().length > 0,
    headSha: head.stdout.trim(),
    publishedSha: published.stdout.trim(),
    localTrunkSha: localTrunk.code === 0 ? localTrunk.stdout.trim() : undefined,
  };
}

/**
 * Refuse a worktree cut from stale trunk history before anything installs, and
 * note a drifted local `hyprws`. A failed fetch or missing ref only skips.
 */
export function checkTrunkBase(
  worktreeRoot: string,
  projectRoot: string,
  capture: CaptureGit = captureGit,
  writeStdout: (value: string) => void = (value) => process.stdout.write(value),
): void {
  const assessment = assessTrunkBase(capture, worktreeRoot);
  if (assessment.kind === "skipped") {
    writeStdout(`[setup-worktree] skipped the trunk-base check: ${assessment.reason}\n`);
    return;
  }
  if (!assessment.contained) {
    throw new Error(
      `this worktree's HEAD (${shortSha(assessment.headSha)}) is contained in no remote-tracking ref: ` +
        "the branch was cut from stale trunk history. " +
        "Fix it here with 'git reset --hard origin/hyprws', or recreate it from a fresh remote base with " +
        "'wt switch --create <branch> --base origin/hyprws', then rerun setup.",
    );
  }
  if (
    assessment.localTrunkSha !== undefined &&
    assessment.localTrunkSha !== assessment.publishedSha
  ) {
    writeStdout(
      `[setup-worktree] notice: local 'hyprws' (${shortSha(assessment.localTrunkSha)}) is behind or diverged from origin/hyprws (${shortSha(assessment.publishedSha)}); ` +
        `reset it in the canonical checkout: git -C ${projectRoot} reset --hard origin/hyprws\n`,
    );
  }
}
