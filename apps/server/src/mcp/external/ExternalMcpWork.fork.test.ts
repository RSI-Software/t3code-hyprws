// The external work view against the shapes the UI reads: an owner whose run
// completed with subagents still running, and provider-native subagent threads,
// which have no runs. Shells come from the real shell projection, so the view
// and the sidebar's "Waiting on N subagents" read the same derivation.
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { threadShellFromProjection } from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ExternalMcpService from "./ExternalMcpService.fork.ts";
import { nativeTurnOf, threadWork } from "./ExternalMcpWork.fork.ts";

const granted = ProjectId.make("project:granted");
const other = ProjectId.make("project:other");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };
const at = (iso: string) => DateTime.makeUnsafe(iso);
const runStart = at("2026-10-06T09:57:21.000Z");
const runEnd = at("2026-10-06T09:57:59.000Z");

const owner = ThreadId.make("thread:owner");
const ownerRun = RunId.make(`run:${owner}:ordinal:2`);
const childIds = [1, 2, 3, 4, 5].map((index) => ThreadId.make(`thread:child-${index}`));

type NodeStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
type RunStatus = "running" | "waiting" | "completed" | "interrupted";

const projectionOf = (input: {
  readonly id: ThreadId;
  readonly projectId?: ProjectId;
  readonly parent?: ThreadId;
  readonly runs?: ReadonlyArray<unknown>;
  readonly turnItems?: ReadonlyArray<unknown>;
  readonly nodes?: ReadonlyArray<unknown>;
  readonly runtimeRequests?: ReadonlyArray<unknown>;
}) =>
  ({
    thread: {
      createdBy: input.parent === undefined ? "user" : "agent",
      creationSource: input.parent === undefined ? "web" : "provider",
      id: input.id,
      projectId: input.projectId ?? granted,
      title: `Thread ${input.id}`,
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      lineage: {
        parentThreadId: input.parent ?? null,
        relationshipToParent: input.parent === undefined ? null : "subagent",
        rootThreadId: input.parent ?? input.id,
      },
      forkedFrom: null,
      activeProviderThreadId: null,
      createdAt: runStart,
      updatedAt: runEnd,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: input.runs ?? [],
    attempts: [],
    nodes: input.nodes ?? [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: input.runtimeRequests ?? [],
    messages: [],
    plans: [],
    turnItems: input.turnItems ?? [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: runEnd,
  }) as unknown as OrchestrationV2ThreadProjection;

const run = (threadId: ThreadId, id: RunId, status: RunStatus) => ({
  id,
  threadId,
  ordinal: 2,
  providerInstanceId: instanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: "message:1",
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: runStart,
  startedAt: runStart,
  completedAt: status === "running" ? null : runEnd,
  checkpointId: null,
  contextHandoffId: null,
});

const subagentItem = (index: number, status: "running" | "completed") => ({
  id: `item:subagent-${index}`,
  type: "subagent",
  threadId: owner,
  runId: ownerRun,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: index,
  status,
  title: `Concept ${index}`,
  subagentId: `node:subagent-${index}`,
  origin: "provider_native",
  driver: "claudeAgent",
  providerInstanceId: instanceId,
  childThreadId: childIds[index - 1],
  prompt: `Explore concept ${index}`,
  result: null,
  startedAt: runStart,
  completedAt: status === "running" ? null : runEnd,
  updatedAt: runEnd,
});

const commandItem = {
  ...subagentItem(9, "running"),
  id: "item:dev-server",
  type: "command_execution",
  title: "vp run dev",
};

/** The live repro: run 2 completed, its five native subagents still running. */
const ownerProjection = (subagents: "running" | "completed" = "running") =>
  projectionOf({
    id: owner,
    runs: [run(owner, ownerRun, "completed")],
    turnItems: [1, 2, 3, 4, 5].map((index) => subagentItem(index, subagents)),
  });

const rootTurn = (threadId: ThreadId, status: NodeStatus) => ({
  id: `node:${threadId}:root`,
  threadId,
  runId: null,
  parentNodeId: null,
  rootNodeId: `node:${threadId}:root`,
  kind: "root_turn",
  status,
  countsForRun: false,
  startedAt: runStart,
  completedAt: status === "pending" || status === "running" ? null : runEnd,
});

const childProjection = (threadId: ThreadId, status: NodeStatus) =>
  projectionOf({ id: threadId, parent: owner, nodes: [rootTurn(threadId, status)] });

const pendingApproval = {
  id: "request:1",
  kind: "approval",
  status: "pending",
  createdAt: runEnd,
};

const workOfProjection = (projection: OrchestrationV2ThreadProjection) =>
  threadWork(threadShellFromProjection(projection), nativeTurnOf(projection.nodes));

describe("external MCP thread work", () => {
  it("reads an owner whose run completed as waiting on its five subagents", () => {
    const projection = ownerProjection();
    const shell = threadShellFromProjection(projection);
    // The run view the external surface returned before: finished, nothing pending.
    assert.strictEqual(shell.status, "completed");
    assert.strictEqual(shell.activeRunId, null);
    const work = workOfProjection(projection);
    assert.strictEqual(work.state, "waiting_on_background");
    assert.deepStrictEqual<unknown>(
      work.background.map((task) => [task.kind, task.childThreadId, task.holdsCompletion]),
      childIds.map((childId) => ["subagent", childId, true]),
    );
    assert.strictEqual(work.nativeTurn, null);
    assert.strictEqual(work.updatedAt, "2026-10-06T09:57:59.000Z");
  });

  it("reads subagents ahead of a run waiting on its checkpoint", () => {
    const waiting = (turnItems: ReadonlyArray<unknown>) =>
      workOfProjection(
        projectionOf({ id: owner, runs: [run(owner, ownerRun, "waiting")], turnItems }),
      ).state;
    assert.strictEqual(waiting([subagentItem(1, "running")]), "waiting_on_background");
    assert.strictEqual(waiting([]), "running");
  });

  it("reads the owner as idle once its subagents end", () => {
    const work = workOfProjection(ownerProjection("completed"));
    assert.strictEqual(work.state, "idle");
    assert.deepStrictEqual(work.background, []);
  });

  it("lists a command left running without holding the thread open", () => {
    const work = workOfProjection(
      projectionOf({
        id: owner,
        runs: [run(owner, ownerRun, "completed")],
        turnItems: [commandItem],
      }),
    );
    assert.strictEqual(work.state, "idle");
    assert.deepStrictEqual(
      work.background.map((task) => [task.kind, task.childThreadId, task.holdsCompletion]),
      [["command", null, false]],
    );
  });

  it("reads a running native subagent with no runs as running", () => {
    const projection = childProjection(childIds[0]!, "running");
    assert.strictEqual(threadShellFromProjection(projection).status, "idle");
    const work = workOfProjection(projection);
    assert.strictEqual(work.state, "running");
    assert.deepStrictEqual(work.nativeTurn, {
      status: "running",
      startedAt: "2026-10-06T09:57:21.000Z",
      completedAt: null,
    });
  });

  it("reports each terminal native outcome explicitly", () => {
    for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
      const work = workOfProjection(childProjection(childIds[0]!, status));
      assert.strictEqual(work.state, "idle");
      assert.deepStrictEqual(work.nativeTurn, {
        status,
        startedAt: "2026-10-06T09:57:21.000Z",
        completedAt: "2026-10-06T09:57:59.000Z",
      });
    }
  });

  it("reads the last runless root turn, not one that belongs to a run", () => {
    const threadId = childIds[0]!;
    const nodes = [
      rootTurn(threadId, "completed"),
      { ...rootTurn(threadId, "running"), id: "node:second", runId: ownerRun },
    ];
    assert.strictEqual(nativeTurnOf(nodes as never)?.status, "completed");
  });

  it("reads a request waiting on a person ahead of background work", () => {
    const work = workOfProjection(
      projectionOf({
        id: owner,
        runs: [run(owner, ownerRun, "completed")],
        turnItems: [subagentItem(1, "running")],
        runtimeRequests: [pendingApproval],
      }),
    );
    assert.strictEqual(work.state, "awaiting_response");
    assert.strictEqual(work.background.length, 1);
  });

  it("reads an active run as running and a thread with no work as idle", () => {
    const running = workOfProjection(
      projectionOf({ id: owner, runs: [run(owner, ownerRun, "running")] }),
    );
    assert.strictEqual(running.state, "running");
    assert.deepStrictEqual(running.background, []);
    const interrupted = workOfProjection(
      projectionOf({ id: owner, runs: [run(owner, ownerRun, "interrupted")] }),
    );
    assert.strictEqual(interrupted.state, "idle");
    assert.strictEqual(workOfProjection(projectionOf({ id: owner })).state, "idle");
  });
});

const principal: ExternalMcpService.ExternalMcpPrincipal = {
  sessionId: AuthSessionId.make("session-work"),
  subject: "device-authorization",
  clientLabel: "dot cloud",
  expiresAt: null,
  policy: {
    projectIds: [granted],
    coordinate: true,
    maxRuntimeMode: "full-access",
    maxInteractionMode: "default",
  },
};

const projectShell = (id: ProjectId) =>
  ({ id, title: String(id), workspaceRoot: `/work/${id}` }) as unknown as OrchestrationProjectShell;

/** Projections live in a map a test rewrites; every read derives the shell from it. */
const makeHarness = () => {
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>([
    [owner, ownerProjection()],
    ...childIds.map((id) => [id, childProjection(id, "running")] as const),
    [
      ThreadId.make("thread:hidden"),
      projectionOf({ id: ThreadId.make("thread:hidden"), projectId: other }),
    ],
  ]);
  const runWaits: Array<ThreadManagementService.ThreadManagementWaitInput> = [];
  const projection = (threadId: ThreadId) => projections.get(threadId)!;
  const layer = ExternalMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.sync(() =>
              projections.has(threadId) ? threadShellFromProjection(projection(threadId)) : null,
            ),
          getProjectThreadRecords: (input) =>
            Effect.sync(() => projection(input.threadId) as never),
          getThreadRecords: (threadId) => Effect.sync(() => projection(threadId) as never),
          listProjectThreads: (input) =>
            Effect.sync(() =>
              [...projections.values()]
                .filter((entry) => entry.thread.projectId === input.projectId)
                .map(threadShellFromProjection),
            ),
          getTimelinePage: () =>
            Effect.succeed({ items: [], totalItems: 0, hasMore: false } as never),
          waitForThread: (input) =>
            Effect.sync(() => {
              runWaits.push(input);
              return {
                threadId: input.threadId,
                run: projection(input.threadId).runs[0] ?? null,
                timedOut: false,
              };
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getShell: (projectId) => Effect.succeed(Option.some(projectShell(projectId))),
          listShells: () => Effect.succeed([projectShell(granted), projectShell(other)]),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({} as never),
        }),
        Layer.fresh(SqlitePersistenceMemory),
      ),
    ),
  );
  const withService = <A, E>(
    body: (service: ExternalMcpService.ExternalMcpServiceShape) => Effect.Effect<A, E>,
  ) => Effect.flatMap(ExternalMcpService.ExternalMcpServiceFork, body).pipe(Effect.provide(layer));
  return { projections, runWaits, withService };
};

