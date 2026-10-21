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
  /**
   * Opt-in: capture the child's piped output, then write it through to ours on return, so it stays
   * available for failure details. Live progress is lost until the child exits. The child's stdin
   * stays closed, so a prompting child fails fast.
   */
  readonly stream?: boolean;
}

/**
 * Bounds every command that names no timeout, so a wedged child cannot hang forever. 45 minutes
 * clears the slowest ordinary fork-walk step (a 275-commit rebase, `vp i`, `fork:scan`); a command
 * allowed to run longer (a CI-watch poll, a release-workflow wait) passes its own `timeout`.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 45 * 60 * 1000;

export const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandOptions = {},
): CommandResult => {
  if (options.stream === true && options.input !== undefined)
    throw new Error(
      "runCommand: stream and input are mutually exclusive (piped stdin can't also receive piped input)",
    );
  if (options.stream === true) return runCommandStreaming(command, args, options);
  const result = NodeChildProcess.spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.env === undefined ? {} : { env: options.env }),
    // stdin stays "ignore", not "inherit": a child that unexpectedly prompts (a credential
    // helper, a pager, a rebase whose GIT_EDITOR did not take) should fail fast on a closed
    // stdin like before, not sit on the operator's terminal until the timeout fires.
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

/**
 * `stream: true` via spawnSync with piped stdio, written through to our stdout, then stderr, on
 * return. A synchronous poll of a live ChildProcess never observes its exit, so arrival-order
 * interleaving is out of reach. stdin stays closed, so a prompting child still fails fast.
 */
const runCommandStreaming = (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandOptions,
): CommandResult => {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout.length > 0) process.stdout.write(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);
  return {
    status: result.status ?? 1,
    stdout,
    stderr,
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

/**
 * Each `<rev>:<path>` spec's blob text, read by two `git cat-file` processes however many specs
 * there are; a spec that names no blob has no entry. One `git show` per path cost a scan 16k
 * process spawns, about 65 ms each on CI. Identical blobs across trees are read once.
 */
export const readBlobs = (cwd: string, specs: Iterable<string>): ReadonlyMap<string, string> => {
  const unique = [...new Set(specs)];
  const blobs = new Map<string, string>();
  if (unique.length === 0) return blobs;
  // NUL framing: a path may itself hold a newline.
  const check = runCommandText(
    "git",
    ["cat-file", "-Z", "--batch-check=%(objectname) %(objecttype)"],
    { cwd, input: `${unique.join("\0")}\0` },
  ).split("\0");
  const shaBySpec = new Map<string, string>();
  unique.forEach((spec, index) => {
    const [sha, type] = (check[index] ?? "").split(" ");
    if (type === "blob" && sha !== undefined && /^[0-9a-f]+$/.test(sha)) shaBySpec.set(spec, sha);
  });
  const shas = [...new Set(shaBySpec.values())];
  if (shas.length === 0) return blobs;
  const result = NodeChildProcess.spawnSync("git", ["cat-file", "--batch"], {
    cwd,
    input: `${shas.join("\n")}\n`,
    maxBuffer: 1 << 30,
    timeout: DEFAULT_COMMAND_TIMEOUT_MS,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`git cat-file --batch failed: ${result.stderr}`);
  // `<sha> blob <size>\n<bytes>\n` per object; size counts bytes, so parse the raw buffer.
  const out = result.stdout;
  const textBySha = new Map<string, string>();
  for (let offset = 0; offset < out.length;) {
    const headerEnd = out.indexOf(10, offset);
    const [sha = "", , size = "0"] = out.toString("utf8", offset, headerEnd).split(" ");
    const start = headerEnd + 1;
    const end = start + Number(size);
    textBySha.set(sha, out.toString("utf8", start, end));
    offset = end + 1;
  }
  for (const [spec, sha] of shaBySpec) {
    const text = textBySha.get(sha);
    if (text !== undefined) blobs.set(spec, text);
  }
  return blobs;
};

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
    stream?: boolean,
    timeout?: number,
  ): CommandResult;
}

export interface CwdCommandRunner {
  run(
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    input?: string,
    env?: NodeJS.ProcessEnv,
    stream?: boolean,
    timeout?: number,
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
    stream?: boolean,
    timeout?: number,
  ): CommandResult {
    const result = runCommand(command, args, {
      cwd,
      ...(input === undefined ? {} : { input }),
      ...(env === undefined ? {} : { env }),
      ...(stream === undefined ? {} : { stream }),
      ...(timeout === undefined ? {} : { timeout }),
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

  readBlobs(specs: Iterable<string>): ReadonlyMap<string, string> {
    return readBlobs(this.cwd, specs);
  }

  runResult(args: ReadonlyArray<string>, timeout?: number): CommandResult {
    return runCommand("git", args, {
      cwd: this.cwd,
      ...(timeout === undefined ? {} : { timeout }),
    });
  }
}
