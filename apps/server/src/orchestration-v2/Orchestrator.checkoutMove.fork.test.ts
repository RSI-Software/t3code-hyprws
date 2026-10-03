import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadCheckoutMove,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for checkout moves"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "checkout-move" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

// The checkpoint service the turn start captures its baseline with, on real git.
const checkpointLayer = CheckpointService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      IdAllocator.layer,
      CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-checkout-move-test-" })),
      ),
    ),
  ),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const identity = (checkoutRoot: string, branch: string) => ({
  repositoryRoot: "/repo",
  checkoutRoot,
  revision: "revision",
  branch,
});

const move = (status: ThreadCheckoutMove["status"]): ThreadCheckoutMove =>
  ({
    requestId: CommandId.make("move-1"),
    source: identity("/repo", "main"),
    sourceThreadBranch: "main",
    sourceThreadWorktreePath: null,
    requestedPath: "/repo-feature",
    destination: identity("/repo-feature", "feature"),
    expectedCheckoutRoot: "/repo",
    status,
    completedSteps: status === "committed" ? ["metadata"] : [],
    effectiveProvider: null,
    requestedAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  }) as ThreadCheckoutMove;

it.effect("persists checkout move progress on the thread shell and commits the move", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:checkout-move");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-checkout-move"),
      threadId,
      projectId: ProjectId.make("project:checkout-move"),
      title: "Move me",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const created = yield* projections.getThreadShell(threadId);
    assert.ok(created);
    yield* TestClock.adjust(Duration.minutes(1));

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("move-queued"),
      threadId,
      expectedWorktreePath: null,
      checkoutMove: move("queued"),
    });
    const queued = yield* projections.getThreadShell(threadId);
    assert.equal(queued?.checkoutMove?.status, "queued");
    // Move bookkeeping is not thread activity.
    assert.deepEqual(queued?.updatedAt, created.updatedAt);

    const stale = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("move-stale"),
        threadId,
        expectedWorktreePath: "/somewhere-else",
        checkoutMove: move("committed"),
      }),
    );
    assert.equal(stale._tag, "Failure");

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("move-committed"),
      threadId,
      expectedWorktreePath: null,
      checkoutMove: move("committed"),
      branch: "feature",
      worktreePath: "/repo-feature",
    });
    const committed = yield* projections.getThreadShell(threadId);
    assert.notDeepEqual(committed?.updatedAt, created.updatedAt);
    assert.equal(committed?.worktreePath, "/repo-feature");
    assert.equal(committed?.branch, "feature");
    assert.deepEqual(committed?.checkoutMove, move("committed"));
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(projection.thread.checkoutMove, move("committed"));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("re-scopes the checkpoint of a run its worktree recovery is committed for", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const recovered = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "t3-checkout-recovered-",
    });
    const vcs = yield* VcsProcess.VcsProcess;
    for (const args of [["init"], ["commit", "--allow-empty", "-m", "init"]])
      yield* vcs.run({
        operation: "Orchestrator.checkoutMove.fork.test.git",
        command: "git",
        cwd: recovered,
        args: ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
        timeoutMs: 10_000,
      });
    const threadId = ThreadId.make("thread:checkout-recovery-scope");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-checkout-recovery-scope"),
      threadId,
      projectId: ProjectId.make("project:checkout-recovery-scope"),
      title: "Recover me",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature",
      worktreePath: "/removed-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    // A non-client turn starts on a worktree removed outside T3.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-on-removed-worktree"),
      threadId,
      messageId: MessageId.make("start-on-removed-worktree-input"),
      text: "Keep working",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    // The turn-start gate recovers the thread before the turn opens its
    // session. The test runtime policy resolves the thread's worktree path, so
    // the recovered checkout stands in for the project root here.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("recover-removed-worktree"),
      threadId,
      expectedWorktreePath: "/removed-worktree",
      checkoutMove: { ...move("committed"), reason: "worktree-recovery" },
      branch: "main",
      worktreePath: recovered,
    });

    const projection = yield* projections.getThreadRecords(threadId, [
      "runs",
      "nodes",
      "checkpointScopes",
    ]);
    const run = projection.runs.at(-1);
    assert.equal(run?.status, "starting");
    const rootNode = projection.nodes.find((node) => node.id === run?.rootNodeId);
    const scope = projection.checkpointScopes.find(
      (candidate) => candidate.id === rootNode?.checkpointScopeId,
    );
    assert.equal(scope?.cwd, recovered);
    assert.ok(run && scope);
    // The baseline the turn start captures from that scope.
    const ordinalWithinScope = Math.max(0, run.ordinal - 1);
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope });
    assert.isTrue(
      yield* checkpointStore.hasCheckpointRef({
        cwd: recovered,
        checkpointRef: CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope,
        }),
      }),
    );
  }).pipe(Effect.provide(Layer.mergeAll(testLayer, checkpointLayer))),
);

