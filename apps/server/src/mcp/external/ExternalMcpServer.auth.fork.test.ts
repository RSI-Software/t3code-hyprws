// `/api/mcp/external` against the real session store and DPoP verifier: only a
// live, granted session presenting a fresh proof from its own key gets in.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DEVICE_AUTHORIZATION_SUBJECT } from "../../auth/DeviceAuthorization.fork.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ExternalMcpGrant from "../../auth/ExternalMcpGrant.fork.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as ExternalMcpServer from "./ExternalMcpServer.fork.ts";

// A web `Request` carries no Host header, so the server derives `localhost`.
const URL = `http://localhost${ExternalMcpServer.EXTERNAL_MCP_PATH}`;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeKey = (issuedAtSeconds: number) => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  let counter = 0;
  const proof = (accessToken: string) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk });
    const payload = encode({
      htm: "POST",
      htu: URL,
      jti: `proof-${++counter}`,
      iat: issuedAtSeconds,
      ath: computeDpopAccessTokenHash(accessToken),
    });
    const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  return { proof, thumbprint: computeDpopJwkThumbprint(publicJwk) };
};

const dependencies = Layer.mergeAll(
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.identityLayer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-external-mcp-auth-test-" }),
    ),
  ),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
).pipe(
  Layer.provideMerge(
    HttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer), Layer.provide(Etag.layerWeak)),
  ),
);

const makeHarness = Effect.gen(function* () {
  const services = yield* Layer.build(dependencies);
  const sessions = Context.get(services, SessionStore.SessionStore);
  const sql = Context.get(services, SqlClient.SqlClient);
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
  /** Issues a device-grant session bound to a fresh key, with an MCP grant. */
  const enroll = (ttl = Duration.days(1)) =>
    Effect.gen(function* () {
      const key = makeKey(now);
      const issued = yield* sessions.issue({
        subject: DEVICE_AUTHORIZATION_SUBJECT,
        method: "dpop-access-token",
        scopes: [],
        ttl,
        proofKeyThumbprint: key.thumbprint,
      });
      yield* ExternalMcpGrant.recordExternalMcpGrant({
        sessionId: issued.sessionId,
        policy: {
          projectIds: "*",
          coordinate: false,
          maxRuntimeMode: "approval-required",
          maxInteractionMode: "plan",
        },
        clientLabel: "dot cloud",
        createdAt: "2026-10-05T00:00:00.000Z",
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      return { key, token: issued.token, sessionId: issued.sessionId };
    });
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        ExternalMcpServer.routeLayer.pipe(Layer.provide(Layer.succeedContext(services))),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );
  const initialize = (headers: Record<string, string>) =>
    Effect.promise(async () => {
      const response = await web.handler(
        new Request(URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
          },
          body: encodeJson({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "external-auth-test", version: "1.0.0" },
            },
          }),
        }),
      );
      await response.text();
      return { status: response.status, challenge: response.headers.get("www-authenticate") };
    });
  return { sessions, enroll, initialize };
});

const refused = { status: 401, challenge: expect.stringMatching(/^DPoP/) };

it.live("admits a live granted session only with a fresh proof from its own key", () =>
  Effect.gen(function* () {
    const { sessions, enroll, initialize } = yield* makeHarness;
    const client = yield* enroll();
    const auth = (token: string, proof: string) => ({
      authorization: `DPoP ${token}`,
      dpop: proof,
    });

    expect(yield* initialize(auth(client.token, client.key.proof(client.token)))).toEqual({
      status: 200,
      challenge: null,
    });
    // The same proof twice is a replay.
    const proof = client.key.proof(client.token);
    expect((yield* initialize(auth(client.token, proof))).status).toBe(200);
    expect(yield* initialize(auth(client.token, proof))).toEqual(refused);
    // A proof signed by another key, or none at all.
    const stranger = makeKey(Math.floor((yield* Clock.currentTimeMillis) / 1_000));
    expect(yield* initialize(auth(client.token, stranger.proof(client.token)))).toEqual(refused);
    expect(yield* initialize({ authorization: `DPoP ${client.token}` })).toEqual(refused);
    // A token the server never issued, or one altered in transit.
    const forged = `${client.token.slice(0, -4)}AAAA`;
    expect(yield* initialize(auth(forged, client.key.proof(forged)))).toEqual(refused);

    const expiring = yield* enroll(Duration.millis(20));
    yield* Effect.sleep("50 millis");
    expect(yield* initialize(auth(expiring.token, expiring.key.proof(expiring.token)))).toEqual(
      refused,
    );

    const other = yield* enroll();
    yield* sessions.revoke(client.sessionId);
    expect(yield* initialize(auth(client.token, client.key.proof(client.token)))).toEqual(refused);
    // Revoking one session leaves another untouched.
    expect((yield* initialize(auth(other.token, other.key.proof(other.token)))).status).toBe(200);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
