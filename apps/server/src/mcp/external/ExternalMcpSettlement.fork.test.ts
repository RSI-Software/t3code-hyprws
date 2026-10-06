import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EventId,
  ExternalMcpSettlementResultFork,
  MessageId,
  NodeId,
  OrchestratorMcpThreadReadResult,
  type OrchestrationProjectShell,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/unstable/ai";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import { DEVICE_AUTHORIZATION_SUBJECT } from "../../auth/DeviceAuthorization.fork.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ExternalMcpGrant from "../../auth/ExternalMcpGrant.fork.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ExternalMcpServer from "./ExternalMcpServer.fork.ts";
import * as ExternalMcpService from "./ExternalMcpService.fork.ts";

const projectId = ProjectId.make("project:settlement");
const threadId = ThreadId.make("thread:settlement");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test" };
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRpc = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
  }),
);
const decodeTools = Schema.decodeUnknownEffect(McpSchema.ListToolsResult);
const decodeRequired = Schema.decodeUnknownEffect(
  Schema.Struct({ required: Schema.Array(Schema.String) }),
);
const decodeToolResult = Schema.decodeUnknownEffect(McpSchema.CallToolResult);
const decodeSettlement = Schema.decodeUnknownEffect(ExternalMcpSettlementResultFork);
const decodeThreadRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const principal: ExternalMcpService.ExternalMcpPrincipal = {
  sessionId: AuthSessionId.make("settlement-client"),
  subject: DEVICE_AUTHORIZATION_SUBJECT,
  clientLabel: "settlement fixture",
  expiresAt: null,
  policy: {
    projectIds: [projectId],
    coordinate: true,
    maxRuntimeMode: "approval-required",
    maxInteractionMode: "plan",
  },
};
const request = (settled: boolean, clientRequestId: string) => ({
  threadId,
  settled,
  clientRequestId,
});
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Settlement must not start a provider process"),
} satisfies ProviderAdapterV2Shape;

const setup = Effect.gen(function* () {
  const database = SqlitePersistenceMemory;
  const registry = ProviderAdapterRegistry.makeLayer([adapter]);
  const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "external-settlement" },
    registry,
    { databaseLayer: database, runEffectWorker: false },
  );
  let next: { before?: Effect.Effect<void>; after?: Effect.Effect<void> } | undefined;
  const management = Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.gen(function* () {
      const inner = yield* ThreadManagementService.ThreadManagementService;
      return {
        ...inner,
        dispatch: (command: OrchestrationV2ServerCommand) =>
          Effect.gen(function* () {
            const step =
              command.type === "thread.settle" || command.type === "thread.unsettle"
                ? next
                : undefined;
            if (step !== undefined) next = undefined;
            if (step?.before !== undefined) yield* step.before;
            const result = yield* inner.dispatch(command);
            if (step?.after !== undefined) yield* step.after;
            return result;
          }),
      };
    }),
  ).pipe(Layer.provide(ThreadManagementService.layer), Layer.provide(orchestratorLayer));
  const shell = {
    id: projectId,
    title: "fixture",
    workspaceRoot: process.cwd(),
  } as OrchestrationProjectShell;
  const services = yield* Layer.build(
    Layer.mergeAll(
      orchestratorLayer,
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      EffectOutbox.layer.pipe(Layer.provide(database)),
      ExternalMcpService.layer.pipe(
        Layer.provideMerge(management),
        Layer.provideMerge(
          Layer.mergeAll(
            registry,
            Layer.mock(ProjectService.ProjectService)({
              getShell: () => Effect.succeed(Option.some(shell)),
              listShells: () => Effect.succeed([shell]),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            ServerSettings.layerTest(),
            database,
          ),
        ),
      ),
    ).pipe(Layer.provide(NodeServices.layer)),
  );
  const service = Context.get(services, ExternalMcpService.ExternalMcpServiceFork);
  const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
  const sql = Context.get(services, SqlClient.SqlClient);
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    orchestrator.dispatch(command).pipe(Effect.orDie);
  yield* dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("fixture:create"),
    threadId,
    projectId,
    title: "settlement fixture",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
  });
  const change = (settled: boolean, key: string) =>
    service.settleThread(principal, request(settled, key));
  const read = service.readThread(principal, { threadId });
  const loseResults = sql`UPDATE auth_external_mcp_requests SET result_json = NULL`.pipe(
    Effect.asVoid,
    Effect.orDie,
  );
  const interleave = (step: NonNullable<typeof next>) => {
    next = step;
  };
  return { service, orchestrator, services, sql, dispatch, change, read, loseResults, interleave };
});

