import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalOpenInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../processRunner.ts";
import * as ZmuxSessionBinder from "../zmux/ZmuxSessionBinder.ts";
import * as TerminalManager from "./Manager.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

export class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{
    cols: number;
    rows: number;
  }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  writeFailure: unknown | undefined;
  resizeFailure: unknown | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  killed = false;
  constructor(pid: number) {
    this.pid = pid;
  }
  write(data: string): void {
    if (this.writeFailure !== undefined) {
      throw this.writeFailure;
    }
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    if (this.resizeFailure !== undefined) {
      throw this.resizeFailure;
    }
    this.resizeCalls.push({ cols, rows });
  }
  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
  }
  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }
  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }
  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }
  emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}
export class FakeProcessRunner {
  readonly inputs: ProcessRunner.ProcessRunInput[] = [];
  private readonly result:
    | Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>
    | ((
        input: ProcessRunner.ProcessRunInput,
      ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>);
  constructor(
    result:
      | Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>
      | ((
          input: ProcessRunner.ProcessRunInput,
        ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>),
  ) {
    this.result = result;
  }
  readonly service = ProcessRunner.ProcessRunner.of({
    run: (input) => {
      this.inputs.push(input);
      return typeof this.result === "function" ? this.result(input) : this.result;
    },
  });
}
export function processResult(
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput {
  return {
    stdout: "",
    stderr: "",
    code: ChildProcessSpawner.ExitCode(0),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
    ...overrides,
  };
}
export function resolvedZmuxProcessRunner(): FakeProcessRunner {
  return new FakeProcessRunner(
    Effect.succeed(
      processResult({
        stdout:
          '{"workspace":"zmux","session":"main","target":"zmux/main","tmuxName":"zws_zmux__main","nativeId":"$22","state":"live","match":"worktree"}',
      }),
    ),
  );
}
export class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private readonly mode: "sync" | "async";
  private nextPid = 9000;
  constructor(mode: "sync" | "async" = "sync") {
    this.mode = mode;
  }
  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawnInputs.push(input);
    const failure = this.spawnFailures.shift();
    if (failure) {
      return Effect.fail(
        new PtyAdapter.PtySpawnError({
          adapter: "fake",
          shell: input.shell,
          cause: failure,
        }),
      );
    }
    const process = new FakePtyProcess(this.nextPid++);
    this.processes.push(process);
    if (this.mode === "async") {
      return Effect.tryPromise({
        try: async () => process,
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "fake",
            shell: input.shell,
            cause,
          }),
      });
    }
    return Effect.succeed(process);
  }
}
export function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}
export interface CreateManagerOptions {
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: (terminalPid: number) => Effect.Effect<{
    readonly hasRunningSubprocess: boolean;
    readonly childCommand: string | null;
    readonly processIds: ReadonlyArray<number>;
  }>;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  managedAttachmentSuspendGraceMs?: number;
  managedAttachmentFirstAttachDeadlineMs?: number;
  maxRetainedInactiveSessions?: number;
  ptyAdapter?: FakePtyAdapter;
  terminalSessionMode?: "shell" | "zmux";
  ensureZmuxSession?: ZmuxSessionBinder.ZmuxSessionBinder["Service"]["ensure"];
}
export interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManager.TerminalManager["Service"];
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}
export const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ProcessRunner.ProcessRunner
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-terminal-" });
      const logsDir = join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();
      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.subprocessInspector !== undefined
          ? { subprocessInspector: options.subprocessInspector }
          : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        ...(options.managedAttachmentSuspendGraceMs !== undefined
          ? { managedAttachmentSuspendGraceMs: options.managedAttachmentSuspendGraceMs }
          : {}),
        ...(options.managedAttachmentFirstAttachDeadlineMs !== undefined
          ? {
              managedAttachmentFirstAttachDeadlineMs:
                options.managedAttachmentFirstAttachDeadlineMs,
            }
          : {}),
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.terminalSessionMode !== undefined
          ? { terminalSessionMode: Effect.succeed(options.terminalSessionMode) }
          : {}),
        ...(options.ensureZmuxSession !== undefined
          ? { ensureZmuxSession: options.ensureZmuxSession }
          : {}),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      return {
        baseDir,
        logsDir,
        join,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );
