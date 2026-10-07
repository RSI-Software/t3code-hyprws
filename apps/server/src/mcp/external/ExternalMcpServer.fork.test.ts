import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";

import { DEVICE_AUTHORIZATION_SUBJECT } from "../../auth/DeviceAuthorization.fork.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ExternalMcpGrant from "../../auth/ExternalMcpGrant.fork.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ExternalMcpServer from "./ExternalMcpServer.fork.ts";

const policy: ExternalMcpGrant.ExternalMcpPolicy = {
  projectIds: [ProjectId.make("project:granted")],
  coordinate: true,
  maxRuntimeMode: "approval-required",
  maxInteractionMode: "plan",
};

const readerPolicy: ExternalMcpGrant.ExternalMcpPolicy = {
  projectIds: "*",
  coordinate: false,
  maxRuntimeMode: "approval-required",
  maxInteractionMode: "plan",
};

const deviceSession = (sessionId: string): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make(sessionId),
  subject: DEVICE_AUTHORIZATION_SUBJECT,
  method: "dpop-access-token",
  scopes: [],
  proofKeyThumbprint: "client-key",
});

/** Each access token names the session it authenticates; `revoked` no longer does. */
const sessionsByToken: Record<string, EnvironmentAuth.AuthenticatedSession> = {
  granted: deviceSession("session-granted"),
  ungranted: deviceSession("session-ungranted"),
  reader: deviceSession("session-reader"),
  browser: {
    sessionId: AuthSessionId.make("session-browser"),
    subject: "browser",
    method: "browser-session-cookie",
    scopes: [],
  },
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const PingToolkit = Toolkit.make(Tool.make("ping", { success: Schema.String }));

/** The upstream `/mcp` server beside it, so a leaked registration would show there. */
const providerMcp = McpServer.toolkit(PingToolkit).pipe(
  Layer.provide(PingToolkit.toLayer({ ping: () => Effect.succeed("pong") })),
  Layer.provideMerge(
    McpServer.layerHttp({
      name: "provider",
      version: "0",
      path: "/mcp",
      protocols: [McpProtocol.v2025_06_18],
    }),
  ),
);

const dependencies = Layer.mergeAll(
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: (request) => {
      const token = request.headers.authorization?.split(" ")[1] ?? "";
      const session = sessionsByToken[token];
      return session === undefined
        ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({}))
        : Effect.succeed(session);
    },
  }),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  ServerSettings.layerTest(),
  HttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer), Layer.provide(Etag.layerWeak)),
  SqlitePersistenceMemory,
);

const makeHarness = Effect.gen(function* () {
  const services = yield* Layer.build(dependencies);
  const sql = Context.get(services, SqlClient.SqlClient);
  yield* ExternalMcpGrant.recordExternalMcpGrant({
    sessionId: AuthSessionId.make("session-granted"),
    policy,
    clientLabel: "dot cloud",
    createdAt: "2026-10-05T00:00:00.000Z",
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  yield* ExternalMcpGrant.recordExternalMcpGrant({
    sessionId: AuthSessionId.make("session-reader"),
    policy: readerPolicy,
    clientLabel: "reader",
    createdAt: "2026-10-05T00:00:00.000Z",
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        Layer.mergeAll(ExternalMcpServer.routeLayer, providerMcp).pipe(
          Layer.provide(Layer.succeedContext(services)),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );
  let id = 0;
  const rpc = (
    path: string,
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string>,
  ) =>
    Effect.promise(async () => {
      const response = await web.handler(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
          },
          body: encodeJson({ jsonrpc: "2.0", id: ++id, method, params }),
        }),
      );
      const text = await response.text();
      return {
        status: response.status,
        sessionId: response.headers.get("mcp-session-id"),
        body: (text === "" ? null : decodeJson(text)) as Record<string, any> | null,
      };
    });
  /** Opens an MCP session and returns the headers every later request carries. */
  const connect = (path: string, headers: Record<string, string>) =>
    rpc(
      path,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "external-test", version: "1.0.0" },
      },
      headers,
    ).pipe(
      Effect.map((initialized) => {
        expect(initialized.status).toBe(200);
        return {
          ...headers,
          "mcp-session-id": initialized.sessionId!,
          "mcp-protocol-version": "2025-06-18",
        };
      }),
    );
  return { rpc, connect };
});

