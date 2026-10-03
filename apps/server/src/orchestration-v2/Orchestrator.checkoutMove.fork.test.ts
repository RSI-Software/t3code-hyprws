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
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
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
