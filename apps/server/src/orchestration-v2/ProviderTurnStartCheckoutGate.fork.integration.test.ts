// Fork-only (zmux-estate): a removed-worktree recovery must leave the next turn
// on a session opened in the recovered checkout. The decider, the effect worker
// and the turn-start gate run for real; the provider fixes its cwd at session
// open, as Claude, ACP and Pi do, so a reused session would keep the removed
// directory.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as CheckoutMutationCoordinator from "../git/CheckoutMutationCoordinator.ts";
import { makeCheckoutRecoveryFork } from "../git/checkoutRecovery.fork.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { providerTurnStartCheckoutGateFork } from "./ProviderTurnStartCheckoutGate.fork.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import type { ReplayTurnStartWrapperFork } from "./testkit/ProviderReplayHarness.fork.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const providerInstanceId = ProviderInstanceId.make("claude-recovery-test");
const selection = {
  instanceId: providerInstanceId,
  model: "recovery-model",
} satisfies ModelSelection;
const projectId = ProjectId.make("project:worktree-recovery");
const terminalRunStatuses = new Set(["completed", "interrupted", "failed", "cancelled"]);

interface SessionLog {
  /** The cwd each session opened in, fixed for its lifetime. */
  readonly opened: ReadonlyArray<string>;
  /** The session cwd each turn ran in. */
  readonly turns: ReadonlyArray<string>;
  readonly closed: number;
  /** Threads a shared session unloaded on detach while it stayed up. */
  readonly unloaded: number;
}

/**
 * A provider whose session keeps the cwd it opened in. A thread on the project
 * root reaches it with no cwd, which the server's project-store policy
 * resolves to the root; this replay's policy leaves that to the provider.
 * With Codex's capabilities, one session serves every thread.
 */
function makeFixedCwdAdapter(
  log: Ref.Ref<SessionLog>,
  projectRoot: string,
  capabilities: typeof ClaudeProviderCapabilitiesV2 | typeof CodexProviderCapabilitiesV2,
): ProviderAdapterV2Shape {
  return {
    instanceId: providerInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const cwd = sessionInput.runtimePolicy.cwd ?? projectRoot;
        yield* Ref.update(log, (current) => ({ ...current, opened: [...current.opened, cwd] }));
        yield* Effect.addFinalizer(() =>
          Ref.update(log, (current) => ({ ...current, closed: current.closed + 1 })),
        );
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        return {
          instanceId: providerInstanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver,
            providerInstanceId,
            status: "ready",
            cwd,
            model: sessionInput.modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          unloadThread: () =>
            Ref.update(log, (current) => ({ ...current, unloaded: current.unloaded + 1 })),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(log, (current) => ({ ...current, turns: [...current.turns, cwd] }));
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
              const occurredAt = yield* DateTime.now;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong",
                  },
                  ordinal: input.providerTurnOrdinal,
                  status: "completed",
                  startedAt: occurredAt,
                  completedAt: occurredAt,
                },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
    if (Number(exitCode) !== 0) return yield* Effect.die(`git ${args.join(" ")} failed`);
  });

/** What recovery needs besides the orchestrator: Git, the lease, and the project's root. */
const checkoutServices = (projectRoot: string) =>
  Layer.mergeAll(
    VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer)),
    CheckoutMutationCoordinator.layer,
    Layer.succeed(ProjectStore.ProjectStoreV2, {
      getShell: () => Effect.succeedSome({ id: projectId, workspaceRoot: projectRoot }),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    // No branch is recorded, so recovery never recreates the worktree.
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
  ).pipe(Layer.provideMerge(NodeServices.layer));

const threadManagementFromOrchestrator = Layer.unwrap(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: orchestrator.dispatch,
      getThreadShell: orchestrator.getThreadShell,
      getShellSnapshot: orchestrator.getShellSnapshot,
      getThreadRecords: orchestrator.getThreadRecords,
    });
  }),
);

/** Wraps the replay's turn start in the checkout gate, as `runtimeLayer.ts` does. */
const withCheckoutGate =
  (projectRoot: string): ReplayTurnStartWrapperFork =>
  (dependencies) =>
    providerTurnStartCheckoutGateFork.pipe(
      Layer.provide(threadManagementFromOrchestrator),
      Layer.provide(Layer.orDie(checkoutServices(projectRoot))),
      Layer.provide(dependencies),
    );

type Checkout = "feature" | "root";

