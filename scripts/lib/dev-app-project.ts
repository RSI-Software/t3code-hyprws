// @effect-diagnostics nodeBuiltinImport:off - Dev fixtures are prepared before the Effect runtime starts.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  commandText,
  type CwdCommandRunner,
  SystemCommandRunner,
  SystemGit,
} from "./fork-command.ts";
import { withoutInheritedDevRunnerEnv } from "./dev-desktop-agent.ts";

export const DEV_APP_PROJECT_RELATIVE_PATH = NodePath.join(".t3", "test-project");
export const DEV_APP_PROJECT_TITLE = "T3 Code Dev Fixture";

const FIXTURE_FILES = {
  "README.md": `# T3 Code Dev Fixture

This repository is safe to edit while testing the development app.
Changes and untracked files are retained across restarts.
`,
  "src/greeting.ts": `export const greeting = "Hello from the T3 Code dev fixture";
`,
} as const;

export interface DevAppProjectFixture {
  readonly root: string;
  readonly created: boolean;
}

export interface RegisterDevAppProjectOptions {
  readonly checkoutRoot: string;
  readonly baseDir: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly runner?: CwdCommandRunner;
}

export type DevAppProjectRegistration = "added" | "already-registered";

function writeMissingFixtureFiles(root: string): void {
  for (const [relativePath, contents] of Object.entries(FIXTURE_FILES)) {
    const path = NodePath.join(root, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    try {
      NodeFS.writeFileSync(path, contents, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function assertFixtureRepository(root: string, git: SystemGit): void {
  const gitPath = NodePath.join(root, ".git");
  const gitMetadata = NodeFS.lstatSync(gitPath);
  if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()) {
    throw new Error(`dev app fixture Git metadata must be a real directory: ${gitPath}`);
  }

  const discoveredRoot = NodeFS.realpathSync(git.run(["rev-parse", "--show-toplevel"]).trim());
  if (discoveredRoot !== NodeFS.realpathSync(root)) {
    throw new Error(`dev app fixture Git root resolved to ${discoveredRoot}, expected ${root}`);
  }

  const gitDir = NodeFS.realpathSync(git.run(["rev-parse", "--absolute-git-dir"]).trim());
  const expectedGitDir = NodeFS.realpathSync(gitPath);
  if (gitDir !== expectedGitDir) {
    throw new Error(
      `dev app fixture Git metadata resolved to ${gitDir}, expected ${expectedGitDir}`,
    );
  }
}

function prepareFixtureSourceDirectory(root: string): void {
  const sourcePath = NodePath.join(root, "src");
  try {
    const source = NodeFS.lstatSync(sourcePath);
    if (!source.isDirectory() || source.isSymbolicLink()) {
      throw new Error(`dev app fixture source must be a real directory: ${sourcePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    NodeFS.mkdirSync(sourcePath);
  }

  const source = NodeFS.realpathSync(sourcePath);
  if (source !== sourcePath) {
    throw new Error(`dev app fixture source resolves outside its repository: ${source}`);
  }
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = NodePath.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

function resolveOwnedFixtureRoot(checkoutRoot: string): string {
  const checkout = NodeFS.realpathSync(checkoutRoot);
  const homePath = NodePath.join(checkout, ".t3");
  NodeFS.mkdirSync(homePath, { recursive: true });
  const home = NodeFS.realpathSync(homePath);
  if (!isPathWithin(checkout, home)) {
    throw new Error(`dev app home resolves outside checkout ${checkout}: ${home}`);
  }

  const fixturePath = NodePath.join(homePath, "test-project");
  NodeFS.mkdirSync(fixturePath, { recursive: true });
  const fixtureRoot = NodeFS.realpathSync(fixturePath);
  if (!isPathWithin(home, fixtureRoot)) {
    throw new Error(`dev app fixture resolves outside checkout-local home ${home}: ${fixtureRoot}`);
  }
  return fixtureRoot;
}

export function devAppProjectCliEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const output = withoutInheritedDevRunnerEnv(environment);
  delete output["T3CODE_BOOTSTRAP_FD"];
  delete output["NODE_CHANNEL_FD"];
  delete output["NODE_CHANNEL_SERIALIZATION"];
  return output;
}

export function prepareDevAppProject(checkoutRoot: string): DevAppProjectFixture {
  const root = resolveOwnedFixtureRoot(NodePath.resolve(checkoutRoot));
  const git = new SystemGit(root);
  const hasGitMetadata = NodeFS.existsSync(NodePath.join(root, ".git"));

  if (!hasGitMetadata) {
    git.run(["init", "--initial-branch=main"]);
  }
  assertFixtureRepository(root, git);

  if (git.runResult(["rev-parse", "--verify", "HEAD"]).status === 0) {
    return { root, created: false };
  }

  prepareFixtureSourceDirectory(root);
  writeMissingFixtureFiles(root);
  git.run(["config", "user.name", "T3 Code Dev Fixture"]);
  git.run(["config", "user.email", "dev-fixture@t3.codes"]);
  git.run(["config", "commit.gpgSign", "false"]);
  git.run(["add", ...Object.keys(FIXTURE_FILES)]);
  git.run(["commit", "--no-verify", "-m", "chore: initialize dev fixture"]);
  return { root, created: true };
}

export function registerDevAppProject(
  options: RegisterDevAppProjectOptions,
): DevAppProjectRegistration {
  const checkoutRoot = NodePath.resolve(options.checkoutRoot);
  const projectRoot = prepareDevAppProject(checkoutRoot).root;
  const baseDir = NodePath.resolve(checkoutRoot, options.baseDir);
  const args = [
    "apps/server/src/bin.ts",
    "project",
    "add",
    projectRoot,
    "--title",
    DEV_APP_PROJECT_TITLE,
    "--base-dir",
    baseDir,
  ];
  const result = (options.runner ?? new SystemCommandRunner()).run(
    process.execPath,
    args,
    checkoutRoot,
    undefined,
    devAppProjectCliEnvironment(options.environment ?? process.env),
  );

  if (result.status === 0) return "added";

  const duplicateMessage = `An active project already exists for '${projectRoot}'.`;
  if (`${result.stdout}\n${result.stderr}`.includes(duplicateMessage)) {
    return "already-registered";
  }

  const detail = [result.stdout.trim(), result.stderr.trim(), result.error?.message]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n");
  throw new Error(
    `${commandText(process.execPath, args)} failed${detail.length === 0 ? "" : `: ${detail}`}`,
  );
}
