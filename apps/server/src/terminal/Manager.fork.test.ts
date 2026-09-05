import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";
import { vi } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import {
  createManager,
  FakeProcessRunner,
  openInput,
  processResult,
  resolvedZmuxProcessRunner,
} from "./Manager.fork-test-harness.ts";
it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("TerminalManager", (it) => {
  it.effect("keeps shell mode unchanged", () =>
    Effect.gen(function* () {
      const processRunner = new FakeProcessRunner(Effect.succeed(processResult()));
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/bash",
        terminalSessionMode: "shell",
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* manager.open(openInput());
      expect(processRunner.inputs).toEqual([]);
      expect(ptyAdapter.spawnInputs[0]).toMatchObject({
        shell: "/bin/bash",
        cwd: process.cwd(),
      });
    }),
  );
  it.effect("resolves and attaches zmux mode without inherited tmux context", () =>
    Effect.gen(function* () {
      const processRunner = new FakeProcessRunner(
        Effect.succeed(
          processResult({
            stdout:
              '{"workspace":"zmux","session":"main","target":"zmux/main","tmuxName":"zws_zmux__main","nativeId":"$22","state":"live","match":"worktree"}',
          }),
        ),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PATH: "/usr/bin",
          SHELL: "/bin/bash",
          TMUX: "/tmp/tmux-1000/default,1,0",
          TMUX_PANE: "%7",
        },
        terminalSessionMode: "zmux",
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      const snapshot = yield* manager.open(openInput({ worktreePath: process.cwd() }));
      expect(processRunner.inputs).toEqual([
        expect.objectContaining({
          command: "zmux",
          args: ["session", "resolve", "--cwd", process.cwd(), "--json"],
          cwd: process.cwd(),
          env: expect.not.objectContaining({
            TMUX: expect.anything(),
            TMUX_PANE: expect.anything(),
          }),
        }),
      ]);
      expect(ptyAdapter.spawnInputs[0]).toMatchObject({
        shell: "zmux",
        args: ["open", "zmux", "main"],
        cwd: process.cwd(),
        env: expect.not.objectContaining({ TMUX: expect.anything(), TMUX_PANE: expect.anything() }),
      });
      expect(snapshot.label).toBe("zmux/main");
      expect(snapshot.history).toBe("");
    }),
  );
  it.effect("suspends an abandoned managed open at its first-attach deadline", () =>
    Effect.gen(function* () {
      const processRunner = resolvedZmuxProcessRunner();
      const { manager, ptyAdapter } = yield* createManager(5, {
        terminalSessionMode: "zmux",
        managedAttachmentSuspendGraceMs: 1500,
        managedAttachmentFirstAttachDeadlineMs: 5000,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* Effect.addFinalizer(() => manager.close({ threadId: "thread-1" }).pipe(Effect.ignore));
      const opened = yield* manager.open(openInput({ worktreePath: process.cwd() }));
      const ptyProcess = ptyAdapter.processes[0];
      expect(opened.status).toBe("running");
      expect(ptyProcess).toBeDefined();
      yield* TestClock.adjust("4999 millis");
      expect(ptyProcess?.killSignals).toEqual([]);
      yield* TestClock.adjust("1 milli");
      expect(ptyProcess?.killSignals[0]).toBe("SIGTERM");
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("treats a first-attach deadline racing process exit as an explicit no-op", () =>
    Effect.gen(function* () {
      const processRunner = resolvedZmuxProcessRunner();
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        terminalSessionMode: "zmux",
        managedAttachmentSuspendGraceMs: 1,
        managedAttachmentFirstAttachDeadlineMs: 10,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* Effect.addFinalizer(() => manager.close({ threadId: "thread-1" }).pipe(Effect.ignore));
      yield* manager.open(openInput({ worktreePath: process.cwd() }));
      const ptyProcess = ptyAdapter.processes[0];
      expect(ptyProcess).toBeDefined();
      if (!ptyProcess) return;
      ptyProcess.emitExit({ exitCode: 0, signal: 0 });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      expect(ptyProcess.killSignals).toEqual([]);
      expect((yield* getEvents).some((event) => event.type === "exited")).toBe(true);
      expect(
        (yield* getEvents).some(
          (event) => event.type === "activity" && event.attachmentStatus === "suspended",
        ),
      ).toBe(false);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("lets a cold UI attach cancel the longer first-attach deadline", () =>
    Effect.gen(function* () {
      const processRunner = resolvedZmuxProcessRunner();
      const { manager, ptyAdapter } = yield* createManager(5, {
        terminalSessionMode: "zmux",
        managedAttachmentSuspendGraceMs: 1500,
        managedAttachmentFirstAttachDeadlineMs: 5000,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* Effect.addFinalizer(() => manager.close({ threadId: "thread-1" }).pipe(Effect.ignore));
      yield* manager.open(openInput({ worktreePath: process.cwd() }));
      const ptyProcess = ptyAdapter.processes[0];
      expect(ptyProcess).toBeDefined();
      if (!ptyProcess) return;
      yield* TestClock.adjust("4999 millis");
      const release = yield* manager.attachStream(openInput(), () => Effect.void);
      yield* TestClock.adjust("2 seconds");
      expect(ptyProcess.killSignals).toEqual([]);
      release();
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("cancels a hidden grace when the managed surface returns", () =>
    Effect.gen(function* () {
      const processRunner = resolvedZmuxProcessRunner();
      const { manager, ptyAdapter } = yield* createManager(5, {
        terminalSessionMode: "zmux",
        managedAttachmentSuspendGraceMs: 1500,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* Effect.addFinalizer(() => manager.close({ threadId: "thread-1" }).pipe(Effect.ignore));
      const firstRelease = yield* manager.attachStream(
        openInput({ worktreePath: process.cwd() }),
        () => Effect.void,
      );
      const ptyProcess = ptyAdapter.processes[0];
      expect(ptyProcess).toBeDefined();
      if (!ptyProcess) return;
      firstRelease();
      const secondRelease = yield* manager.attachStream(
        openInput({ worktreePath: process.cwd() }),
        () => Effect.void,
      );
      yield* TestClock.adjust("3 seconds");
      expect(ptyProcess.killSignals).toEqual([]);
      expect(ptyAdapter.processes).toHaveLength(1);
      secondRelease();
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1500 millis");
      expect(ptyProcess.killSignals[0]).toBe("SIGTERM");
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("re-resolves a suspended checkout after its zmux target is renamed", () =>
    Effect.gen(function* () {
      let resolveCount = 0;
      const processRunner = new FakeProcessRunner((input) =>
        Effect.sync(() => {
          if (input.command === "zmux") {
            resolveCount += 1;
          }
          const renamed = resolveCount === 3;
          return processResult({
            stdout: renamed
              ? '{"workspace":"zmux","session":"renamed","target":"zmux/renamed","tmuxName":"zws_zmux__renamed","nativeId":"$22","state":"live","match":"worktree"}'
              : '{"workspace":"zmux","session":"main","target":"zmux/main","tmuxName":"zws_zmux__main","nativeId":"$22","state":"live","match":"worktree"}',
          });
        }),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        terminalSessionMode: "zmux",
        managedAttachmentSuspendGraceMs: 1500,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* Effect.addFinalizer(() => manager.close({ threadId: "thread-1" }).pipe(Effect.ignore));
      const firstRelease = yield* manager.attachStream(
        openInput({ terminalId: "term-1", worktreePath: process.cwd() }),
        () => Effect.void,
      );
      const siblingRelease = yield* manager.attachStream(
        openInput({ terminalId: "term-2", worktreePath: process.cwd() }),
        () => Effect.void,
      );
      const firstProcess = ptyAdapter.processes[0];
      const siblingProcess = ptyAdapter.processes[1];
      expect(firstProcess).toBeDefined();
      expect(siblingProcess).toBeDefined();
      if (!firstProcess || !siblingProcess) return;
      firstProcess.emitData("before suspend\n");
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      firstRelease();
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1500 millis");
      expect(firstProcess.killSignals[0]).toBe("SIGTERM");
      expect(siblingProcess.killSignals).toEqual([]);
      const resumedEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const resumedRelease = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: "term-1",
          cols: 140,
          rows: 40,
        },
        (event) => Ref.update(resumedEvents, (events) => [...events, event]),
      );
      const resumedProcess = ptyAdapter.processes[2];
      expect(resumedProcess).toBeDefined();
      if (!resumedProcess) return;
      const resumedSnapshot = (yield* Ref.get(resumedEvents)).find(
        (event) => event.type === "snapshot",
      );
      expect(resumedSnapshot).toMatchObject({
        type: "snapshot",
        snapshot: {
          status: "running",
          history: expect.stringContaining("before suspend"),
        },
      });
      expect(processRunner.inputs.filter((input) => input.command === "zmux")).toHaveLength(3);
      expect(ptyAdapter.spawnInputs[2]).toMatchObject({
        shell: "zmux",
        args: ["open", "zmux", "renamed"],
        cols: 140,
        rows: 40,
      });
      expect(resumedProcess.resizeCalls).toEqual([]);
      expect((yield* manager.open(openInput({ worktreePath: process.cwd() }))).label).toBe(
        "zmux/renamed",
      );
      yield* manager.write({
        threadId: "thread-1",
        terminalId: "term-1",
        data: "echo resumed\r",
      });
      expect(resumedProcess.writes).toEqual(["echo resumed\r"]);
      resumedRelease();
      siblingRelease();
      yield* manager.close({ threadId: "thread-1" });
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("preserves last-known tmux activity and metadata while suspended", () =>
    Effect.gen(function* () {
      const processRunner = resolvedZmuxProcessRunner();
      const { manager, getEvents } = yield* createManager(5, {
        terminalSessionMode: "zmux",
        managedAttachmentSuspendGraceMs: 1500,
        subprocessPollIntervalMs: 20,
        subprocessInspector: () =>
          Effect.succeed({
            hasRunningSubprocess: true,
            childCommand: "vim",
            processIds: [9000, 9001],
          }),
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* Effect.addFinalizer(() => manager.close({ threadId: "thread-1" }).pipe(Effect.ignore));
      const suspended = yield* Deferred.make<TerminalEvent>();
      const unsubscribeEvents = yield* manager.subscribe((event) =>
        event.type === "activity" && event.attachmentStatus === "suspended"
          ? Deferred.succeed(suspended, event).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeEvents));
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const release = yield* manager.attachStream(
        openInput({ worktreePath: process.cwd() }),
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      const initialSnapshot = (yield* Ref.get(attachEvents))[0];
      expect(initialSnapshot?.type).toBe("snapshot");
      yield* TestClock.adjust("40 millis");
      yield* Effect.yieldNow;
      expect(
        (yield* getEvents).some((event) => event.type === "activity" && event.hasRunningSubprocess),
      ).toBe(true);
      release();
      yield* TestClock.adjust("1500 millis");
      const suspendedEvent = yield* Deferred.await(suspended);
      expect(suspendedEvent).toMatchObject({
        type: "activity",
        hasRunningSubprocess: true,
        label: "zmux/main",
        attachmentStatus: "suspended",
      });
      const metadata = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(metadata, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const metadataSnapshot = (yield* Ref.get(metadata))[0];
      expect(metadataSnapshot).toMatchObject({
        type: "snapshot",
        terminals: [
          {
            status: "running",
            attachmentStatus: "suspended",
            hasRunningSubprocess: true,
            label: "zmux/main",
          },
        ],
      });
      if (
        initialSnapshot?.type === "snapshot" &&
        metadataSnapshot?.type === "snapshot" &&
        metadataSnapshot.terminals[0]
      ) {
        expect(metadataSnapshot.terminals[0].updatedAt).not.toBe(
          initialSnapshot.snapshot.updatedAt,
        );
      }
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("does not reuse a retained zmux target after the checkout binding disappears", () =>
    Effect.gen(function* () {
      let resolveCount = 0;
      const processRunner = new FakeProcessRunner((input) =>
        Effect.sync(() => {
          if (input.command === "zmux") {
            resolveCount += 1;
          }
          return resolveCount === 1
            ? processResult({
                stdout:
                  '{"workspace":"zmux","session":"old","target":"zmux/old","tmuxName":"zws_zmux__old","nativeId":"$22","state":"live","match":"worktree"}',
              })
            : processResult({
                code: ChildProcessSpawner.ExitCode(1),
                stderr: "worktree binding no longer exists",
              });
        }),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/bash",
        terminalSessionMode: "zmux",
        managedAttachmentSuspendGraceMs: 10,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* Effect.addFinalizer(() => manager.close({ threadId: "thread-1" }).pipe(Effect.ignore));
      const release = yield* manager.attachStream(
        openInput({ worktreePath: process.cwd() }),
        () => Effect.void,
      );
      release();
      yield* TestClock.adjust("10 millis");
      const resumedEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const resumedRelease = yield* manager.attachStream(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => Ref.update(resumedEvents, (events) => [...events, event]),
      );
      expect(ptyAdapter.spawnInputs[0]).toMatchObject({
        shell: "zmux",
        args: ["open", "zmux", "old"],
      });
      expect(ptyAdapter.spawnInputs[1]).toMatchObject({ shell: "/bin/bash" });
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect((yield* Ref.get(resumedEvents))[0]).toMatchObject({
        type: "snapshot",
        snapshot: {
          history: expect.stringContaining("no managed session"),
        },
      });
      resumedRelease();
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("releases managed demand when initial attach delivery is cancelled", () =>
    Effect.gen(function* () {
      const processRunner = resolvedZmuxProcessRunner();
      const { manager, ptyAdapter } = yield* createManager(5, {
        terminalSessionMode: "zmux",
        managedAttachmentSuspendGraceMs: 1500,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* Effect.addFinalizer(() => manager.close({ threadId: "thread-1" }).pipe(Effect.ignore));
      const deliveringSnapshot = yield* Deferred.make<void>();
      const attachFiber = yield* manager
        .attachStream(openInput({ worktreePath: process.cwd() }), (event) =>
          event.type === "snapshot"
            ? Deferred.succeed(deliveringSnapshot, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(deliveringSnapshot);
      yield* Fiber.interrupt(attachFiber);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1500 millis");
      const ptyProcess = ptyAdapter.processes[0];
      expect(ptyProcess).toBeDefined();
      expect(ptyProcess?.killSignals[0]).toBe("SIGTERM");
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("retries a failed exact-target resume on the next visibility demand", () =>
    Effect.gen(function* () {
      const processRunner = resolvedZmuxProcessRunner();
      const { manager, ptyAdapter } = yield* createManager(5, {
        terminalSessionMode: "zmux",
        managedAttachmentSuspendGraceMs: 1500,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* Effect.addFinalizer(() => manager.close({ threadId: "thread-1" }).pipe(Effect.ignore));
      const initialRelease = yield* manager.attachStream(
        openInput({ worktreePath: process.cwd() }),
        () => Effect.void,
      );
      initialRelease();
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1500 millis");
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed"));
      const failedEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const failedRelease = yield* manager.attachStream(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => Ref.update(failedEvents, (events) => [...events, event]),
      );
      expect(yield* Ref.get(failedEvents)).toMatchObject([
        {
          type: "snapshot",
          snapshot: {
            status: "error",
            label: "zmux/main",
            attachmentStatus: "suspended",
          },
        },
        { type: "error", message: expect.stringContaining("Failed to spawn PTY process") },
      ]);
      failedRelease();
      yield* Effect.yieldNow;
      const retryRelease = yield* manager.attachStream(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        () => Effect.void,
      );
      expect(ptyAdapter.spawnInputs.at(-1)).toMatchObject({
        shell: "zmux",
        args: ["open", "zmux", "main"],
      });
      expect(ptyAdapter.processes).toHaveLength(2);
      expect(processRunner.inputs.filter((input) => input.command === "zmux")).toHaveLength(3);
      retryRelease();
      yield* manager.close({ threadId: "thread-1" });
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("attaches canonical project terminals to the workspace main session", () =>
    Effect.gen(function* () {
      const processRunner = new FakeProcessRunner(
        Effect.succeed(
          processResult({
            stdout:
              '{"workspace":"zmux","session":"main","target":"zmux/main","tmuxName":"zws_zmux__main","nativeId":"$22","state":"live","match":"workspace-main"}',
          }),
        ),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/bash",
        terminalSessionMode: "zmux",
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      const snapshot = yield* manager.open(openInput());
      expect(ptyAdapter.spawnInputs[0]).toMatchObject({
        shell: "zmux",
        args: ["open", "zmux", "main"],
        cwd: process.cwd(),
      });
      expect(snapshot.label).toBe("zmux/main");
      expect(snapshot.history).toBe("");
    }),
  );
  it.effect("ensures and attaches an unbound worktree on first terminal open", () =>
    Effect.gen(function* () {
      const ensureZmuxSession = vi.fn(() =>
        Effect.succeed({
          status: "ensured",
          target: "t3code-hyprws/t3code/audit-zmux-project-terminals",
          workspace: "t3code-hyprws",
          session: "t3code/audit-zmux-project-terminals",
        } as const),
      );
      const processRunner = new FakeProcessRunner(Effect.succeed(processResult()));
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/bash",
        terminalSessionMode: "zmux",
        ensureZmuxSession,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));

      const snapshot = yield* manager.open(openInput({ worktreePath: process.cwd() }));

      expect(ensureZmuxSession).toHaveBeenCalledWith(process.cwd());
      expect(ptyAdapter.spawnInputs[0]).toMatchObject({
        shell: "zmux",
        args: ["open", "t3code-hyprws", "t3code/audit-zmux-project-terminals"],
      });
      expect(snapshot.label).toBe("t3code-hyprws/t3code/audit-zmux-project-terminals");
    }),
  );
  it.effect("surfaces ensure failure without opening a plain shell", () =>
    Effect.gen(function* () {
      const ensureZmuxSession = vi.fn(() =>
        Effect.succeed({
          status: "failed",
          notice: {
            summary: "zmux workspace root needs attention",
            detail: "conflicting checkout registration; inspect workspace project",
          },
        } as const),
      );
      const processRunner = new FakeProcessRunner(Effect.succeed(processResult()));
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/bash",
        terminalSessionMode: "zmux",
        ensureZmuxSession,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));

      const snapshot = yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs).toEqual([]);
      expect(snapshot.status).toBe("error");
      expect(snapshot.history).toContain("zmux workspace root needs attention");
      expect(snapshot.history).not.toContain("plain shell");
    }),
  );
  it.effect("falls back visibly when a linked worktree resolves the workspace main session", () =>
    Effect.gen(function* () {
      const processRunner = new FakeProcessRunner(
        Effect.succeed(
          processResult({
            stdout:
              '{"workspace":"zmux","session":"main","target":"zmux/main","tmuxName":"zws_zmux__main","nativeId":"$22","state":"live","match":"workspace-main"}',
          }),
        ),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/bash",
        terminalSessionMode: "zmux",
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      const snapshot = yield* manager.open(openInput({ worktreePath: process.cwd() }));
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/bin/bash");
      expect(snapshot.history).toContain("resolves the workspace main session, not a worktree");
      expect(snapshot.history).toContain("plain shell");
    }),
  );
  it.effect("falls back visibly when a canonical project resolves a worktree session", () =>
    Effect.gen(function* () {
      const processRunner = resolvedZmuxProcessRunner();
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/bash",
        terminalSessionMode: "zmux",
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      const snapshot = yield* manager.open(openInput());
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/bin/bash");
      expect(snapshot.history).toContain("resolves a worktree session, not the workspace main");
      expect(snapshot.history).toContain("plain shell");
    }),
  );
  it.effect("falls back visibly when zmux returns malformed resolver output", () =>
    Effect.gen(function* () {
      const processRunner = new FakeProcessRunner(
        Effect.succeed(processResult({ stdout: '{"workspace":"zmux"}' })),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/bash",
        terminalSessionMode: "zmux",
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      const snapshot = yield* manager.open(openInput());
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/bin/bash");
      expect(snapshot.history).toContain(`zmux: no managed session for ${process.cwd()}`);
      expect(snapshot.history).toContain("plain shell");
    }),
  );
  it.effect("falls back visibly when zmux cannot resolve a managed session", () =>
    Effect.gen(function* () {
      const processRunner = new FakeProcessRunner(
        Effect.succeed(
          processResult({
            code: ChildProcessSpawner.ExitCode(1),
            stderr: "no managed session",
          }),
        ),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/bash",
        terminalSessionMode: "zmux",
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      const snapshot = yield* manager.open(openInput());
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/bin/bash");
      expect(snapshot.history).toContain(`zmux: no managed session for ${process.cwd()}`);
      expect(snapshot.history).toContain("plain shell");
    }),
  );
  it.effect("falls back visibly when the zmux binary is missing", () =>
    Effect.gen(function* () {
      const processRunner = new FakeProcessRunner(
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "zmux",
            argumentCount: 6,
            cause: new Error("ENOENT"),
          }),
        ),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/bash",
        terminalSessionMode: "zmux",
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      const snapshot = yield* manager.open(openInput());
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/bin/bash");
      expect(snapshot.history).toContain("zmux: command unavailable");
      expect(snapshot.history).toContain("plain shell");
    }),
  );
  it.effect("bounds suspended records while preserving exact-target resume identity", () =>
    Effect.gen(function* () {
      const processRunner = resolvedZmuxProcessRunner();
      const { manager, ptyAdapter } = yield* createManager(5, {
        terminalSessionMode: "zmux",
        managedAttachmentSuspendGraceMs: 10,
        maxRetainedInactiveSessions: 1,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* Effect.addFinalizer(() =>
        Effect.all([
          manager.close({ threadId: "thread-1" }).pipe(Effect.ignore),
          manager.close({ threadId: "thread-2" }).pipe(Effect.ignore),
        ]).pipe(Effect.asVoid),
      );
      const firstSuspended = yield* Deferred.make<TerminalEvent>();
      const secondSuspended = yield* Deferred.make<TerminalEvent>();
      const firstClosed = yield* Deferred.make<TerminalEvent>();
      const firstMetadataRemoved = yield* Deferred.make<TerminalMetadataStreamEvent>();
      const unsubscribeEvents = yield* manager.subscribe((event) => {
        if (
          event.type === "activity" &&
          event.attachmentStatus === "suspended" &&
          event.threadId === "thread-1"
        ) {
          return Deferred.succeed(firstSuspended, event).pipe(Effect.asVoid);
        }
        if (
          event.type === "activity" &&
          event.attachmentStatus === "suspended" &&
          event.threadId === "thread-2"
        ) {
          return Deferred.succeed(secondSuspended, event).pipe(Effect.asVoid);
        }
        if (event.type === "closed" && event.threadId === "thread-1") {
          return Deferred.succeed(firstClosed, event).pipe(Effect.asVoid);
        }
        return Effect.void;
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeEvents));
      const unsubscribeMetadata = yield* manager.subscribeMetadata((event) =>
        event.type === "remove" && event.threadId === "thread-1"
          ? Deferred.succeed(firstMetadataRemoved, event).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeMetadata));
      const firstRelease = yield* manager.attachStream(
        openInput({ threadId: "thread-1", worktreePath: process.cwd() }),
        () => Effect.void,
      );
      firstRelease();
      yield* TestClock.adjust("10 millis");
      const firstSuspendedEvent = yield* Deferred.await(firstSuspended);
      const secondRelease = yield* manager.attachStream(
        openInput({ threadId: "thread-2", worktreePath: process.cwd() }),
        () => Effect.void,
      );
      secondRelease();
      yield* TestClock.adjust("10 millis");
      yield* Deferred.await(secondSuspended);
      const firstClosedEvent = yield* Deferred.await(firstClosed);
      expect(yield* Deferred.await(firstMetadataRemoved)).toMatchObject({
        type: "remove",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
      });
      expect(firstSuspendedEvent).toMatchObject({
        type: "activity",
        attachmentStatus: "suspended",
      });
      expect(firstClosedEvent.type).toBe("closed");
      expect(firstClosedEvent.sequence).toBeGreaterThan(firstSuspendedEvent.sequence ?? 0);
      const reopenedEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const reopenedRelease = yield* manager.attachStream(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) => Ref.update(reopenedEvents, (events) => [...events, event]),
      );
      expect(yield* Ref.get(reopenedEvents)).toMatchObject([
        {
          type: "snapshot",
          snapshot: { status: "running", attachmentStatus: "attached" },
        },
      ]);
      expect(ptyAdapter.spawnInputs.at(-1)).toMatchObject({
        shell: "zmux",
        args: ["open", "zmux", "main"],
      });
      expect(processRunner.inputs.filter((input) => input.command === "zmux")).toHaveLength(3);
      reopenedRelease();
    }).pipe(Effect.provide(TestClock.layer())),
  );
  it.effect("bounds compact exact-target identities separately from full records", () =>
    Effect.gen(function* () {
      const processRunner = resolvedZmuxProcessRunner();
      const { manager, ptyAdapter } = yield* createManager(5, {
        terminalSessionMode: "zmux",
        managedAttachmentSuspendGraceMs: 10,
        maxRetainedInactiveSessions: 1,
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          ["thread-1", "thread-2", "thread-3"],
          (threadId) => manager.close({ threadId }).pipe(Effect.ignore),
          { discard: true },
        ),
      );
      const firstSuspended = yield* Deferred.make<TerminalEvent>();
      const secondSuspended = yield* Deferred.make<TerminalEvent>();
      const secondResuspended = yield* Deferred.make<TerminalEvent>();
      const thirdSuspended = yield* Deferred.make<TerminalEvent>();
      const firstClosed = yield* Deferred.make<TerminalEvent>();
      const secondClosed = yield* Deferred.make<TerminalEvent>();
      const thirdClosed = yield* Deferred.make<TerminalEvent>();
      const secondSuspensionCount = yield* Ref.make(0);
      const unsubscribeEvents = yield* manager.subscribe((event) => {
        if (event.type === "activity" && event.attachmentStatus === "suspended") {
          if (event.threadId === "thread-1") {
            return Deferred.succeed(firstSuspended, event).pipe(Effect.asVoid);
          }
          if (event.threadId === "thread-2") {
            return Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(secondSuspensionCount, (value) => value + 1);
              yield* Deferred.succeed(count === 1 ? secondSuspended : secondResuspended, event);
            });
          }
          if (event.threadId === "thread-3") {
            return Deferred.succeed(thirdSuspended, event).pipe(Effect.asVoid);
          }
        }
        if (event.type === "closed") {
          if (event.threadId === "thread-1") {
            return Deferred.succeed(firstClosed, event).pipe(Effect.asVoid);
          }
          if (event.threadId === "thread-2") {
            return Deferred.succeed(secondClosed, event).pipe(Effect.asVoid);
          }
          if (event.threadId === "thread-3") {
            return Deferred.succeed(thirdClosed, event).pipe(Effect.asVoid);
          }
        }
        return Effect.void;
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribeEvents));
      const suspendAndAwait = Effect.fn("test.suspendAndAwait")(function* (
        threadId: string,
        suspended: Deferred.Deferred<TerminalEvent>,
      ) {
        const release = yield* manager.attachStream(
          openInput({ threadId, worktreePath: process.cwd() }),
          () => Effect.void,
        );
        release();
        yield* TestClock.adjust("10 millis");
        yield* Deferred.await(suspended);
      });
      yield* suspendAndAwait("thread-1", firstSuspended);
      yield* suspendAndAwait("thread-2", secondSuspended);
      yield* Deferred.await(firstClosed);
      yield* suspendAndAwait("thread-3", thirdSuspended);
      yield* Deferred.await(secondClosed);
      const oldest = yield* Effect.exit(
        manager.attachStream(
          { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
          () => Effect.void,
        ),
      );
      expect(Exit.isFailure(oldest)).toBe(true);
      const retainedRelease = yield* manager.attachStream(
        { threadId: "thread-2", terminalId: DEFAULT_TERMINAL_ID },
        () => Effect.void,
      );
      expect(ptyAdapter.spawnInputs.at(-1)).toMatchObject({
        shell: "zmux",
        args: ["open", "zmux", "main"],
      });
      expect(processRunner.inputs.filter((input) => input.command === "zmux")).toHaveLength(4);
      retainedRelease();
      yield* TestClock.adjust("10 millis");
      yield* Deferred.await(secondResuspended);
      yield* Deferred.await(thirdClosed);
      yield* manager.close({ threadId: "thread-3" });
      const explicitlyClosed = yield* Effect.exit(
        manager.attachStream(
          { threadId: "thread-3", terminalId: DEFAULT_TERMINAL_ID },
          () => Effect.void,
        ),
      );
      expect(Exit.isFailure(explicitlyClosed)).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