interface RecoveryCase {
  readonly recovery: string;
  readonly client: "none" | "while-starting" | "before-turn";
  /** A later user move that replaces the recovery as the thread's checkout move. */
  readonly laterMove?: "queued" | "failed";
  /** The thread returns to the worktree recreated at its old path. */
  readonly returns?: boolean;
  /** The worktree is recreated at its old path before the racing run's gate. */
  readonly recreatedBeforeGate?: boolean;
  /** One session, opened in the worktree, serves this and a second thread. */
  readonly sharedSession?: boolean;
  readonly closedOnCommit: number;
  readonly sessions: {
    readonly opened: ReadonlyArray<Checkout>;
    readonly turns: ReadonlyArray<Checkout>;
    readonly closed: number;
    readonly unloaded?: number;
  };
  /** Each turn item's type and run ordinal, in timeline order. */
  readonly timeline: ReadonlyArray<readonly [string, number | null]>;
}

/** The removed worktree's session closed once; the root's outlives every queued detach. */
const recoveredSessions: RecoveryCase["sessions"] = {
  opened: ["feature", "root"],
  turns: ["feature", "root"],
  closed: 1,
};
/** A settled turn's items, by run ordinal. */
const turn = (run: number): RecoveryCase["timeline"] => [
  ["user_message", run],
  ["checkpoint", run],
];
const noticeInRecoveredTurn: RecoveryCase["timeline"] = [
  ...turn(1),
  ["user_message", 2],
  ["system_notice", 2],
  ["checkpoint", 2],
];

/** Runs the worker until the thread's newest run settles, then drains what follows. */
const settleRunOn = (threadId: ThreadId, afterSequence: number) =>
  Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const settled = yield* (yield* EventSink.EventSinkV2)
      .stream({ threadId, afterSequence, eventType: "run.updated" })
      .pipe(
        Stream.filter(
          ({ event }) =>
            event.type === "run.updated" && terminalRunStatuses.has(event.payload.status),
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
    while (true) {
      yield* worker.drain();
      if (settled.pollUnsafe() !== undefined) break;
      yield* Effect.raceFirst(worker.awaitWork, Fiber.await(settled));
    }
    yield* worker.drain();
  });

const recoveries: ReadonlyArray<RecoveryCase> = [
  // An MCP, scheduled or queued turn finds the worktree gone at its start.
  {
    recovery: "turn-start gate",
    client: "none",
    closedOnCommit: 0,
    sessions: recoveredSessions,
    timeline: noticeInRecoveredTurn,
  },
  // A client recovery reads the thread idle and commits while another
  // starter's run is already starting.
  {
    recovery: "client, racing a starting run",
    client: "while-starting",
    closedOnCommit: 0,
    sessions: recoveredSessions,
    timeline: noticeInRecoveredTurn,
  },
  // A later user move replaces the recovery as the thread's checkout move
  // before the racing run reaches its turn start.
  ...(["queued", "failed"] as const).map((laterMove): RecoveryCase => ({
    recovery: `client, racing a starting run, then a ${laterMove} move`,
    client: "while-starting",
    laterMove,
    closedOnCommit: 0,
    sessions: recoveredSessions,
    timeline: noticeInRecoveredTurn,
  })),
  // A client recovery on an idle thread; the decider's queued detach closes
  // the session before the next turn, and the notice ends the turn it followed.
  {
    recovery: "client, on an idle thread",
    client: "before-turn",
    closedOnCommit: 1,
    sessions: recoveredSessions,
    timeline: [...turn(1), ["system_notice", 1], ...turn(2)],
  },
  // The worktree comes back at the same path before the racing run's gate:
  // the turn still opens in the root the thread moved to, and later turns stay.
  {
    recovery: "client, racing a starting run, then the worktree recreated before the gate",
    client: "while-starting",
    recreatedBeforeGate: true,
    closedOnCommit: 0,
    sessions: {
      opened: ["feature", "root"],
      turns: ["feature", "root", "root"],
      closed: 1,
    },
    timeline: [...noticeInRecoveredTurn, ...turn(3)],
  },
  // A shared session takes the cwd with every turn, so the worktree it opened
  // in going away detaches it for neither thread.
  {
    recovery: "turn-start gate, on a session shared across threads",
    client: "none",
    sharedSession: true,
    closedOnCommit: 0,
    sessions: {
      opened: ["feature"],
      turns: ["feature", "feature", "feature"],
      closed: 0,
      unloaded: 0,
    },
    timeline: noticeInRecoveredTurn,
  },
  // The worktree comes back at the same path and the thread returns to it, as
  // an MCP worktree handoff does: later turns keep the session they open there.
  {
    recovery: "turn-start gate, then a return to the recreated worktree",
    client: "none",
    returns: true,
    closedOnCommit: 0,
    sessions: {
      opened: ["feature", "root", "feature"],
      turns: ["feature", "root", "root", "feature", "feature"],
      closed: 2,
    },
    timeline: [...noticeInRecoveredTurn, ...turn(3), ...turn(4), ...turn(5)],
  },
];

