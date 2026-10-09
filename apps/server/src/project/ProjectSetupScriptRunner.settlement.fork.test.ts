import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { expect } from "vite-plus/test";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import {
  createManager,
  FakeProcessRunner,
  processResult,
} from "../terminal/Manager.fork-test-harness.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { makeSettledLaneReactor } from "../zmux/SettledLaneSessions.fork.ts";
import * as Binder from "../zmux/ZmuxSessionBinder.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const threadId = ThreadId.make("thread:hook-lifecycle");
const projectId = ProjectId.make("project:hook-lifecycle");
const identity = {
  target: "fixture/feature",
  nativeId: "$22",
  serverId: "123:456",
  createdAt: 123,
};

const harness = Effect.gen(function* () {
  let available = true;
  let settled = true;
  let busy = true;
  let beforeOpen: Effect.Effect<void> = Effect.void;
  const processRunner = new FakeProcessRunner(() =>
    Effect.succeed(
      processResult({
        stdout: available
          ? '{"workspace":"fixture","session":"feature","target":"fixture/feature","tmuxName":"zws_fixture__feature","nativeId":"$22","serverId":"123:456","createdAt":123,"state":"live","match":"worktree"}'
          : '{"status":"not-found"}',
      }),
    ),
  );
  const fixture = yield* createManager(20, {
    terminalSessionMode: "zmux",
    shellResolver: () => "/bin/bash",
    subprocessInspector: () =>
      Effect.succeed({
        hasRunningSubprocess: busy,
        childCommand: busy ? "hook" : null,
        processIds: [],
      }),
    resolveOnlyForSettledThread: () => Effect.sync(() => settled),
    ensureZmuxSession: () =>
      Effect.succeed({
        status: "ensured",
        target: "fixture/feature",
        workspace: "fixture",
        session: "feature",
      }),
  }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner.service));
  const patched = new Set<number>();
  const acknowledgeKills = () => {
    for (const process of fixture.ptyAdapter.processes) {
      if (patched.has(process.pid)) continue;
      patched.add(process.pid);
      const kill = process.kill.bind(process);
      process.kill = (signal) => {
        kill(signal);
        process.emitExit({ exitCode: 0, signal: 15 });
      };
    }
  };
  const terminals = TerminalManager.TerminalManager.of({
    ...fixture.manager,
    open: (input) =>
      beforeOpen.pipe(
        Effect.andThen(fixture.manager.open(input)),
        Effect.tap(() => Effect.sync(acknowledgeKills)),
      ),
  });
  const project = {
    id: projectId,
    workspaceRoot: fixture.baseDir,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "printf setup",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
      {
        id: "hook",
        name: "Settle",
        command: "printf hook",
        icon: "configure",
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
    ],
  } satisfies NonNullable<ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput["project"]>;
  const thread = {
    id: threadId,
    projectId,
    worktreePath: process.cwd(),
    archivedAt: null,
    settledOverride: "settled",
  } as OrchestrationV2AppThread;
  const dependencies = Layer.mergeAll(
    Layer.succeed(TerminalManager.TerminalManager, terminals),
    ServerSettings.layerTest(),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(Option.some({ workspaceRoot: fixture.baseDir } as ProjectStore.ProjectRow)),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread: () => Effect.succeed(thread) }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getShellSnapshot: () =>
        Effect.succeed({ threads: [thread] } as unknown as OrchestrationV2ThreadShellSnapshot),
    }),
    Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      resolve: ({ cwd }) =>
        Effect.succeed({ repository: { rootPath: cwd } } as VcsDriverRegistry.VcsDriverHandle),
    }),
    Layer.mock(Binder.ZmuxSessionBinder)({
      prepareUnbind: () => Effect.succeed({ status: "prepared", identity }),
      resolve: () =>
        Effect.succeed({ status: "resolved", target: "fixture/main", match: "workspace-main" }),
      unbind: () =>
        Effect.sync(() => {
          available = false;
          return { status: "unbound", target: identity.target } as const;
        }),
    }),
  );
  const reactor = yield* makeSettledLaneReactor.pipe(Effect.provide(dependencies));
  const runner = yield* ProjectSetupScriptRunner.make.pipe(Effect.provide(dependencies));
  const runHook = (trigger: "setup" | "settle" = "settle") =>
    runner.runForThread({
      threadId,
      projectId,
      project,
      worktreePath: process.cwd(),
      trigger,
      observeCompletion: {},
    });
  const finishHook = (
    run: ProjectSetupScriptRunner.ProjectSetupScriptRunnerResult,
    exitCode: number,
  ) =>
    Effect.gen(function* () {
      if (run.status !== "started" || !run.completion)
        return yield* Effect.die("hook did not start with observation");
      const process = fixture.ptyAdapter.processes.at(-1)!;
      const sentinel = /(__T3_SETUP_DONE___\w+:)/.exec(process.writes.at(-1) ?? "")?.[1];
      if (!sentinel) return yield* Effect.die("missing completion sentinel");
      busy = false;
      const completion = yield* Effect.forkChild(run.completion);
      process.emitData(`\r\n${sentinel}${exitCode}\r\nfixture$ `);
      return yield* Fiber.join(completion);
    });
  return {
    fixture,
    processRunner,
    runHook,
    finishHook,
    cleanup: reactor.reconcile(threadId),
    inventory: () => (available ? ["fixture/main", "fixture/feature"] : ["fixture/main"]),
    setSettled: (value: boolean) => {
      settled = value;
    },
    setBeforeOpen: (effect: Effect.Effect<void>) => {
      beforeOpen = effect;
    },
    openViewer: Effect.gen(function* () {
      settled = false;
      const release = yield* fixture.manager.attachStream(
        {
          threadId,
          terminalId: "viewer",
          cwd: process.cwd(),
          worktreePath: process.cwd(),
          cols: 100,
          rows: 24,
        },
        () => Effect.void,
      );
      acknowledgeKills();
      settled = true;
      return release;
    }),
  };
});

