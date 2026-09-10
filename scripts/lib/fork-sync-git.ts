// @effect-diagnostics nodeBuiltinImport:off - The sync driver bootstraps Git before any Effect runtime exists.

// The sync driver's command seam: every git and child process the driver and
// its resolution transport run goes through one injectable runner.

import { requireCommandSuccess, runCommand, type CommandResult } from "./fork-command.ts";

export interface CommandSpec {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stream?: boolean;
  readonly timeout?: number;
  readonly input?: string;
}

export interface CommandRunner {
  run(command: string, args: ReadonlyArray<string>, spec: CommandSpec): CommandResult;
}

/** The production runner: every command is a real child process. */
export const realRunner: CommandRunner = {
  run: (command, args, spec) =>
    runCommand(command, args, {
      cwd: spec.cwd,
      ...(spec.env === undefined ? {} : { env: spec.env }),
      ...(spec.stream === undefined ? {} : { stream: spec.stream }),
      ...(spec.timeout === undefined ? {} : { timeout: spec.timeout }),
      ...(spec.input === undefined ? {} : { input: spec.input }),
    }),
};

export const lines = (value: string): ReadonlyArray<string> =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export const gitResult = (
  runner: CommandRunner,
  cwd: string,
  args: ReadonlyArray<string>,
): CommandResult => runner.run("git", args, { cwd });

export const git = (runner: CommandRunner, cwd: string, args: ReadonlyArray<string>): string => {
  const result = gitResult(runner, cwd, args);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim() || result.error?.message || "no output"}`,
    );
  return result.stdout.trim();
};

/** A git command whose failure the run itself tolerates. */
export const gitAllow = (runner: CommandRunner, cwd: string, args: ReadonlyArray<string>): void => {
  gitResult(runner, cwd, args);
};

export const runRequire = (
  runner: CommandRunner,
  command: string,
  args: ReadonlyArray<string>,
  spec: CommandSpec,
): string => requireCommandSuccess(runner.run(command, args, spec), command, args);

export const gitPath = (runner: CommandRunner, cwd: string, name: string): string =>
  git(runner, cwd, ["rev-parse", "--path-format=absolute", "--git-path", name]);