describe("ExternalMcpServiceFork work", () => {
  it.effect("read and list show the owner's background work and each child's turn", () => {
    const harness = makeHarness();
    return harness.withService((service) =>
      Effect.gen(function* () {
        const read = yield* service.readThread(principal, { threadId: owner });
        assert.strictEqual(read.thread.status, "completed");
        assert.strictEqual(read.thread.pendingRequestCount, 0);
        assert.strictEqual(read.thread.work.state, "waiting_on_background");
        assert.strictEqual(read.thread.work.background.length, 5);

        const child = yield* service.readThread(principal, { threadId: childIds[0]! });
        assert.strictEqual(child.thread.runCount, 0);
        assert.strictEqual(child.thread.status, "idle");
        assert.strictEqual(child.thread.work.state, "running");
        assert.strictEqual(child.thread.work.nativeTurn?.status, "running");

        const list = yield* service.listThreads(principal, { projectId: granted });
        assert.deepStrictEqual(
          list.threads.map((thread) => [thread.threadId, thread.status, thread.work.state]),
          [
            [owner, "completed", "waiting_on_background"],
            ...childIds.map((id) => [id, "idle", "running"]),
          ],
        );
      }),
    );
  });

  it.effect("a work wait returns once the subagents end, keeping the latest run", () => {
    const harness = makeHarness();
    return harness.withService((service) =>
      Effect.gen(function* () {
        const fiber = yield* service
          .waitForThread(principal, { threadId: owner, until: "work", timeoutMs: 10_000 })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        assert.isUndefined(fiber.pollUnsafe());
        harness.projections.set(owner, ownerProjection("completed"));
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
        assert.deepStrictEqual(
          [result.runId, result.status, result.timedOut, result.work.state],
          [ownerRun, "completed", false, "idle"],
        );
        assert.deepStrictEqual(harness.runWaits, []);
      }),
    );
  });

  it.effect("a work wait that times out reports the work still running", () => {
    const harness = makeHarness();
    return harness.withService((service) =>
      Effect.gen(function* () {
        const fiber = yield* service
          .waitForThread(principal, { threadId: childIds[0]!, until: "work", timeoutMs: 2_000 })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("3 seconds");
        const result = yield* Fiber.join(fiber);
        assert.deepStrictEqual(
          [result.runId, result.timedOut, result.work.state],
          [null, true, "running"],
        );
      }),
    );
  });

  it.effect("a pinned run wait keeps the run's outcome and adds the work after it", () => {
    const harness = makeHarness();
    return harness.withService((service) =>
      Effect.gen(function* () {
        const result = yield* service.waitForThread(principal, {
          threadId: owner,
          runId: ownerRun,
        });
        assert.deepStrictEqual(
          [result.runId, result.status, result.timedOut, result.work.state],
          [ownerRun, "completed", false, "waiting_on_background"],
        );
        assert.deepStrictEqual(
          harness.runWaits.map((wait) => wait.runId),
          [ownerRun],
        );
      }),
    );
  });

  it.effect("rejects a work wait pinned to a run", () => {
    const harness = makeHarness();
    return harness.withService((service) =>
      Effect.gen(function* () {
        const error = yield* service
          .waitForThread(principal, { threadId: owner, runId: ownerRun, until: "work" })
          .pipe(Effect.flip);
        assert.strictEqual(error.code, "invalid_request");
      }),
    );
  });

  it.effect("a thread outside the grant stays hidden from read and work wait", () => {
    const harness = makeHarness();
    const hidden = ThreadId.make("thread:hidden");
    return harness.withService((service) =>
      Effect.gen(function* () {
        const read = yield* service.readThread(principal, { threadId: hidden }).pipe(Effect.flip);
        const wait = yield* service
          .waitForThread(principal, { threadId: hidden, until: "work", timeoutMs: 1 })
          .pipe(Effect.flip);
        assert.strictEqual(read.code, wait.code);
        assert.strictEqual(read.message, wait.message);
      }),
    );
  });
});
