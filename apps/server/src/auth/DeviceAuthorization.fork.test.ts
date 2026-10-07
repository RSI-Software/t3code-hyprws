// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no KeyObject, generateKeyPairSync, or sign.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DeviceAuthorization from "./DeviceAuthorization.fork.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const storageLayer = Layer.mergeAll(SqlitePersistence.layerMemory, ServerSecretStore.layer).pipe(
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("device-auth-test")),
    }),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-device-auth-test-" })),
);

const storeLayer = DeviceAuthorization.layer.pipe(
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(storageLayer),
);

const client = { label: "dot cloud", deviceType: "bot" } as const;

it.layer(NodeServices.layer)("DeviceAuthorizationStore", (it) => {
  it.effect("issues the approved scopes and lifetime once, to the bound key only", () =>
    Effect.gen(function* () {
      const store = yield* DeviceAuthorization.DeviceAuthorizationStore;
      const sessions = yield* SessionStore.SessionStore;
      const started = Option.getOrThrow(
        yield* store.start({
          client,
          requestedScopes: ["orchestration:read", "orchestration:operate"],
          proofKeyThumbprint: "client-key",
        }),
      );
      expect(started.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);

      const pending = yield* store.listOpen();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        userCode: started.userCode,
        status: "pending",
        client,
        proofKeyThumbprint: "client-key",
      });
      expect(Object.values(pending[0]!)).not.toContain(started.deviceCode);

      let issuedAt = 0;
      const poll = () => ({
        deviceCode: started.deviceCode,
        proof: { thumbprint: "client-key", issuedAt: ++issuedAt },
      });
      expect((yield* store.poll(poll()))._tag).toBe("Pending");

      const approved = yield* store.approve({
        userCode: started.userCode.toLowerCase().replace("-", " "),
        ttl: Duration.days(7),
      });
      expect(Option.getOrThrow(approved).scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
      ]);
      expect(Option.isNone(yield* store.approve({ userCode: started.userCode }))).toBe(true);

      expect((yield* store.poll({ deviceCode: started.deviceCode }))._tag).toBe("Invalid");
      expect(
        (yield* store.poll({
          deviceCode: started.deviceCode,
          proof: { thumbprint: "other-key", issuedAt: 100 },
        }))._tag,
      ).toBe("Invalid");

      // A proof no later than the last accepted one is a replay.
      expect(
        (yield* store.poll({
          deviceCode: started.deviceCode,
          proof: { thumbprint: "client-key", issuedAt },
        }))._tag,
      ).toBe("ReplayedProof");

      const issued = yield* store.poll(poll());
      if (issued._tag !== "Issued") throw new Error(`expected Issued, got ${issued._tag}`);
      const verified = yield* sessions.verify(issued.session.token);
      expect(verified).toMatchObject({
        method: "dpop-access-token",
        subject: DeviceAuthorization.DEVICE_AUTHORIZATION_SUBJECT,
        scopes: ["orchestration:read", "orchestration:operate"],
        proofKeyThumbprint: "client-key",
        client,
      });
      expect(issued.session.expiresAt.epochMilliseconds - (yield* Clock.currentTimeMillis)).toBe(
        Duration.toMillis(Duration.days(7)),
      );

      expect((yield* store.poll(poll()))._tag).toBe("Invalid");
      expect(yield* store.listOpen()).toHaveLength(0);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("lets the owner narrow a request but never widen it", () =>
    Effect.gen(function* () {
      const store = yield* DeviceAuthorization.DeviceAuthorizationStore;
      const requested = Option.getOrThrow(
        yield* store.start({ client, requestedScopes: ["orchestration:read", "access:write"] }),
      );
      const widened = yield* store
        .approve({ userCode: requested.userCode, scopes: ["relay:write"] })
        .pipe(Effect.flip);
      expect(widened._tag).toBe("DeviceAuthorizationScopeError");
      const narrowed = yield* store.approve({
        userCode: requested.userCode,
        scopes: ["orchestration:read"],
      });
      expect(Option.getOrThrow(narrowed).scopes).toEqual(["orchestration:read"]);

      const unscoped = Option.getOrThrow(yield* store.start({ client }));
      const granted = yield* store.approve({
        userCode: unscoped.userCode,
        scopes: AuthAdministrativeScopes,
      });
      expect(Option.getOrThrow(granted).scopes).toEqual(AuthAdministrativeScopes);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("defaults to the standard client scopes when none are requested", () =>
    Effect.gen(function* () {
      const store = yield* DeviceAuthorization.DeviceAuthorizationStore;
      const started = Option.getOrThrow(yield* store.start({ client }));
      const approved = Option.getOrThrow(yield* store.approve({ userCode: started.userCode }));
      expect(approved.scopes).toEqual(AuthStandardClientScopes);
      const issued = yield* store.poll({ deviceCode: started.deviceCode });
      if (issued._tag !== "Issued") throw new Error(`expected Issued, got ${issued._tag}`);
      expect(issued.session.method).toBe("bearer-access-token");
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("tells a fast poller to slow down, and a denied or expired one to stop", () =>
    Effect.gen(function* () {
      const store = yield* DeviceAuthorization.DeviceAuthorizationStore;
      const first = Option.getOrThrow(yield* store.start({ client }));
      expect((yield* store.poll({ deviceCode: first.deviceCode }))._tag).toBe("Pending");
      expect((yield* store.poll({ deviceCode: first.deviceCode }))._tag).toBe("SlowDown");
      yield* TestClock.adjust(Duration.seconds(5));
      expect((yield* store.poll({ deviceCode: first.deviceCode }))._tag).toBe("Pending");

      expect(yield* store.deny(first.userCode)).toBe(true);
      expect((yield* store.poll({ deviceCode: first.deviceCode }))._tag).toBe("Denied");
      expect(Option.isNone(yield* store.approve({ userCode: first.userCode }))).toBe(true);

      const second = Option.getOrThrow(yield* store.start({ client }));
      yield* TestClock.adjust(Duration.minutes(10));
      expect(Option.isNone(yield* store.approve({ userCode: second.userCode }))).toBe(true);
      expect((yield* store.poll({ deviceCode: second.deviceCode }))._tag).toBe("Expired");
      expect((yield* store.poll({ deviceCode: "unknown" }))._tag).toBe("Invalid");
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("caps open requests so an unauthenticated caller cannot fill the table", () =>
    Effect.gen(function* () {
      const store = yield* DeviceAuthorization.DeviceAuthorizationStore;
      for (let index = 0; index < 20; index++) {
        expect(Option.isSome(yield* store.start({ client }))).toBe(true);
      }
      expect(Option.isNone(yield* store.start({ client }))).toBe(true);
      yield* TestClock.adjust(Duration.minutes(10));
      expect(Option.isSome(yield* store.start({ client }))).toBe(true);
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("holds the cap when starts race each other", () =>
    Effect.gen(function* () {
      const store = yield* DeviceAuthorization.DeviceAuthorizationStore;
      const started = yield* Effect.all(
        Array.from({ length: 40 }, () => store.start({ client })),
        { concurrency: "unbounded" },
      );
      expect(started.filter(Option.isSome)).toHaveLength(20);
      expect(yield* store.listOpen()).toHaveLength(20);
    }).pipe(
      Effect.provide(
        storeLayer.pipe(
          // Yielding inside every start lets the racing starts interleave there.
          Layer.provide(
            Layer.effect(
              Crypto.Crypto,
              Effect.map(Crypto.Crypto, (crypto) =>
                Crypto.Crypto.of({
                  ...crypto,
                  randomBytes: (size) => Effect.andThen(Effect.yieldNow, crypto.randomBytes(size)),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});

const makeKey = (issuedAtSeconds: number) => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  let counter = 0;
  const proof = (method: string, url: string, accessToken?: string) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk });
    const payload = encode({
      htm: method,
      htu: url,
      jti: `proof-${++counter}`,
      // Each proof is later than the last, as a polling client's would be.
      iat: issuedAtSeconds - 120 + counter,
      ...(accessToken ? { ath: computeDpopAccessTokenHash(accessToken) } : {}),
    });
    const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    return `${header}.${payload}.${signature}`;
  };
  return { proof, thumbprint: computeDpopJwkThumbprint(publicJwk) };
};

// A web `Request` carries no Host header, so the server derives `localhost`.
const ORIGIN = "http://localhost";
const form = (path: string, fields: Record<string, string>, headers?: Record<string, string>) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });

const makeHarness = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const services = yield* Layer.build(
    storeLayer.pipe(
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
    ),
  );
  const store = Context.get(services, DeviceAuthorization.DeviceAuthorizationStore);
  const sessions = Context.get(services, SessionStore.SessionStore);
  // The secret store stays reachable, so a route that wrote DPoP replay
  // markers again would show up in `markerCount`.
  const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
    Context.add(
      ServerSecretStore.ServerSecretStore,
      Context.get(services, ServerSecretStore.ServerSecretStore),
    ),
  );
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        DeviceAuthorization.routeLayer.pipe(Layer.provide(Layer.succeedContext(services))),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );
  const send = (request: Request) =>
    Effect.promise(async () => {
      const response = await web.handler(request, requestContext);
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        body: (await response.json()) as Record<string, unknown>,
      };
    });
  const { secretsDir } = Context.get(services, ServerConfig.ServerConfig);
  const sql = Context.get(services, SqlClient.SqlClient);
  const fileSystem = Context.get(services, FileSystem.FileSystem);
  const markerCount = fileSystem.exists(secretsDir).pipe(
    Effect.flatMap((exists) =>
      exists ? fileSystem.readDirectory(secretsDir) : Effect.succeed([]),
    ),
    Effect.map((names) => names.filter((name) => name.startsWith("dpop-proof-")).length),
  );
  const rowCount = sql<{ readonly count: number }>`
    SELECT COUNT(*) AS "count" FROM auth_device_authorizations
  `.pipe(Effect.map(([row]) => row?.count ?? 0));
  return { send, store, sessions, markerCount, rowCount };
});

it.live("delivers a DPoP-bound token over the HTTP routes after owner approval", () =>
  Effect.gen(function* () {
    const { send, store, sessions } = yield* makeHarness;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const key = makeKey(now);
    const authorizeUrl = `${ORIGIN}${DeviceAuthorization.DEVICE_AUTHORIZATION_PATH}`;
    const tokenUrl = `${ORIGIN}${DeviceAuthorization.DEVICE_TOKEN_PATH}`;

    expect(
      (yield* send(form(DeviceAuthorization.DEVICE_AUTHORIZATION_PATH, { client_os: "linux" })))
        .body,
    ).toEqual({ error: "invalid_request" });
    expect(
      (yield* send(
        form(DeviceAuthorization.DEVICE_AUTHORIZATION_PATH, {
          client_label: "dot cloud",
          scope: "orchestration:read root",
        }),
      )).body,
    ).toEqual({ error: "invalid_scope" });

    // A web page could reach these routes under CORS, so browsers are refused.
    expect(
      (yield* send(
        form(
          DeviceAuthorization.DEVICE_AUTHORIZATION_PATH,
          { client_label: "dot cloud" },
          { origin: "https://example.com" },
        ),
      )).status,
    ).toBe(403);
    expect(
      (yield* send(
        form(
          DeviceAuthorization.DEVICE_AUTHORIZATION_PATH,
          { client_label: "dot cloud" },
          { "sec-fetch-site": "cross-site" },
        ),
      )).status,
    ).toBe(403);

    // Node's `fetch` sends `Sec-Fetch-Mode: cors` without `Origin`.
    const started = yield* send(
      form(
        DeviceAuthorization.DEVICE_AUTHORIZATION_PATH,
        {
          client_label: "dot cloud",
          client_os: "linux",
          scope: AuthAdministrativeScopes.join(" "),
        },
        { dpop: key.proof("POST", authorizeUrl), "sec-fetch-mode": "cors" },
      ),
    );
    expect(started.status).toBe(200);
    expect(started.cacheControl).toBe("no-store");
    expect(started.body).toMatchObject({ expires_in: 600, interval: 5 });
    const deviceCode = started.body.device_code as string;
    const userCode = started.body.user_code as string;

    const [request] = yield* store.listOpen();
    expect(request).toMatchObject({
      userCode,
      proofKeyThumbprint: key.thumbprint,
      client: { label: "dot cloud", deviceType: "bot", os: "linux" },
    });

    const poll = (headers?: Record<string, string>) =>
      send(
        form(
          DeviceAuthorization.DEVICE_TOKEN_PATH,
          { grant_type: DeviceAuthorization.DEVICE_CODE_GRANT_TYPE, device_code: deviceCode },
          headers,
        ),
      );
    const pendingProof = key.proof("POST", tokenUrl);
    expect((yield* poll({ dpop: pendingProof })).body).toEqual({
      error: "authorization_pending",
    });
    // The same proof again is a replay.
    expect((yield* poll({ dpop: pendingProof })).body).toEqual({ error: "invalid_dpop_proof" });

    yield* store.approve({ userCode, ttl: Duration.days(30) });
    // Without the bound key, or with another key, the approval is unreachable.
    expect((yield* poll()).body).toEqual({ error: "invalid_grant" });
    expect((yield* poll({ dpop: makeKey(now).proof("POST", tokenUrl) })).body).toEqual({
      error: "invalid_grant",
    });

    const issued = yield* poll({ dpop: key.proof("POST", tokenUrl) });
    expect(issued.status).toBe(200);
    expect(issued.cacheControl).toBe("no-store");
    expect(issued.body).toMatchObject({
      token_type: "DPoP",
      scope: AuthAdministrativeScopes.join(" "),
    });
    expect(issued.body.expires_in).toBeGreaterThan(Duration.toSeconds(Duration.days(30)) - 5);
    const verified = yield* sessions.verify(issued.body.access_token as string);
    expect(verified).toMatchObject({
      method: "dpop-access-token",
      proofKeyThumbprint: key.thumbprint,
    });

    expect((yield* poll({ dpop: key.proof("POST", tokenUrl) })).body).toEqual({
      error: "invalid_grant",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("delivers an external MCP grant's scopeless token without a scope field", () =>
  Effect.gen(function* () {
    const { send, store, sessions } = yield* makeHarness;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const key = makeKey(now);
    const tokenUrl = `${ORIGIN}${DeviceAuthorization.DEVICE_TOKEN_PATH}`;
    const started = yield* send(
      form(
        DeviceAuthorization.DEVICE_AUTHORIZATION_PATH,
        { client_label: "dot cloud" },
        { dpop: key.proof("POST", `${ORIGIN}${DeviceAuthorization.DEVICE_AUTHORIZATION_PATH}`) },
      ),
    );
    yield* store.approve({
      userCode: started.body.user_code as string,
      mcpPolicy: {
        projectIds: "*",
        coordinate: false,
        maxRuntimeMode: "approval-required",
        maxInteractionMode: "plan",
      },
    });

    const issued = yield* send(
      form(
        DeviceAuthorization.DEVICE_TOKEN_PATH,
        {
          grant_type: DeviceAuthorization.DEVICE_CODE_GRANT_TYPE,
          device_code: started.body.device_code as string,
        },
        { dpop: key.proof("POST", tokenUrl) },
      ),
    );
    expect(issued.status).toBe(200);
    expect(issued.body.token_type).toBe("DPoP");
    expect(issued.body).not.toHaveProperty("scope");
    expect((yield* sessions.verify(issued.body.access_token as string)).scopes).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("keeps unauthenticated callers from growing state past the request cap", () =>
  Effect.gen(function* () {
    const { send, markerCount, rowCount } = yield* makeHarness;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const authorizeUrl = `${ORIGIN}${DeviceAuthorization.DEVICE_AUTHORIZATION_PATH}`;
    const tokenUrl = `${ORIGIN}${DeviceAuthorization.DEVICE_TOKEN_PATH}`;

    // Every request carries a valid proof from a fresh key, the cheapest way
    // to defeat a per-key replay record.
    const statuses: Array<number> = [];
    for (let index = 0; index < 40; index++) {
      const started = yield* send(
        form(
          DeviceAuthorization.DEVICE_AUTHORIZATION_PATH,
          { client_label: `flood ${index}` },
          { dpop: makeKey(now).proof("POST", authorizeUrl) },
        ),
      );
      statuses.push(started.status);
      const polled = yield* send(
        form(
          DeviceAuthorization.DEVICE_TOKEN_PATH,
          {
            grant_type: DeviceAuthorization.DEVICE_CODE_GRANT_TYPE,
            device_code: `unknown-${index}`,
          },
          { dpop: makeKey(now).proof("POST", tokenUrl) },
        ),
      );
      expect(polled.body).toEqual({ error: "invalid_grant" });
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(20);
    expect(statuses.filter((status) => status === 429)).toHaveLength(20);
    expect(yield* rowCount).toBe(20);
    expect(yield* markerCount).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses terminal control characters in client-supplied labels", () =>
  Effect.gen(function* () {
    const { send, rowCount } = yield* makeHarness;
    for (const fields of [
      { client_label: "dot cloud\u001b[2J" },
      { client_label: "dot cloud\u009b31m" },
      { client_label: "dot \u202ecloud" },
      { client_label: "dot cloud\nApproved" },
      { client_label: "dot cloud", client_os: "linux\u0007" },
    ]) {
      expect(
        (yield* send(form(DeviceAuthorization.DEVICE_AUTHORIZATION_PATH, fields))).body,
      ).toEqual({ error: "invalid_request" });
    }
    expect(yield* rowCount).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("escapes control, C1, and bidi characters for the owner's terminal", () => {
  expect(DeviceAuthorization.escapeForTerminal("a\u001b[2Jb\u009bc\u202ed\u007f")).toBe(
    '"a\\u001b[2Jb\\u009bc\\u202ed\\u007f"',
  );
  expect(DeviceAuthorization.escapeForTerminal({ userAgent: "x\u202e" })).toBe(
    '{\n  "userAgent": "x\\u202e"\n}',
  );
});
