import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  EventId,
  NodeId,
  type OrchestrationProjectShell,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2UserInputQuestion,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  MessageId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import * as SqlClient from "effect/sql/SqlClient";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import { DEVICE_AUTHORIZATION_SUBJECT } from "../../auth/DeviceAuthorization.fork.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ExternalMcpGrant from "../../auth/ExternalMcpGrant.fork.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  ExternalMcpRequestListResult,
  ExternalMcpRequestRespondResult,
} from "./ExternalMcpRequests.fork.ts";
import * as ExternalMcpServer from "./ExternalMcpServer.fork.ts";
import * as ExternalMcpService from "./ExternalMcpService.fork.ts";

const projectId = ProjectId.make("project:requests");
const otherProjectId = ProjectId.make("project:outside-grant");
const threadId = ThreadId.make("thread:requests");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test" };
const sessionId = ProviderSessionId.make("fixture:session");
const principal: ExternalMcpService.ExternalMcpPrincipal = {
  sessionId: AuthSessionId.make("requests-client"),
  subject: DEVICE_AUTHORIZATION_SUBJECT,
  clientLabel: "requests fixture",
  expiresAt: null,
  policy: {
    projectIds: [projectId],
    coordinate: true,
    maxRuntimeMode: "auto-accept-edits",
    maxInteractionMode: "default",
  },
};
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Answering must not start a provider process"),
} satisfies ProviderAdapterV2Shape;

/** A three-step form: options with values, a multi-select, and optional free text. */
const form: ReadonlyArray<OrchestrationV2UserInputQuestion> = [
  {
    id: "scope",
    header: "Scope",
    question: "Which scope should the render cover?",
    options: [
      { label: "Hero only", description: "Just the hero shot", value: "hero" },
      { label: "Full set", description: "Every shot" },
    ],
    allowCustomAnswer: false,
  },
  {
    id: "formats",
    header: "Formats",
    question: "Which formats?",
    options: [
      { label: "PNG", description: "Lossless" },
      { label: "WebP", description: "Small" },
      { label: "AVIF", description: "Smaller" },
    ],
    multiSelect: true,
  },
  {
    id: "notes",
    header: "Notes",
    question: "Anything else?",
    options: [],
    required: false,
  },
];

const decodeList = Schema.decodeUnknownEffect(ExternalMcpRequestListResult);
const decodeAck = Schema.decodeUnknownEffect(ExternalMcpRequestRespondResult);
const decodeToolResult = Schema.decodeUnknownEffect(McpSchema.CallToolResult);
const decodeToolList = Schema.decodeUnknownEffect(McpSchema.ListToolsResult);
const decodeRequired = Schema.decodeUnknownEffect(
  Schema.Struct({ required: Schema.Array(Schema.String) }),
);