it.live.each(recoveries)(
  "opens the turn after a $recovery recovery in the project root",
  ({
    client,
    laterMove,
    returns,
    recreatedBeforeGate,
    sharedSession,
    closedOnCommit,
    sessions,
    timeline,
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* checkpointWorkspace("worktree-recovery-root");
        const base = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "worktree-recovery-" }),
        );
        const feature = `${base}/feature`;
        yield* git(root, ["worktree", "add", "-b", "feature", feature]);
        const threadId = ThreadId.make(
          `thread:worktree-recovery:${client}:${laterMove}:${returns}:${recreatedBeforeGate}:${sharedSession}`,
        );
        const log = yield* Ref.make<SessionLog>({ opened: [], turns: [], closed: 0, unloaded: 0 });
        const registry = ProviderAdapterRegistry.makeSingleLayer(
          makeFixedCwdAdapter(
            log,
            root,
            sharedSession === true ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
          ),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const recovery = yield* makeCheckoutRecoveryFork.pipe(
            Effect.provide(
              Layer.mergeAll(threadManagementFromOrchestrator, checkoutServices(root)),
            ),
          );

          const settleRun = (afterSequence: number, runThreadId = threadId) =>
            settleRunOn(runThreadId, afterSequence);
          const send = (text: string, sendThreadId = threadId) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:worktree-recovery:${text}`),
              threadId: sendThreadId,
              messageId: MessageId.make(`message:worktree-recovery:${text}`),
              text,
              attachments: [],
              modelSelection: selection,
              dispatchMode: { type: "start_immediately" },
            });
          const recoverAsClient = (thread: Parameters<typeof recovery.recoverRemovedWorktree>[0]) =>
            recovery.recoverRemovedWorktree(thread, {
              recoveryId: "client-recovery",
              duringRun: false,
            });

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:worktree-recovery:create"),
            threadId,
            projectId,
            title: "Worktree recovery",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: feature,
          });
          const firstTurn = yield* eventSink.latestSequence();
          yield* send("first");
          yield* settleRun(firstTurn);
          yield* fileSystem.remove(feature, { recursive: true });

          const idle = yield* orchestrator.getThreadShell(threadId);
          assert.isNotNull(idle);
          const secondTurn = yield* eventSink.latestSequence();
          if (client === "before-turn") {
            assert.isTrue((yield* recoverAsClient(idle!)).moved);
            yield* worker.drain();
            assert.equal((yield* Ref.get(log)).closed, closedOnCommit);
          }
          yield* send("second");
          if (client === "while-starting") {
            assert.isTrue((yield* recoverAsClient(idle!)).moved);
            assert.equal((yield* Ref.get(log)).closed, closedOnCommit);
          }
          if (laterMove !== undefined) {
            const recovered = (yield* orchestrator.getThreadShell(threadId))?.checkoutMove;
            assert.equal(recovered?.reason, "worktree-recovery");
            const { reason: _reason, ...userMove } = recovered!;
            yield* orchestrator.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`command:worktree-recovery:${laterMove}-move`),
              threadId,
              expectedWorktreePath: null,
              checkoutMove: {
                ...userMove,
                requestId: CommandId.make(`${laterMove}-move`),
                status: laterMove,
              },
            });
          }
          const recreate = Effect.andThen(
            git(root, ["worktree", "prune"]),
            git(root, ["worktree", "add", feature, "feature"]),
          );
          if (recreatedBeforeGate === true) yield* recreate;
          yield* settleRun(secondTurn);
          if (recreatedBeforeGate === true) {
            const turn = yield* eventSink.latestSequence();
            yield* send("third");
            yield* settleRun(turn);
          }
          if (sharedSession === true) {
            const otherThreadId = ThreadId.make(`${threadId}:other`);
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:worktree-recovery:create-other"),
              threadId: otherThreadId,
              projectId,
              title: "Shared session",
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            const turn = yield* eventSink.latestSequence();
            yield* send("other", otherThreadId);
            yield* settleRun(turn, otherThreadId);
          }
          if (returns === true) {
            yield* send("third");
            yield* settleRun(yield* eventSink.latestSequence());
            yield* recreate;
            yield* orchestrator.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("command:worktree-recovery:handoff"),
              threadId,
              expectedWorktreePath: null,
              branch: "feature",
              worktreePath: feature,
            });
            yield* worker.drain();
            for (const text of ["fourth", "fifth"]) {
              const turn = yield* eventSink.latestSequence();
              yield* send(text);
              yield* settleRun(turn);
            }
          }

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(projection.thread.worktreePath, returns === true ? feature : null);
          assert.deepEqual(
            projection.runs.map((run) => run.status),
            timeline.flatMap(([type]) => (type === "user_message" ? ["completed"] : [])),
          );
          const checkoutPath = { feature, root };
          assert.deepEqual(yield* Ref.get(log), {
            opened: sessions.opened.map((checkout) => checkoutPath[checkout]),
            turns: sessions.turns.map((checkout) => checkoutPath[checkout]),
            closed: sessions.closed,
            unloaded: sessions.unloaded ?? 0,
          });
          // The recovery notice sits where the recovery happened, after the
          // prior run's items.
          const runOrdinals = new Map(projection.runs.map((run) => [run.id, run.ordinal]));
          const items: RecoveryCase["timeline"] = projection.turnItems
            .toSorted((left, right) => left.ordinal - right.ordinal)
            .map((item) => [
              item.type,
              item.runId === null ? null : (runOrdinals.get(item.runId) ?? null),
            ]);
          assert.deepEqual(items, timeline);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: `worktree-recovery-${client}-${laterMove}-${returns}-${recreatedBeforeGate}-${sharedSession}`,
              },
              registry,
              {
                runEffectWorker: false,
                wrapTurnStartFork: withCheckoutGate(root),
              },
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

// The turn-start gate retries a run under one recovery id. A recovery refused
// because another thread runs in the project root must not swallow the retry
// that finds the root idle.
it.live("commits a recovery retried after the project root went idle", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* checkpointWorkspace("worktree-recovery-retry-root");
      const base = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "worktree-recovery-retry-" }),
      );
      const feature = `${base}/feature`;
      yield* git(root, ["worktree", "add", "-b", "feature", feature]);
      const threadId = ThreadId.make("thread:worktree-recovery-retry");
      const rootThreadId = ThreadId.make("thread:worktree-recovery-retry:root");
      const log = yield* Ref.make<SessionLog>({ opened: [], turns: [], closed: 0, unloaded: 0 });
      const registry = ProviderAdapterRegistry.makeSingleLayer(
        makeFixedCwdAdapter(log, root, ClaudeProviderCapabilitiesV2),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const recovery = yield* makeCheckoutRecoveryFork.pipe(
          Effect.provide(Layer.mergeAll(threadManagementFromOrchestrator, checkoutServices(root))),
        );
        for (const [id, worktreePath] of [
          [threadId, feature],
          [rootThreadId, null],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:${id}:create`),
            threadId: id,
            projectId,
            title: "Worktree recovery retry",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath,
          });
        }
        const rootTurn = yield* eventSink.latestSequence();
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:worktree-recovery-retry:root-turn"),
          threadId: rootThreadId,
          messageId: MessageId.make("message:worktree-recovery-retry:root-turn"),
          text: "busy in the root",
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* fileSystem.remove(feature, { recursive: true });
        const rootThread = yield* orchestrator.getThreadShell(rootThreadId);
        assert.isNotNull(rootThread?.activeRunId ?? null);

        const recover = Effect.gen(function* () {
          const thread = yield* orchestrator.getThreadShell(threadId);
          assert.isNotNull(thread);
          return yield* recovery.recoverRemovedWorktree(thread!, {
            recoveryId: "server:worktree-checkout-recovery:retried-run",
            duringRun: true,
          });
        });
        assert.isFalse((yield* recover).moved);
        assert.equal(
          (yield* orchestrator.getThreadShell(threadId))?.checkoutMove?.status,
          "failed",
        );

        yield* settleRunOn(rootThreadId, rootTurn);
        assert.isTrue((yield* recover).moved);
        const recovered = yield* orchestrator.getThreadShell(threadId);
        assert.isNull(recovered?.worktreePath);
        assert.equal(recovered?.checkoutMove?.status, "committed");
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry({ name: "worktree-recovery-retry" }, registry, {
            runEffectWorker: false,
            wrapTurnStartFork: withCheckoutGate(root),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);
