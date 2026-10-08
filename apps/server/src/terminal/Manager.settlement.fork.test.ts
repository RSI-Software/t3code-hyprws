import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import {
  createManager,
  FakeProcessRunner,
  openInput,
  processResult,
  resolvedZmuxProcessRunner,
} from "./Manager.fork-test-harness.ts";

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "settlement attachment release",
  (it) => {
    it.effect("detaches managed viewers despite demand while preserving plain shells", () =>
      Effect.gen(function* () {
        const runner = resolvedZmuxProcessRunner();
        const managed = yield* createManager(5, { terminalSessionMode: "zmux" }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, runner.service),
        );
        const plain = yield* createManager(5, { terminalSessionMode: "shell" }).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, runner.service),
        );
        const release = yield* managed.manager.attachStream(
          openInput({ worktreePath: process.cwd() }),
          () => Effect.void,
        );
        yield* plain.manager.open(openInput());
        const ptyProcess = managed.ptyAdapter.processes[0]!;
        const signalled = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<boolean>();
        const kill = ptyProcess.kill.bind(ptyProcess);
        ptyProcess.kill = (signal) => {
          kill(signal);
          Deferred.doneUnsafe(signalled, Effect.void);
        };
        yield* managed.manager.releaseSettledManagedAttachments({ threadId: "thread-1" }).pipe(
          Effect.flatMap((value) => Deferred.succeed(finished, value)),
          Effect.forkScoped,
        );
        yield* Deferred.await(signalled);
        expect(yield* Deferred.isDone(finished)).toBe(false);
        ptyProcess.emitExit({ exitCode: 0, signal: 15 });
        expect(yield* Deferred.await(finished)).toBe(true);
        yield* plain.manager.releaseSettledManagedAttachments({ threadId: "thread-1" });
        expect(managed.ptyAdapter.processes[0]?.killSignals).toContain("SIGTERM");
        expect(plain.ptyAdapter.processes[0]?.killSignals).toEqual([]);
        expect(
          (yield* managed.getEvents).some(
            (event) => event.type === "activity" && event.attachmentStatus === "suspended",
          ),
        ).toBe(true);
        release();
      }),
    );

    it.effect("never ensures a missing session on settled open, restart, or suspended resume", () =>
      Effect.gen(function* () {
        let settled = false;
        let ensures = 0;
        const runner = new FakeProcessRunner(() =>
          Effect.succeed(
            processResult({
              stdout: settled
                ? '{"status":"not-found"}'
                : '{"workspace":"zmux","session":"feature","target":"zmux/feature","tmuxName":"zws_zmux__feature","nativeId":"$22","serverId":"123:456","createdAt":1700000000,"state":"live","match":"worktree"}',
            }),
          ),
        );
        const { manager, ptyAdapter } = yield* createManager(5, {
          terminalSessionMode: "zmux",
          shellResolver: () => "/bin/bash",
          resolveOnlyForSettledThread: () => Effect.sync(() => settled),
          ensureZmuxSession: () =>
            Effect.sync(() => {
              ensures += 1;
              return {
                status: "ensured",
                target: "zmux/feature",
                workspace: "zmux",
                session: "feature",
              } as const;
            }),
        }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner.service));
        const input = openInput({ worktreePath: process.cwd() });
        const firstRelease = yield* manager.attachStream(input, () => Effect.void);
        expect(ensures).toBe(1);
        settled = true;
        const ptyProcess = ptyAdapter.processes[0]!;
        const kill = ptyProcess.kill.bind(ptyProcess);
        ptyProcess.kill = (signal) => {
          kill(signal);
          ptyProcess.emitExit({ exitCode: 0, signal: 15 });
        };
        yield* manager.releaseSettledManagedAttachments({ threadId: input.threadId });
        const nextRelease = yield* manager.attachStream(input, () => Effect.void);
        yield* manager.restart({ ...input, cols: 100, rows: 24 });
        yield* manager.open({ ...input, terminalId: "new-terminal" });
        expect(ensures).toBe(1);
        expect(
          ptyAdapter.spawnInputs.slice(1).every((spawn) => !spawn.args?.includes("open")),
        ).toBe(true);
        firstRelease();
        nextRelease();
        yield* manager.close({ threadId: input.threadId });
      }),
    );
  },
);
