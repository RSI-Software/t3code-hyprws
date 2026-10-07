// Fork-owned MCP endpoint for owner-approved clients outside T3
// (RSI-Software/t3code-hyprws device-auth domain). It is a second MCP server
// beside upstream's `/mcp`, with its own tool catalog, so provider-session
// credentials and behavior at `/mcp` stay untouched.
//
// Retire it when upstream ships an external MCP client audience with headless
// sign-in: the fork then provides that audience's authenticator from device
// grants and keeps only the project and interaction-mode policy.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import packageJson from "../../../package.json" with { type: "json" };
import { DEVICE_AUTHORIZATION_SUBJECT } from "../../auth/DeviceAuthorization.fork.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ExternalMcpGrant from "../../auth/ExternalMcpGrant.fork.ts";
import { normalizeMcpHttpResponse } from "../McpHttpServer.ts";
import { ExternalMcpToolkitHandlersLiveFork } from "../toolkits/external/handlers.fork.ts";
import { ExternalMcpToolkitFork } from "../toolkits/external/tools.fork.ts";
import * as ExternalMcpService from "./ExternalMcpService.fork.ts";

export const EXTERNAL_MCP_PATH = "/api/mcp/external";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_external_mcp_credential",
    message: "A live DPoP access token from an owner-approved MCP device grant is required.",
  },
  {
    status: 401,
    headers: { "cache-control": "no-store", "www-authenticate": "DPoP" },
  },
);

const browserRefused = HttpServerResponse.jsonUnsafe(
  { error: "browser_request_refused", message: "External MCP is not reachable from a browser." },
  { status: 403, headers: { "cache-control": "no-store" } },
);

type RejectReason =
  | "not_dpop"
  | "credential_rejected"
  | "not_device_grant"
  | "no_mcp_grant"
  | "auth_unavailable";

type PrincipalHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  ExternalMcpService.ExternalMcpPrincipalFork
>;

/**
 * Admits only a proof-bound device-grant session that carries an MCP grant.
 * Revocation and expiry end the session, so they surface here as a 401 on the
 * next request with no extra bookkeeping.
 */
const makeAuthMiddleware = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const grants = yield* ExternalMcpGrant.ExternalMcpGrantStore;

  const resolvePrincipal = Effect.fn("ExternalMcpServer.resolvePrincipal")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    if (request.headers.authorization?.startsWith("DPoP ") !== true) {
      return yield* Effect.fail<RejectReason>("not_dpop");
    }
    const session = yield* auth
      .authenticateHttpRequest(request)
      .pipe(
        Effect.mapError((error): RejectReason =>
          EnvironmentAuth.isServerAuthCredentialError(error)
            ? "credential_rejected"
            : "auth_unavailable",
        ),
      );
    if (
      session.method !== "dpop-access-token" ||
      session.proofKeyThumbprint === undefined ||
      session.subject !== DEVICE_AUTHORIZATION_SUBJECT
    ) {
      return yield* Effect.fail<RejectReason>("not_device_grant");
    }
    const grant = yield* grants
      .getBySession(session.sessionId)
      .pipe(Effect.mapError((): RejectReason => "auth_unavailable"));
    if (Option.isNone(grant)) return yield* Effect.fail<RejectReason>("no_mcp_grant");
    return ExternalMcpService.ExternalMcpPrincipalFork.of({
      sessionId: session.sessionId,
      subject: session.subject,
      clientLabel: grant.value.clientLabel,
      expiresAt: session.expiresAt ?? null,
      policy: grant.value.policy,
    });
  });

  return Effect.fn("ExternalMcpServer.authenticateRequest")(function* (
    httpEffect: PrincipalHttpEffect,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // A browser page must never drive this endpoint with an ambient credential.
    if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined) {
      return browserRefused;
    }
    const principal = yield* resolvePrincipal(request).pipe(
      Effect.tapError((reason) => Effect.logWarning("rejected external MCP request", { reason })),
      Effect.option,
    );
    if (Option.isNone(principal)) return unauthorized;
    return yield* httpEffect.pipe(
      Effect.provideService(ExternalMcpService.ExternalMcpPrincipalFork, principal.value),
      Effect.map(normalizeMcpHttpResponse),
    );
  });
}).pipe(Effect.withSpan("ExternalMcpServer.makeAuthMiddleware"));

const AuthMiddlewareLive = HttpRouter.middleware<{
  provides: ExternalMcpService.ExternalMcpPrincipalFork;
}>()(makeAuthMiddleware).layer.pipe(Layer.provide(ExternalMcpGrant.layer));

/**
 * Mounted beside the device grant routes through the marked
 * `device-auth/server-external-mcp` hook. `McpServer.toolkit` and
 * `McpServer.layerHttp` both build the memoized `McpServer.layer`, so the
 * whole server is built in one `Layer.fresh` scope: inside it they share a new
 * server, and these tools never join the `/mcp` catalog. Services the tools
 * read still come from the surrounding server.
 */
export const routeLayer = Layer.fresh(
  McpServer.toolkit(ExternalMcpToolkitFork).pipe(
    Layer.provide(ExternalMcpToolkitHandlersLiveFork),
    Layer.provide(ExternalMcpService.layer),
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "T3 Code external",
        version: packageJson.version,
        path: EXTERNAL_MCP_PATH,
        protocols: [McpProtocol.v2025_06_18],
      }),
    ),
    Layer.provide(AuthMiddlewareLive),
  ),
);
