#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This bootstrap command must run before dependencies are installed.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const HELP = `Set up dependencies and canonical environment links for a Git worktree.

Usage: vp run setup:worktree

Options:
  -h, --help  Show this help before making changes.

Output: setup progress and concise link notices on stdout; errors on stderr.
Writes: installs dependencies, updates generated .env symlinks, and warms the web cache.
Exits: 0 on success, 1 on Git/filesystem/child-command failure, 2 on invalid usage.
`;

const LINK_SPECS = [".env", NodePath.join("infra", "relay", ".env")] as const;

export type SetupWorktreeArguments = { readonly kind: "help" } | { readonly kind: "run" };

export type LinkResult = "linked" | "unchanged";

export type RepositoryRoots = {
  readonly canonicalRoot: string;
  readonly worktreeRoot: string;
};

export type EnvironmentLink = {
  readonly sourcePath: string;
  readonly destinationPath: string;
};

export type SetupCommand = {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
};

export type SetupWorktreeDependencies = {
  readonly cwd: string;
  readonly nodeExecutable: string;
  readonly resolveRepositoryRoots: (cwd: string) => RepositoryRoots;
  readonly resolveVpInstallCommand: () => SetupCommand;
  readonly reconcileLinks: (links: readonly EnvironmentLink[]) => readonly LinkResult[];
  readonly runCommand: (command: SetupCommand, cwd: string) => void;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
};

export function parseSetupWorktreeArguments(argv: readonly string[]): SetupWorktreeArguments {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  if (argv.length > 0) throw new Error(`unknown argument: ${argv[0]}`);
  return { kind: "run" };
}

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

function withoutGitEnvironment(
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

function resolveGitDiscoveryEnvironment(cwd: string): NodeJS.ProcessEnv {
  const bootstrapEnvironment = withoutGitEnvironment(process.env, GIT_DISCOVERY_ENVIRONMENT);
  try {
    const localVariableNames = NodeChildProcess.execFileSync(
      "git",
      ["rev-parse", "--local-env-vars"],
      {
        cwd,
        encoding: "utf8",
        env: bootstrapEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
      .split(/\r?\n/u)
      .filter(Boolean);
    return withoutGitEnvironment(bootstrapEnvironment, localVariableNames);
  } catch (error) {
    const stderr = (error as { readonly stderr?: Buffer | string }).stderr;
    const detail = String(stderr ?? (error instanceof Error ? error.message : error)).trim();
    throw new Error(`could not enumerate Git's repository-local environment: ${detail}`, {
      cause: error,
    });
  }
}