it.effect("records one timeline notice for a committed worktree recovery, on its live run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:checkout-recovery-notice");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-checkout-recovery-notice"),
      threadId,
      projectId: ProjectId.make("project:checkout-recovery-notice"),
      title: "Recover me",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature",
      worktreePath: "/removed-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    // The recovery is committed for the starting run, with another queued after it.
    for (const [text, type] of [
      ["live", "start_immediately"],
      ["queued", "queue_after_active"],
    ] as const) {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`notice-${text}`),
        threadId,
        messageId: MessageId.make(`notice-${text}-input`),
        text,
        attachments: [],
        dispatchMode: { type },
        createdBy: "user",
        creationSource: "web",
      });
    }
    const recovery: ThreadCheckoutMove = {
      ...move("committed"),
      requestId: CommandId.make("server:worktree-checkout-recovery:notice"),
      sourceThreadWorktreePath: "/removed-worktree",
      reason: "worktree-recovery",
      requestedPath: "/repo",
      destination: identity("/repo", "main"),
    };
    const commit = (commandId: string, expectedWorktreePath: string | null) =>
      orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(commandId),
        threadId,
        expectedWorktreePath,
        checkoutMove: recovery,
        branch: "main",
        worktreePath: null,
      });
    yield* commit(recovery.requestId, "/removed-worktree");
    // A retried dispatch, and a re-decided commit of the same move.
    yield* commit(recovery.requestId, "/removed-worktree");
    yield* commit("recommit-recovery", null);

    const { turnItems, runs } = yield* projections.getThreadRecords(
      threadId,
      ["turnItems", "runs"],
      { turnItemTypes: ["system_notice"] },
    );
    assert.deepEqual(
      runs.map((run) => run.status),
      ["starting", "queued"],
    );
    assert.deepEqual(
      turnItems.map((item) => [
        item.id,
        item.runId,
        item.type === "system_notice" ? item.message : item.type,
      ]),
      [
        [
          "fork:worktree-recovery:server:worktree-checkout-recovery:notice",
          runs[0]?.id ?? null,
          "Worktree /removed-worktree no longer exists; moved this thread to /repo on main",
        ],
      ],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses to commit a checkout move under a live run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:checkout-move-run");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-checkout-move-run"),
      threadId,
      projectId: ProjectId.make("project:checkout-move-run"),
      title: "Move me later",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    // A non-client run (queue, MCP, schedule) starts after the move service
    // found the thread idle.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-run"),
      threadId,
      messageId: MessageId.make("start-run-input"),
      text: "Keep working",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    assert.equal(runs.at(-1)?.status, "starting");

    const refused = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("move-committed-under-run"),
        threadId,
        expectedWorktreePath: null,
        checkoutMove: move("committed"),
        branch: "feature",
        worktreePath: "/repo-feature",
      }),
    );
    assert.equal(refused._tag, "Failure");
    assert.equal((yield* projections.getThreadShell(threadId))?.worktreePath, null);

    // Progress writes and the turn's own worktree recovery still land.
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("move-requeued-under-run"),
      threadId,
      expectedWorktreePath: null,
      checkoutMove: move("queued"),
    });
    assert.equal((yield* projections.getThreadShell(threadId))?.checkoutMove?.status, "queued");
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("recovery-under-run"),
      threadId,
      expectedWorktreePath: null,
      checkoutMove: { ...move("committed"), reason: "worktree-recovery" },
      branch: "main",
      worktreePath: null,
    });
    assert.equal(
      (yield* projections.getThreadShell(threadId))?.checkoutMove?.reason,
      "worktree-recovery",
    );
  }).pipe(Effect.provide(testLayer)),
);