const setup = (policy: Partial<ExternalMcpService.ExternalMcpPrincipal["policy"]> = {}) =>
  Effect.gen(function* () {
    const database = SqlitePersistence.layerMemory;
    const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
    const orchestratorLayer = ProviderReplayHarness.layerWithRegistry(
      { name: "external-requests" },
      registry,
      { databaseLayer: database, runEffectWorker: false },
    );
    const management = ThreadManagementService.layer.pipe(Layer.provide(orchestratorLayer));
    const shellOf = (id: ProjectId) =>
      ({ id, title: `fixture ${id}`, workspaceRoot: process.cwd() }) as OrchestrationProjectShell;
    const services = yield* Layer.build(
      Layer.mergeAll(
        orchestratorLayer,
        database,
        ProjectionStore.layer.pipe(Layer.provide(database)),
        ExternalMcpService.layer.pipe(
          Layer.provideMerge(management),
          Layer.provideMerge(
            Layer.mergeAll(
              registry,
              Layer.mock(ProjectService.ProjectService)({
                getShell: (id) => Effect.succeedSome(shellOf(id)),
                listShells: () => Effect.succeed([shellOf(projectId)]),
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({}),
              ServerSettings.layerTest(),
              database,
              Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("external-mcp-requests")),
              }),
            ),
          ),
        ),
      ).pipe(Layer.provide(NodeServices.layer)),
    );
    const service = Context.get(services, ExternalMcpService.ExternalMcpServiceFork);
    const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
    const projections = Context.get(services, ProjectionStore.ProjectionStoreV2);
    const sql = Context.get(services, SqlClient.SqlClient);
    const createThread = (id: ThreadId, project: ProjectId) =>
      orchestrator
        .dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`fixture:create:${id}`),
          threadId: id,
          projectId: project,
          title: id,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        })
        .pipe(Effect.orDie);
    yield* createThread(threadId, projectId);
    const now = yield* DateTime.now;
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
    // The run that asks, already settled so a message answer starts its own turn.
    // A native subagent's questions carry no run.
    const runId = RunId.make("fixture:run");
    yield* projections.apply({
      id: EventId.make("fixture:run"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("fixture:message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    let ordinal = 0;
    let requestOrdinal = 0;
    // A provider records a request's item on the request's node.
    const itemBase = (target: ThreadId, requestId: string, runless?: boolean) => ({
      id: TurnItemId.make(`fixture:item:${++ordinal}`),
      threadId: target,
      runId: target === threadId && !runless ? runId : null,
      nodeId: NodeId.make(`fixture:node:${requestId}`),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "pending" as const,
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    });
    const seedRequest = (input: {
      readonly id: string;
      readonly kind: OrchestrationV2RuntimeRequest["kind"];
      readonly thread?: ThreadId;
      readonly byMessage?: boolean;
    }) =>
      projections.apply({
        id: EventId.make(`fixture:request:${input.id}`),
        type: "runtime-request.updated",
        threadId: input.thread ?? threadId,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make(input.id),
          nodeId: NodeId.make(`fixture:node:${input.id}`),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: input.kind,
          status: "pending",
          responseCapability: input.byMessage
            ? { type: "message" }
            : { type: "live", providerSessionId: sessionId },
          createdAt: DateTime.add(now, { milliseconds: ++requestOrdinal }),
          resolvedAt: null,
        },
      });
    const seedQuestion = (input: {
      readonly id: string;
      readonly thread?: ThreadId;
      readonly byMessage?: boolean;
      readonly runless?: boolean;
    }) =>
      Effect.gen(function* () {
        yield* seedRequest({ ...input, kind: "user_input" });
        yield* projections.apply({
          id: EventId.make(`fixture:question:${input.id}`),
          type: "turn-item.updated",
          threadId: input.thread ?? threadId,
          occurredAt: now,
          payload: {
            ...itemBase(input.thread ?? threadId, input.id, input.runless),
            type: "user_input_request",
            requestId: RuntimeRequestId.make(input.id),
            questions: form,
            ...(input.byMessage ? { responseMode: "message" as const } : {}),
          },
        });
      });
    const seedApproval = (id: string) =>
      Effect.gen(function* () {
        yield* seedRequest({ id, kind: "command" });
        yield* projections.apply({
          id: EventId.make(`fixture:approval:${id}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...itemBase(threadId, id),
            type: "approval_request",
            requestId: RuntimeRequestId.make(id),
            requestKind: "command",
            prompt: "rm -rf dist && vp run build",
            options: [
              { decision: "accept", label: "Run once" },
              { decision: "acceptForSession", label: "Allow for session" },
              { decision: "decline", label: "Decline" },
            ],
          },
        });
      });
    const caller = { ...principal, policy: { ...principal.policy, ...policy } };
    const respond = (
      requestId: string,
      answers: Record<string, unknown>,
      target: ThreadId = threadId,
    ) =>
      service.respondToRequest(caller, {
        threadId: target,
        requestId: RuntimeRequestId.make(requestId),
        answers,
      });
    const requestState = (id: string, target: ThreadId = threadId) =>
      orchestrator
        .getThreadProjection(target)
        .pipe(
          Effect.map((projection) =>
            projection.runtimeRequests.find((request) => request.id === id),
          ),
        );
    return {
      service,
      services,
      orchestrator,
      sql,
      createThread,
      seedRequest,
      seedQuestion,
      seedApproval,
      caller,
      respond,
      requestState,
      list: (target: ThreadId = threadId) => service.listRequests(caller, { threadId: target }),
    };
  });

describe("external MCP pending requests on the real orchestrator", () => {
  it.effect("lists every step of a question and an approval's options, oldest first", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.seedQuestion({ id: "form" });
      yield* h.seedApproval("approval");
      // Neither reaches a person: the composer hides both.
      yield* h.seedRequest({ id: "auth", kind: "auth_refresh" });
      yield* h.seedRequest({ id: "itemless", kind: "user_input" });
      const listed = yield* h.list();
      assert.deepEqual(
        listed.requests.map((request) => [request.type, request.requestId]),
        [
          ["question", "form"],
          ["approval", "approval"],
        ],
      );
      const question = listed.requests[0]!;
      assert.deepEqual(question.type === "question" && question.questions, form);
      const approval = listed.requests[1]!;
      assert.equal(approval.type, "approval");
      if (approval.type !== "approval") return;
      assert.equal(approval.requestKind, "command");
      assert.equal(approval.detail, "rm -rf dist && vp run build");
      assert.deepEqual(
        approval.options.map((option) => option.decision),
        ["accept", "acceptForSession", "decline"],
      );
      // Reading needs no coordination.
      const reader = yield* setup({ coordinate: false });
      yield* reader.seedQuestion({ id: "form" });
      assert.lengthOf((yield* reader.list()).requests, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("answers a live question once and refuses a second answer", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.seedQuestion({ id: "form" });
      const answers = { scope: "hero", formats: ["PNG", "AVIF"] };
      yield* h.respond("form", answers);
      const resolved = yield* h.requestState("form");
      assert.equal(resolved?.status, "resolved");
      assert.deepEqual(resolved?.answers, answers);
      const second = yield* h.respond("form", answers).pipe(Effect.flip);
      assert.equal(second.code, "invalid_request");
      assert.match(second.message, /is resolved/);
      assert.lengthOf((yield* h.list()).requests, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses approvals, other threads' requests, and threads outside the grant", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.seedApproval("approval");
      const approval = yield* h.respond("approval", { scope: "hero" }).pipe(Effect.flip);
      assert.equal(approval.code, "capability_denied");
      assert.match(approval.message, /only the environment owner decides approvals/);
      assert.equal((yield* h.requestState("approval"))?.status, "pending");

      const sibling = ThreadId.make("thread:sibling");
      yield* h.createThread(sibling, projectId);
      yield* h.seedQuestion({ id: "sibling-form", thread: sibling });
      const wrongThread = yield* h.respond("sibling-form", { scope: "hero" }).pipe(Effect.flip);
      assert.equal(wrongThread.code, "invalid_request");
      assert.match(wrongThread.message, /is not on thread thread:requests/);
      assert.equal((yield* h.requestState("sibling-form", sibling))?.status, "pending");

      // A native subagent's question has no run to hold to the grant's ceilings.
      yield* h.seedQuestion({ id: "subagent-form", runless: true });
      const runless = yield* h.respond("subagent-form", { scope: "hero" }).pipe(Effect.flip);
      assert.equal(runless.code, "runtime_mode_escalation_denied");
      assert.equal((yield* h.requestState("subagent-form"))?.status, "pending");

      // A thread outside the grant reads as missing, for reads and answers alike.
      const outside = ThreadId.make("thread:outside");
      yield* h.createThread(outside, otherProjectId);
      yield* h.seedQuestion({ id: "outside-form", thread: outside });
      assert.equal((yield* h.list(outside).pipe(Effect.flip)).code, "thread_not_found");
      assert.equal(
        (yield* h.respond("outside-form", { scope: "hero" }, outside).pipe(Effect.flip)).code,
        "thread_not_found",
      );
      assert.equal((yield* h.requestState("outside-form", outside))?.status, "pending");
    }).pipe(Effect.scoped),
  );

  it.effect("answers a message question in the thread unless the modes changed after vetting", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.seedQuestion({ id: "async", byMessage: true });
      // A message answer is one string per question, as the composer sends it.
      yield* h.respond("async", { scope: "hero", formats: "PNG" });
      const thread = yield* h.orchestrator.getThreadProjection(threadId);
      assert.isDefined(thread.messages.find((message) => message.id === "async-answer:async"));

      // The answer carries the modes the grant vetted; the owner raising them before
      // commit refuses the message instead of steering a turn above the ceiling.
      yield* h.seedQuestion({ id: "raced", byMessage: true });
      yield* h.orchestrator
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("fixture:owner-raises-mode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.orDie);
      const refused = yield* h.orchestrator
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("fixture:stale-answer"),
          threadId,
          requestId: RuntimeRequestId.make("raced"),
          answers: { scope: "hero", formats: "PNG" },
          expectedModes: { runtimeMode: "approval-required", interactionMode: "default" },
        })
        .pipe(Effect.flip);
      assert.match(String(refused.cause), /modes changed/);
      assert.equal((yield* h.requestState("raced"))?.status, "pending");
    }).pipe(Effect.scoped),
  );

  it.effect("needs a coordinating grant to answer", () =>
    Effect.gen(function* () {
      const h = yield* setup({ coordinate: false });
      yield* h.seedQuestion({ id: "form" });
      const refused = yield* h.respond("form", { scope: "hero" }).pipe(Effect.flip);
      assert.equal(refused.code, "capability_denied");
      assert.equal((yield* h.requestState("form"))?.status, "pending");
    }).pipe(Effect.scoped),
  );
});

it.live("lists and answers pending requests through the external HTTP MCP catalog", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.seedQuestion({ id: "form" });
    yield* h.seedApproval("approval");
    const grant = (policy: ExternalMcpService.ExternalMcpPrincipal["policy"]) =>
      Effect.gen(function* () {
        yield* h.sql`DELETE FROM auth_external_mcp_grants WHERE session_id = ${principal.sessionId}`;
        yield* ExternalMcpGrant.recordExternalMcpGrant({
          sessionId: principal.sessionId,
          policy,
          clientLabel: principal.clientLabel,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        }).pipe(Effect.provideService(SqlClient.SqlClient, h.sql));
      });
    yield* grant(principal.policy);
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
    const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
    const decodeRpc = Schema.decodeUnknownEffect(
      Schema.Struct({
        result: Schema.optional(Schema.Unknown),
        error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
      }),
    );
    let id = 0;
    let session: string | null = null;
    const rpc = (method: string, params: Record<string, unknown>) =>
      Effect.gen(function* () {
        const encoded = yield* encodeJson({ jsonrpc: "2.0", id: ++id, method, params });
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
        // T3_REQUEST_EVIDENCE=1 prints the JSON-RPC transcript for PR evidence.
        if (process.env.T3_REQUEST_EVIDENCE === "1") {
          const line = yield* encodeJson({
            request: { jsonrpc: "2.0", id, method, params },
            response: body,
          });
          yield* Effect.sync(() => process.stdout.write(`${line}\n`));
        }
        return yield* decodeRpc(body);
      });
    const call = (name: string, args: Record<string, unknown>) =>
      rpc("tools/call", { name, arguments: args }).pipe(
        Effect.flatMap((body) => decodeToolResult(body.result)),
      );
    const errorText = (result: McpSchema.CallToolResult) =>
      result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    yield* rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "requests-proof", version: "1" },
    });
    const tools = (yield* decodeToolList((yield* rpc("tools/list", {})).result)).tools;
    const required = (name: string) =>
      decodeRequired(tools.find((tool) => tool.name === name)?.inputSchema).pipe(
        Effect.map((schema) => schema.required.toSorted()),
      );
    assert.deepEqual(yield* required("t3_external_request_list"), ["threadId"]);
    assert.deepEqual(yield* required("t3_external_request_respond"), [
      "answers",
      "requestId",
      "threadId",
    ]);

    const listed = yield* decodeList(
      (yield* call("t3_external_request_list", { threadId })).structuredContent,
    );
    assert.deepEqual(
      listed.requests.map((request) => request.type),
      ["question", "approval"],
    );
    const approve = yield* call("t3_external_request_respond", {
      threadId,
      requestId: "approval",
      answers: { scope: "hero" },
    });
    assert.equal(approve.isError, true);
    assert.match(errorText(approve), /^capability_denied:/);
    const respond = {
      threadId,
      requestId: "form",
      answers: { scope: "hero", formats: ["PNG", "WebP"] },
    };
    const answered = yield* call("t3_external_request_respond", respond);
    assert.equal(answered.isError, false);
    yield* decodeAck(answered.structuredContent);
    const stale = yield* call("t3_external_request_respond", respond);
    assert.match(errorText(stale), /^invalid_request: Request form is resolved\./);
    assert.deepEqual(
      (yield* decodeList(
        (yield* call("t3_external_request_list", { threadId })).structuredContent,
      )).requests.map((request) => request.requestId),
      ["approval"],
    );

    // The HTTP middleware reloads the grant on every call.
    yield* grant({ ...principal.policy, coordinate: false });
    const denied = yield* call("t3_external_request_respond", respond);
    assert.match(errorText(denied), /^capability_denied:/);
    assert.equal((yield* call("t3_external_request_list", { threadId })).isError, false);
    yield* grant({ ...principal.policy, projectIds: [] });
    assert.match(
      errorText(yield* call("t3_external_request_list", { threadId })),
      /^thread_not_found:/,
    );
  }).pipe(Effect.scoped),
);
