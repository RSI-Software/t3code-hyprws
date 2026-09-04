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
export function resolveMainCheckoutFromGit(
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  const bootstrap = withoutGitEnvironment(environment, GIT_DISCOVERY_ENVIRONMENT);
  const localNames = runGit(cwd, ["rev-parse", "--local-env-vars"], bootstrap)
    .split(/\r?\n/u)
    .filter(Boolean);
  const env = withoutGitEnvironment(bootstrap, localNames);
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
