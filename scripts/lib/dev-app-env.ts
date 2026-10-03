// @effect-diagnostics nodeBuiltinImport:off - Fork development launch preparation runs before the Effect dev runner.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { withoutInheritedDevRunnerEnv } from "./dev-desktop-agent.ts";
import { loadRepoEnv } from "./public-config.ts";

export type DevAppRunnerMode = "dev" | "dev:server" | "dev:web" | "dev:desktop";

type Environment = Readonly<Record<string, string | undefined>>;

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

export function resolveDevAppCheckoutRoot(cwd: string): string {
  const environment = { ...process.env };
  for (const key of GIT_DISCOVERY_ENVIRONMENT) delete environment[key];
  try {
    const root = NodeChildProcess.execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--show-toplevel"],
      {
        cwd,
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (!NodePath.isAbsolute(root)) {
      throw new Error(`Git returned a non-absolute checkout path: '${root}'`);
    }
    return NodeFS.realpathSync(root);
  } catch (error) {
    const stderr = (error as { readonly stderr?: Buffer | string }).stderr;
    const detail = String(stderr ?? (error instanceof Error ? error.message : error)).trim();
    throw new Error(`could not resolve the Git checkout from '${cwd}': ${detail}`, {
      cause: error,
    });
  }
}

export function loadDevAppEnvironment({
  checkoutRoot,
  environment = process.env,
}: {
  readonly checkoutRoot: string;
  readonly environment?: Environment;
}): Record<string, string | undefined> {
  return loadRepoEnv({
    repoRoot: checkoutRoot,
    baseEnv: withoutInheritedDevRunnerEnv(environment),
  });
}

function hasHomeDirectoryOverride(args: readonly string[]): boolean {
  const optionArgs = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
  return optionArgs.some(
    (argument) => argument === "--home-dir" || argument.startsWith("--home-dir="),
  );
}

export function buildDevAppRunnerArgs({
  checkoutRoot,
  mode,
  runnerArgs = [],
}: {
  readonly checkoutRoot: string;
  readonly mode: DevAppRunnerMode;
  readonly runnerArgs?: readonly string[];
}): string[] {
  if (hasHomeDirectoryOverride(runnerArgs)) {
    throw new Error(
      "dev:app always uses the selected checkout's .t3 directory; use the underlying dev command to override --home-dir",
    );
  }

  return [
    "scripts/dev-runner.ts",
    mode,
    "--home-dir",
    NodePath.join(checkoutRoot, ".t3"),
    ...runnerArgs,
  ];
}