const external = ExternalMcpServer.EXTERNAL_MCP_PATH;
const listTools = { cursor: undefined };

it.live("admits only a device-grant session that carries an external MCP grant", () =>
  Effect.gen(function* () {
    const { rpc, connect } = yield* makeHarness;
    const status = (headers: Record<string, string>) =>
      rpc(external, "tools/list", listTools, headers).pipe(Effect.map((r) => r.status));

    expect(yield* status({})).toBe(401);
    // A bearer token, even one that names a granted session, is not proof-bound.
    expect(yield* status({ authorization: "Bearer granted" })).toBe(401);
    expect(yield* status({ authorization: "DPoP revoked" })).toBe(401);
    expect(yield* status({ authorization: "DPoP browser" })).toBe(401);
    expect(yield* status({ authorization: "DPoP ungranted" })).toBe(401);
    // A browser page never reaches it, credential or not.
    expect(yield* status({ authorization: "DPoP granted", origin: "https://example.com" })).toBe(
      403,
    );
    expect(yield* status({ authorization: "DPoP granted", "sec-fetch-site": "same-origin" })).toBe(
      403,
    );

    const session = yield* connect(external, { authorization: "DPoP granted" });
    // The MCP session id carries no authority: each request is authenticated anew.
    expect(yield* status({ ...session, authorization: "DPoP revoked" })).toBe(401);
    expect(yield* status({ ...session, authorization: "DPoP ungranted" })).toBe(401);

    const listed = yield* rpc(external, "tools/list", listTools, session);
    expect(listed.status).toBe(200);
    expect(listed.body?.result.tools.map((tool: { name: string }) => tool.name).toSorted()).toEqual(
      [
        "t3_external_project_list",
        "t3_external_request_list",
        "t3_external_request_respond",
        "t3_external_thread_create",
        "t3_external_thread_interrupt",
        "t3_external_thread_list",
        "t3_external_thread_read",
        "t3_external_thread_send",
        "t3_external_thread_settle",
        "t3_external_thread_wait",
        "t3_external_whoami",
      ],
    );

    const whoami = yield* rpc(
      external,
      "tools/call",
      { name: "t3_external_whoami", arguments: {} },
      session,
    );
    expect(whoami.body?.result.structuredContent).toEqual({
      sessionId: "session-granted",
      subject: DEVICE_AUTHORIZATION_SUBJECT,
      clientLabel: "dot cloud",
      expiresAt: null,
      policy,
    });
  }).pipe(Effect.scoped),
);

it.live("keeps its tools out of the provider-session catalog", () =>
  Effect.gen(function* () {
    const { rpc, connect } = yield* makeHarness;
    const listed = yield* rpc("/mcp", "tools/list", listTools, yield* connect("/mcp", {}));
    expect(listed.body?.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["ping"]);
  }).pipe(Effect.scoped),
);

it.live("answers each request as the principal that sent it, on a shared MCP session", () =>
  Effect.gen(function* () {
    const { rpc, connect } = yield* makeHarness;
    const session = yield* connect(external, { authorization: "DPoP granted" });
    const call = (authorization: string, name: string, args: Record<string, unknown>) =>
      rpc(external, "tools/call", { name, arguments: args }, { ...session, authorization });

    const reader = yield* call("DPoP reader", "t3_external_whoami", {});
    expect(reader.body?.result.structuredContent).toMatchObject({
      sessionId: "session-reader",
      clientLabel: "reader",
      policy: readerPolicy,
    });
    const granted = yield* call("DPoP granted", "t3_external_whoami", {});
    expect(granted.body?.result.structuredContent).toMatchObject({
      sessionId: "session-granted",
      policy,
    });

    // A refusal is an MCP tool error, led by its failure code.
    const create = { projectId: "project:granted", clientRequestId: "k" };
    const denied = yield* call("DPoP reader", "t3_external_thread_create", create);
    expect(denied.status).toBe(200);
    expect(denied.body?.result.isError).toBe(true);
    expect(denied.body?.result.content[0].text).toMatch(/^capability_denied: /);
    const outside = yield* call("DPoP granted", "t3_external_thread_create", {
      ...create,
      projectId: "project:other",
    });
    expect(outside.body?.result.isError).toBe(true);
    expect(outside.body?.result.content[0].text).toMatch(/^invalid_request: /);
  }).pipe(Effect.scoped),
);