function runGitRevParse(
  cwd: string,
  argument: "--git-common-dir" | "--show-toplevel",
  environment: Readonly<NodeJS.ProcessEnv>,
): string {
  try {
    return NodeChildProcess.execFileSync("git", ["rev-parse", "--path-format=absolute", argument], {
      cwd,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { readonly stderr?: Buffer | string }).stderr;
    const detail = String(stderr ?? (error instanceof Error ? error.message : error)).trim();
    throw new Error(`could not resolve Git ${argument} from '${cwd}': ${detail}`, { cause: error });
  }
}

function normalizedPath(value: string): string {
  const normalized = NodePath.normalize(value);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This dependency-free bootstrap runs directly in Node, outside the Effect runtime.
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function resolveRepositoryRoots(cwd: string): RepositoryRoots {
  const environment = resolveGitDiscoveryEnvironment(cwd);
  const worktreeRoot = runGitRevParse(cwd, "--show-toplevel", environment);
  const commonDirectory = runGitRevParse(cwd, "--git-common-dir", environment);

  if (!NodePath.isAbsolute(worktreeRoot) || !NodePath.isAbsolute(commonDirectory)) {
    throw new Error(
      `Git returned a non-absolute repository path: worktree='${worktreeRoot}' common-dir='${commonDirectory}'`,
    );
  }
  if (NodePath.basename(commonDirectory) !== ".git") {
    throw new Error(`unsupported Git common directory layout: '${commonDirectory}'`);
  }

  const canonicalRoot = NodePath.dirname(commonDirectory);
  const canonicalTopLevel = runGitRevParse(canonicalRoot, "--show-toplevel", environment);
  const canonicalCommonDirectory = runGitRevParse(canonicalRoot, "--git-common-dir", environment);
  if (
    normalizedPath(canonicalTopLevel) !== normalizedPath(canonicalRoot) ||
    normalizedPath(canonicalCommonDirectory) !== normalizedPath(commonDirectory)
  ) {
    throw new Error(`unsupported Git common directory layout: '${commonDirectory}'`);
  }

  return { canonicalRoot, worktreeRoot };
}

function readDestination(destinationPath: string): NodeFS.Stats | undefined {
  try {
    return NodeFS.lstatSync(destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function inspectEnvironmentLink(link: EnvironmentLink): LinkResult {
  const sourcePath = NodePath.resolve(link.sourcePath);
  const destinationPath = NodePath.resolve(link.destinationPath);
  if (normalizedPath(sourcePath) === normalizedPath(destinationPath)) return "unchanged";
  const destination = readDestination(destinationPath);

  if (destination?.isSymbolicLink()) {
    const currentTarget = NodeFS.readlinkSync(destinationPath);
    if (
      NodePath.isAbsolute(currentTarget) &&
      normalizedPath(currentTarget) === normalizedPath(sourcePath)
    ) {
      return "unchanged";
    }
  } else if (destination !== undefined) {
    throw new Error(
      `refusing to replace '${destinationPath}' because it exists and is not a symbolic link`,
    );
  }
  return "linked";
}

export function reconcileEnvironmentLinks(
  links: readonly EnvironmentLink[],
): readonly LinkResult[] {
  const results = links.map(inspectEnvironmentLink);
  for (const [index, result] of results.entries()) {
    if (result === "unchanged") continue;
    const link = links[index]!;
    const sourcePath = NodePath.resolve(link.sourcePath);
    const destinationPath = NodePath.resolve(link.destinationPath);
    if (readDestination(destinationPath)?.isSymbolicLink()) NodeFS.unlinkSync(destinationPath);
    NodeFS.symlinkSync(sourcePath, destinationPath, "file");
  }
  return results;
}

export function reconcileEnvironmentLink(sourcePath: string, destinationPath: string): LinkResult {
  return reconcileEnvironmentLinks([{ sourcePath, destinationPath }])[0]!;
}

export function resolveVpInstallCommand(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): SetupCommand {
  const value = environment.VP_CLI_BIN;
  if (value) {
    const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
    if (!pathApi.isAbsolute(value)) {
      throw new Error(`VP_CLI_BIN must be an absolute path; received: '${value}'`);
    }
    return { command: value, args: ["i", "--frozen-lockfile"], shell: false };
  }
  return platform === "win32"
    ? { command: "vp i --frozen-lockfile", args: [], shell: true }
    : { command: "vp", args: ["i", "--frozen-lockfile"], shell: false };
}

function runChildCommand(command: SetupCommand, cwd: string): void {
  const display = [command.command, ...command.args].join(" ");
  const result = NodeChildProcess.spawnSync(command.command, [...command.args], {
    cwd,
    shell: command.shell,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`could not run '${display}': ${result.error.message}`);
  if (result.signal) throw new Error(`'${display}' terminated by signal ${result.signal}`);
  if (result.status !== 0)
    throw new Error(`'${display}' exited with status ${String(result.status)}`);
}

const defaultDependencies: SetupWorktreeDependencies = {
  cwd: process.cwd(),
  nodeExecutable: process.execPath,
  resolveRepositoryRoots,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This dependency-free bootstrap runs before Effect dependencies are guaranteed installed.
  resolveVpInstallCommand: () => resolveVpInstallCommand(process.env, process.platform),
  reconcileLinks: reconcileEnvironmentLinks,
  runCommand: runChildCommand,
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
};

export async function runSetupWorktree(
  argv: readonly string[],
  dependencies: SetupWorktreeDependencies = defaultDependencies,
): Promise<number> {
  let arguments_: SetupWorktreeArguments;
  try {
    arguments_ = parseSetupWorktreeArguments(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStderr(`error: ${message}\nUsage: vp run setup:worktree\n`);
    return 2;
  }

  if (arguments_.kind === "help") {
    dependencies.writeStdout(HELP);
    return 0;
  }

  try {
    const { canonicalRoot, worktreeRoot } = dependencies.resolveRepositoryRoots(dependencies.cwd);
    dependencies.runCommand(dependencies.resolveVpInstallCommand(), worktreeRoot);

    const links = LINK_SPECS.map((relativePath) => ({
      sourcePath: NodePath.join(canonicalRoot, relativePath),
      destinationPath: NodePath.join(worktreeRoot, relativePath),
    }));
    const results = dependencies.reconcileLinks(links);
    for (const [index, result] of results.entries()) {
      if (result !== "linked") continue;
      const relativePath = LINK_SPECS[index]!;
      dependencies.writeStdout(
        `[setup-worktree] linked ${relativePath} -> ${links[index]!.sourcePath}\n`,
      );
    }

    dependencies.runCommand(
      {
        command: dependencies.nodeExecutable,
        args: ["apps/web/scripts/warm-dep-cache.ts"],
        shell: false,
      },
      worktreeRoot,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.writeStderr(`error: ${message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runSetupWorktree(process.argv.slice(2));