it.layer(NodeServices.layer, { excludeTestServices: true })(
  "settle-hook session teardown",
  (it) => {
    it.effect(
      "cleanup can finish before the configured hook opens without preventing completion",
      () =>
        Effect.gen(function* () {
          const h = yield* harness;
          const opening = yield* Deferred.make<void>();
          const allowOpen = yield* Deferred.make<void>();
          h.setBeforeOpen(
            Deferred.succeed(opening, undefined).pipe(Effect.andThen(Deferred.await(allowOpen))),
          );
          const hook = yield* Effect.forkChild(h.runHook());
          yield* Deferred.await(opening);
          yield* h.cleanup;
          expect(h.inventory()).toEqual(["fixture/main"]);
          yield* Deferred.succeed(allowOpen, undefined);
          const run = yield* Fiber.join(hook);
          expect(h.fixture.ptyAdapter.spawnInputs.at(-1)?.shell).toBe("/bin/bash");
          expect(h.processRunner.inputs.filter((input) => input.command === "zmux")).toEqual([]);
          expect((yield* h.finishHook(run, 0)).exitCode).toBe(0);
          expect((yield* h.fixture.getEvents).some((event) => event.type === "closed")).toBe(true);
        }),
    );

    it.effect(
      "cleanup after hook start releases the managed viewer but keeps hook observation alive",
      () =>
        Effect.gen(function* () {
          const h = yield* harness;
          const releaseViewer = yield* h.openViewer;
          const run = yield* h.runHook();
          const hook = h.fixture.ptyAdapter.processes.at(-1)!;
          const completion =
            run.status === "started" && run.completion
              ? yield* Effect.forkChild(run.completion)
              : yield* Effect.die("missing hook completion");
          yield* h.cleanup;
          expect(h.inventory()).toEqual(["fixture/main"]);
          expect(h.fixture.ptyAdapter.processes[0]?.killSignals).toContain("SIGTERM");
          expect(hook.killSignals).toEqual([]);
          expect(hook.hasDataListener()).toBe(true);
          expect(completion.pollUnsafe()).toBeUndefined();
          // The observer is evaluated once; its completion effect is passed to the helper.
          if (run.status !== "started") return yield* Effect.die("missing hook");
          expect(
            (yield* h.finishHook({ ...run, completion: Fiber.join(completion) }, 0)).exitCode,
          ).toBe(0);
          releaseViewer();
        }),
    );

    it.effect("failed hook remains inspectable after session removal", () =>
      Effect.gen(function* () {
        const h = yield* harness;
        const run = yield* h.runHook();
        yield* h.cleanup;
        expect((yield* h.finishHook(run, 7)).exitCode).toBe(7);
        expect(h.fixture.ptyAdapter.processes.at(-1)?.killSignals).toEqual([]);
        expect(h.inventory()).toEqual(["fixture/main"]);
        yield* h.fixture.manager.close({ threadId });
      }),
    );

    it.effect("setup scripts still attach to the configured managed session", () =>
      Effect.gen(function* () {
        const h = yield* harness;
        h.setSettled(false);
        yield* h.runHook("setup");
        expect(h.fixture.ptyAdapter.spawnInputs[0]?.args).toContain("open");
        yield* h.fixture.manager.close({ threadId });
      }),
    );
  },
);
