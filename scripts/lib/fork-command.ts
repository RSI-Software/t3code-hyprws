// @effect-diagnostics nodeBuiltinImport:off - Fork scripts need a synchronous bootstrap runner.

import * as NodeChildProcess from "node:child_process";

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
  readonly maxBuffer?: number;
}

export const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandOptions = {},
): CommandResult => {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

export const commandText = (command: string, args: ReadonlyArray<string>): string =>
  [command, ...args]
    .map((value) => (/^[\w./:@#=-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(" ");

export const requireCommandSuccess = (
  result: CommandResult,
  command: string,
  args: ReadonlyArray<string>,
): string => {
  if (result.status === 0 && result.error === undefined) return result.stdout;
  const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
  throw new Error(
    `${commandText(command, args)} failed${detail.length === 0 ? "" : `: ${detail}`}`,
  );
};

export const runCommandText = (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandOptions = {},
): string => requireCommandSuccess(runCommand(command, args, options), command, args);

export interface CommandRunner {
  run(
    command: string,
    args: ReadonlyArray<string>,
    cwd?: string,
    input?: string,
    env?: NodeJS.ProcessEnv,
  ): CommandResult;
}

export interface CwdCommandRunner {
  run(
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    input?: string,
    env?: NodeJS.ProcessEnv,
  ): CommandResult;
}

export interface InputCommandRunner {
  run(command: string, args: ReadonlyArray<string>, input?: string): CommandResult;
}

export class SystemInputCommandRunner implements InputCommandRunner {
  run(command: string, args: ReadonlyArray<string>, input?: string): CommandResult {
    const result = runCommand(command, args, input === undefined ? {} : { input });
    if (result.error !== undefined) throw result.error;
    return result;
  }
}

export class SystemCommandRunner implements CwdCommandRunner {
  run(
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    input?: string,
    env?: NodeJS.ProcessEnv,
  ): CommandResult {
    const result = runCommand(command, args, {
      cwd,
      ...(input === undefined ? {} : { input }),
      ...(env === undefined ? {} : { env }),
    });
    if (result.error !== undefined) throw result.error;
    return result;
  }
}

export class SystemGit {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  run(args: ReadonlyArray<string>): string {
    return runCommandText("git", args, { cwd: this.cwd });
  }

  runResult(args: ReadonlyArray<string>, timeout?: number): CommandResult {
    return runCommand("git", args, {
      cwd: this.cwd,
      ...(timeout === undefined ? {} : { timeout }),
    });
  }
}