describe("external MCP settlement on the real orchestrator", () => {
  it.effect("settles and unsets the UI state, preserving timestamps on new-key repeats", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.dispatch({ type: "thread.pin", commandId: CommandId.make("fixture:pin"), threadId });
      const settled = yield* h.change(true, "settle");
      assert.equal(settled.settled, true);
      assert.isNotNull(settled.settledAt);
      assert.equal((yield* h.orchestrator.getThreadProjection(threadId)).thread.pinnedAt, null);
      assert.equal((yield* h.read).thread.settledAt, settled.settledAt);
      const repeated = yield* h.change(true, "settle-again");
      assert.equal(repeated.settledAt, settled.settledAt);
      const active = yield* h.change(false, "unsettle");
      assert.equal(active.settled, false);
      assert.equal(active.settledAt, null);
      assert.equal((yield* h.read).thread.settled, false);
      const before = (yield* h.orchestrator.getThreadProjection(threadId)).thread.unsettledAt;
      yield* h.change(false, "unsettle-again");
      const after = (yield* h.orchestrator.getThreadProjection(threadId)).thread;
      assert.equal(after.settledOverride, "active");
      assert.deepEqual(after.unsettledAt, before);
      const listed = yield* h.service.listThreads(principal, { projectId, settled: false });
      assert.deepEqual(
        listed.threads.map((t) => t.threadId),
        [threadId],
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each([true, false])(
    "serializes copies and rebuilds the service to replay settled=%s after a lost result",
    (settled) =>
      Effect.gen(function* () {
        const h = yield* setup;
        const results = yield* Effect.all([h.change(settled, "same"), h.change(settled, "same")], {
          concurrency: "unbounded",
        });
        assert.deepEqual(results[0], results[1]);
        yield* h.change(!settled, "reverse");
        const snapshot = yield* h.orchestrator.getThreadProjection(threadId);
        yield* h.loseResults;
        const rebuilt = Context.get(
          yield* Layer.build(
            Layer.fresh(ExternalMcpService.layer).pipe(
              Layer.provide(Layer.succeedContext(h.services)),
            ),
          ),
          ExternalMcpService.ExternalMcpServiceFork,
        );
        assert.deepEqual(
          yield* rebuilt.settleThread(principal, request(settled, "same")),
          results[0],
        );
        assert.deepEqual(yield* h.orchestrator.getThreadProjection(threadId), snapshot);
        const conflict = yield* h.change(!settled, "same").pipe(Effect.flip);
        assert.equal(conflict.code, "invalid_request");
        const targetConflict = yield* h.service
          .settleThread(principal, { ...request(true, "same"), threadId: ThreadId.make("absent") })
          .pipe(Effect.flip);
        assert.equal(targetConflict.code, "thread_not_found");
        const otherThread = ThreadId.make("thread:other-target");
        yield* h.dispatch({
          type: "thread.create",
          commandId: CommandId.make("fixture:other"),
          threadId: otherThread,
          projectId,
          title: "other target",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        assert.equal(
          (yield* h.service
            .settleThread(principal, {
              ...request(true, "same"),
              threadId: otherThread,
            })
            .pipe(Effect.flip)).code,
          "invalid_request",
        );
        assert.equal(
          (yield* h.orchestrator.getThreadProjection(otherThread)).thread.settledOverride,
          null,
        );
        const anotherSession = { ...principal, sessionId: AuthSessionId.make("other-client") };
        const independent = yield* h.service.settleThread(anotherSession, request(true, "same"));
        assert.notEqual(independent.commandId, results[0]!.commandId);
      }).pipe(Effect.scoped),
  );

  it.effect.each([true, false])(
    "acknowledges settled=%s when the owner reverses it before the response",
    (settled) =>
      Effect.gen(function* () {
        const h = yield* setup;
        h.interleave({
          after: h
            .dispatch(
              settled
                ? {
                    type: "thread.unsettle",
                    reason: "user",
                    threadId,
                    commandId: CommandId.make("owner:reverse"),
                  }
                : { type: "thread.settle", threadId, commandId: CommandId.make("owner:reverse") },
            )
            .pipe(Effect.asVoid),
        });
        const original = yield* h.change(settled, "race");
        assert.equal(original.settled, settled);
        assert.equal((yield* h.read).thread.settled, !settled);
        assert.deepEqual(yield* h.change(settled, "race"), original);
      }).pipe(Effect.scoped),
  );

  it.effect.each([true, false])(
    "refuses unauthorized settled=%s requests and cached replays",
    (settled) =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* h.change(settled, "authorized");
        const denied = yield* h.service
          .settleThread(
            { ...principal, policy: { ...principal.policy, coordinate: false } },
            request(settled, "authorized"),
          )
          .pipe(Effect.flip);
        assert.equal(denied.code, "capability_denied");
        const outside = yield* h.service
          .settleThread(
            {
              ...principal,
              policy: { ...principal.policy, projectIds: [ProjectId.make("other")] },
            },
            request(settled, "authorized"),
          )
          .pipe(Effect.flip);
        assert.equal(outside.code, "thread_not_found");
        const missing = yield* h.service
          .settleThread(principal, {
            ...request(settled, "missing"),
            threadId: ThreadId.make("missing"),
          })
          .pipe(Effect.flip);
        assert.equal(missing.code, "thread_not_found");
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { mode: "runtime", settled: true },
    { mode: "runtime", settled: false },
    { mode: "interaction", settled: true },
    { mode: "interaction", settled: false },
  ] as const)(
    "refuses $mode ceiling escalation before and during settled=$settled",
    ({ mode, settled }) =>
      Effect.gen(function* () {
        const h = yield* setup;
        const escalation = h.dispatch(
          mode === "runtime"
            ? {
                type: "thread.runtime-mode.set",
                threadId,
                runtimeMode: "full-access",
                commandId: CommandId.make("owner:runtime"),
              }
            : {
                type: "thread.interaction-mode.set",
                threadId,
                interactionMode: "default",
                commandId: CommandId.make("owner:interaction"),
              },
        );
        h.interleave({ before: escalation.pipe(Effect.asVoid) });
        const race = yield* h.change(settled, "race").pipe(Effect.flip);
        assert.equal(race.code, "orchestration_error");
        assert.equal(
          (yield* h.orchestrator.getThreadProjection(threadId)).thread.settledOverride,
          null,
        );
        const preflight = yield* h.change(settled, "preflight").pipe(Effect.flip);
        assert.equal(
          preflight.code,
          mode === "runtime"
            ? "runtime_mode_escalation_denied"
            : "interaction_mode_escalation_denied",
        );
      }).pipe(Effect.scoped),
  );

  it.effect.each(["archive", "delete", "start"] as const)(
    "refuses a raced %s before settlement commits",
    (kind) =>
      Effect.gen(function* () {
        const h = yield* setup;
        const command: OrchestrationV2ServerCommand =
          kind === "start"
            ? {
                type: "message.dispatch",
                createdBy: "user",
                creationSource: "web",
                threadId,
                commandId: CommandId.make("owner:start"),
                messageId: MessageId.make("owner:message"),
                text: "held queued work",
                attachments: [],
                modelSelection,
                dispatchMode: { type: "start_immediately" },
              }
            : {
                type: kind === "archive" ? "thread.archive" : "thread.delete",
                threadId,
                commandId: CommandId.make(`owner:${kind}`),
              };
        h.interleave({ before: h.dispatch(command).pipe(Effect.asVoid) });
        const denied = yield* h.change(true, "race").pipe(Effect.flip);
        assert.equal(denied.code, "orchestration_error");
        assert.equal(
          (yield* h.orchestrator.getThreadProjection(threadId)).thread.settledOverride,
          null,
        );
      }).pipe(Effect.scoped),
  );

  it.effect.each(["permission", "user_input"] as const)(
    "refuses settlement while a live %s request is pending",
    (kind) =>
      Effect.gen(function* () {
        const h = yield* setup;
        const projections = Context.get(h.services, ProjectionStore.ProjectionStoreV2);
        const now = yield* DateTime.now;
        yield* projections.apply({
          id: EventId.make("fixture:pending"),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("fixture:question"),
            nodeId: NodeId.make("fixture:node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind,
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: ProviderSessionId.make("fixture:session"),
            },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const before = yield* h.orchestrator.getThreadProjection(threadId);
        assert.equal(
          (yield* h.change(true, "blocked").pipe(Effect.flip)).code,
          "orchestration_error",
        );
        assert.deepEqual(yield* h.orchestrator.getThreadProjection(threadId), before);
        assert.equal((yield* h.change(false, "active")).settled, false);
        assert.deepEqual(
          (yield* h.orchestrator.getThreadProjection(threadId)).runtimeRequests,
          before.runtimeRequests,
        );
      }).pipe(Effect.scoped),
  );

  it.effect("unsettles working threads without stopping or replacing their run", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        threadId,
        commandId: CommandId.make("owner:start"),
        messageId: MessageId.make("owner:message"),
        text: "held",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const before = (yield* h.orchestrator.getThreadProjection(threadId)).runs;
      assert.equal((yield* h.change(false, "active")).settled, false);
      assert.deepEqual((yield* h.orchestrator.getThreadProjection(threadId)).runs, before);
      assert.equal(
        (yield* h.change(true, "blocked").pipe(Effect.flip)).code,
        "orchestration_error",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "cancels async questions, clears pins/watches and detaches sessions without restoring them on unsettle",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const projections = Context.get(h.services, ProjectionStore.ProjectionStoreV2);
        const outbox = Context.get(h.services, EffectOutbox.EffectOutboxV2);
        const now = yield* DateTime.now;
        const sessionId = ProviderSessionId.make("fixture:idle-session");
        yield* h.dispatch({
          type: "thread.pin",
          commandId: CommandId.make("fixture:pin"),
          threadId,
        });
        yield* h.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("fixture:watch"),
          threadId,
          host: "github.com",
          repository: "RSI-Software/fixture",
          number: 1,
          watching: true,
          link: { url: "https://github.com/RSI-Software/fixture/pull/1", source: "agent" },
        });
        yield* projections.apply({
          id: EventId.make("fixture:attach"),
          type: "provider-session.attached",
          threadId,
          occurredAt: now,
          payload: {
            id: sessionId,
            driver: adapter.driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: "test",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
        yield* projections.apply({
          id: EventId.make("fixture:async-question"),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("fixture:question"),
            nodeId: NodeId.make("fixture:node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const before = yield* h.orchestrator.getThreadProjection(threadId);
        assert.isDefined(before.thread.pullRequests?.[0]?.watch);
        assert.lengthOf(before.providerSessions, 1);
        const settled = yield* h.change(true, "side-effects");
        const after = yield* h.orchestrator.getThreadProjection(threadId);
        assert.equal(after.thread.pinnedAt, null);
        assert.isUndefined(after.thread.pullRequests?.[0]?.watch);
        assert.equal(after.runtimeRequests[0]?.status, "resolved");
        assert.equal(after.runtimeRequests[0]?.decision, "cancel");
        assert.lengthOf(after.providerSessions, 0);
        const detaches = (yield* outbox.listByCommandId(settled.commandId)).filter(
          (effect) => effect.request.type === "provider-session.detach",
        );
        assert.lengthOf(detaches, 1);
        assert.deepEqual(detaches[0]?.request, {
          type: "provider-session.detach",
          providerSessionId: sessionId,
          detail: "Thread settled.",
        });
        yield* h.change(false, "reverse-side-effects");
        const active = yield* h.orchestrator.getThreadProjection(threadId);
        assert.equal(active.thread.pinnedAt, null);
        assert.isUndefined(active.thread.pullRequests?.[0]?.watch);
        assert.lengthOf(active.providerSessions, 0);
        assert.deepEqual(active.runtimeRequests, after.runtimeRequests);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "cancels queued automatic wakeups while retaining the UI's native-child predicate limitation",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        const projections = Context.get(h.services, ProjectionStore.ProjectionStoreV2);
        yield* h.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("fixture:root"),
          threadId,
          messageId: MessageId.make("fixture:root"),
          createdBy: "user",
          creationSource: "web",
          text: "root",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const root = (yield* h.orchestrator.getThreadProjection(threadId)).runs[0]!;
        for (const wake of ["notification", "completion"] as const) {
          yield* h.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`fixture:${wake}`),
            threadId,
            messageId: MessageId.make(`fixture:${wake}`),
            createdBy: "agent",
            creationSource: "server",
            text: wake,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "queue_after_active" },
            notification: {
              source: { kind: "monitor" },
              outcome: "updated",
              summary: "fixture wake",
            },
          });
        }
        const now = yield* DateTime.now;
        const queued = yield* h.orchestrator.getThreadProjection(threadId);
        const completion = queued.messages.find(
          (message) => message.id === MessageId.make("fixture:completion"),
        )!;
        const { notification: _notification, ...message } = completion;
        yield* projections.apply({
          id: EventId.make("fixture:completion-delivery"),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...message,
            delegatedCompletion: { parentRunId: root.id, generation: 1, taskIds: [] },
          },
        });
        for (const run of queued.runs) {
          yield* projections.apply({
            id: EventId.make(`fixture:restart:${run.id}`),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload:
              run.id === root.id
                ? {
                    ...run,
                    status: "cancelled",
                    completedAt: now,
                    delegatedCompletion: {
                      disposition: "open",
                      nextGeneration: 2,
                      delivery: { generation: 1, messageId: completion.id, taskIds: [] },
                    },
                  }
                : { ...run, queueHeld: true },
          });
        }
        // Native children are provider-owned records, outside the existing root-run predicate.
        yield* projections.apply({
          id: EventId.make("fixture:native-child"),
          type: "subagent.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: NodeId.make("fixture:native-child"),
            threadId,
            runId: root.id,
            parentNodeId: root.rootNodeId!,
            origin: "provider_native",
            createdBy: "agent",
            driver: adapter.driver,
            providerInstanceId: instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "background",
            title: null,
            model: null,
            status: "running",
            result: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          },
        });
        const children = (yield* h.orchestrator.getThreadProjection(threadId)).subagents;
        assert.lengthOf(children, 1);
        assert.equal((yield* h.change(true, "automatic")).settled, true);
        const after = yield* h.orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          after.runs.map((run) => [run.userMessageId, run.status]),
          [
            ["fixture:root", "cancelled"],
            ["fixture:notification", "cancelled"],
            ["fixture:completion", "cancelled"],
          ],
        );
        assert.deepEqual(after.subagents, children);
        // This proves existing UI parity, not safety of a provider's background work.
      }).pipe(Effect.scoped),
  );
});

it.live("exposes reversible settlement through the external HTTP MCP catalog with readback", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* ExternalMcpGrant.recordExternalMcpGrant({
      sessionId: principal.sessionId,
      policy: principal.policy,
      clientLabel: principal.clientLabel,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    }).pipe(Effect.provideService(SqlClient.SqlClient, h.sql));
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          ExternalMcpServer.routeLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeedContext(h.services),
                Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                  authenticateHttpRequest: (req) =>
                    req.headers.authorization === "DPoP fixture"
                      ? Effect.succeed({
                          sessionId: principal.sessionId,
                          subject: DEVICE_AUTHORIZATION_SUBJECT,
                          method: "dpop-access-token",
                          scopes: [],
                          proofKeyThumbprint: "fixture",
                        } as EnvironmentAuth.AuthenticatedSession)
                      : Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({})),
                }),
                HttpPlatform.layer.pipe(
                  Layer.provideMerge(NodeServices.layer),
                  Layer.provide(Etag.layerWeak),
                ),
              ),
            ),
          ),
          { disableLogger: true },
        ),
      ),
      (web) => Effect.promise(() => web.dispose()),
    );
    let id = 0;
    let session: string | null = null;
    const rpc = (method: string, params: Record<string, unknown>) =>
      Effect.gen(function* () {
        const encoded = yield* encodeJson({
          jsonrpc: "2.0",
          id: ++id,
          method,
          params,
        });
        const response = yield* Effect.promise(() =>
          web.handler(
            new Request("http://localhost/api/mcp/external", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: "DPoP fixture",
                ...(session === null
                  ? {}
                  : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
              },
              body: encoded,
            }),
          ),
        );
        session ??= response.headers.get("mcp-session-id");
        assert.equal(response.status, 200);
        const body: unknown = yield* Effect.promise(() => response.json());
        if (process.env.T3_SETTLEMENT_EVIDENCE === "1")
          yield* Effect.log(
            yield* encodeJson({
              request: { jsonrpc: "2.0", id, method, params },
              response: body,
            }),
          );
        return yield* decodeRpc(body);
      });
    yield* rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "settlement-proof", version: "1" },
    });
    const tools = (yield* decodeTools((yield* rpc("tools/list", {})).result)).tools;
    const tool = tools.find((t) => t.name === "t3_external_thread_settle");
    assert.ok(tool);
    const inputSchema = yield* decodeRequired(tool.inputSchema);
    assert.deepEqual(inputSchema.required.toSorted(), ["clientRequestId", "settled", "threadId"]);
    const call = (name: string, args: Record<string, unknown>) =>
      rpc("tools/call", { name, arguments: args }).pipe(
        Effect.flatMap((body) => decodeToolResult(body.result)),
      );
    const settlement = (result: McpSchema.CallToolResult) =>
      decodeSettlement(result.structuredContent);
    const settled = yield* call("t3_external_thread_settle", request(true, "http:settle"));
    assert.equal((yield* settlement(settled)).settled, true);
    const readThread = call("t3_external_thread_read", { threadId }).pipe(
      Effect.flatMap((result) =>
        decodeThreadRead(result.structuredContent).pipe(Effect.map((read) => read.thread)),
      ),
    );
    const read = yield* readThread;
    assert.equal(read.settledAt, (yield* settlement(settled)).settledAt);
    assert.equal(
      (yield* settlement(yield* call("t3_external_thread_settle", request(false, "http:unsettle"))))
        .settled,
      false,
    );
    assert.deepEqual(
      yield* call("t3_external_thread_settle", request(true, "http:settle")),
      settled,
    );
    assert.equal((yield* readThread).settled, false);
    const invalid = yield* rpc("tools/call", {
      name: "t3_external_thread_settle",
      arguments: {
        settled: true,
        clientRequestId: "missing-target",
      },
    });
    assert.ok(invalid.error);
    assert.equal(invalid.result, undefined);
    // The HTTP middleware reloads the grant, including on an MCP-session replay.
    yield* h.sql`DELETE FROM auth_external_mcp_grants WHERE session_id = ${principal.sessionId}`;
    yield* ExternalMcpGrant.recordExternalMcpGrant({
      sessionId: principal.sessionId,
      policy: { ...principal.policy, coordinate: false },
      clientLabel: principal.clientLabel,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    }).pipe(Effect.provideService(SqlClient.SqlClient, h.sql));
    const deniedReplay = yield* call("t3_external_thread_settle", request(true, "http:settle"));
    assert.equal(deniedReplay.isError, true);
    assert.ok(
      deniedReplay.content.some(
        (part) => part.type === "text" && part.text.startsWith("capability_denied:"),
      ),
    );
    assert.equal((yield* readThread).settled, false);
  }).pipe(Effect.scoped),
);
