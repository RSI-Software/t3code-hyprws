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
  throw new Error(`${commandFailureMessage(result, command, args, "")}`);
};

const commandFailureMessage = (
  result: CommandResult,
  command: string,
  args: ReadonlyArray<string>,
  suffix: string,
): string => {
  const detail = [result.stdout.trim(), result.stderr.trim(), result.error?.message]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n");
  return `${commandText(command, args)} failed${detail.length === 0 ? "" : `: ${detail}`}${suffix}`;
};

export const runCommandText = (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandOptions = {},
): string => requireCommandSuccess(runCommand(command, args, options), command, args);

const TRANSIENT_FAILURE_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/HTTP 50[234]/i, "HTTP 502/503/504"],
  [/was submitted too quickly/i, "submitted too quickly"],
  [/secondary rate limit/i, "secondary rate limit"],
  [/connection reset/i, "connection reset"],
  [/EAI_AGAIN/i, "DNS failure (EAI_AGAIN)"],
  [/ETIMEDOUT/i, "ETIMEDOUT"],
  [/TLS handshake timeout/i, "TLS handshake timeout"],
];

/** The matched transient signal's name, or undefined when the failure is not transient. */
const transientFailureSignal = (result: CommandResult): string | undefined => {
  const text = `${result.stdout}\n${result.stderr}`;
  const streamMatch = TRANSIENT_FAILURE_SIGNALS.find(([pattern]) => pattern.test(text));
  if (streamMatch !== undefined) return streamMatch[1];
  // A spawn timeout surfaces only on result.error, not in the captured streams.
  return /timed out|ETIMEDOUT/i.test(result.error?.message ?? "") ? "spawn timeout" : undefined;
};

export const isTransientCommandFailure = (result: CommandResult): boolean =>
  transientFailureSignal(result) !== undefined;

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
}

const sleepSync = (ms: number): void => {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
};

export const runCommandTextWithRetry = (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandOptions = {},
  retry: RetryOptions = {},
): string => {
  const attempts = Math.max(1, retry.attempts ?? 3);
  const baseDelayMs = retry.baseDelayMs ?? 1000;
  let last: CommandResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = runCommand(command, args, options);
    if (result.status === 0 && result.error === undefined) return result.stdout;
    last = result;
    const signal = transientFailureSignal(result);
    if (attempt === attempts || signal === undefined) break;
    const delayMs = baseDelayMs * 2 ** (attempt - 1);
    process.stderr.write(
      `${commandText(command, args)} failed transiently (${signal}; attempt ${attempt}/${attempts}); retrying in ${delayMs}ms\n`,
    );
    sleepSync(delayMs);
  }
  if (last === undefined) throw new Error("unreachable: retry attempts is clamped to at least 1");
  if (transientFailureSignal(last) === undefined) return requireCommandSuccess(last, command, args);
  throw new Error(`${commandFailureMessage(last, command, args, ` (after ${attempts} attempts)`)}`);
};

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
