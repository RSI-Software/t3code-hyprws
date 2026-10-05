import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  AuthClientMetadata,
  AuthClientMetadataDeviceType,
  AuthEnvironmentScopes,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import { encodeOAuthScope, parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as UrlParams from "effect/unstable/http/UrlParams";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ExternalMcpGrant from "./ExternalMcpGrant.fork.ts";
import * as SessionStore from "./SessionStore.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

/**
 * Owner-approved device authorization for native clients, shaped like RFC 8628.
 *
 * A client starts at `POST /oauth/device_authorization` and receives a secret
 * device code plus a short user code. The environment owner reads the pending
 * request with `t3 auth device list` and approves it by user code with
 * `t3 auth device approve`. The client then polls `POST /oauth/device_token`
 * with its device code and receives the access token directly, so the
 * credential never passes through the owner or any other channel.
 *
 * A DPoP proof at the start binds the request, and the issued session, to the
 * client's key; polling must then prove the same key.
 *
 * Both routes are unauthenticated, so neither writes per-request state outside
 * the capped table: proofs are checked without the shared replay markers, and
 * a bound row instead accepts each poll proof only with a later `iat` than the
 * last one.
 */

export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_AUTHORIZATION_PATH = "/oauth/device_authorization";
export const DEVICE_TOKEN_PATH = "/oauth/device_token";
export const DEVICE_AUTHORIZATION_SUBJECT = "device-authorization";

const DEVICE_CODE_TTL = Duration.minutes(10);
const POLL_INTERVAL_SECONDS = 5;
const DEFAULT_GRANT_TTL = Duration.days(30);
const MAX_PENDING_REQUESTS = 20;
const MAX_LABEL_LENGTH = 120;
const DEVICE_CODE_BYTES = 32;
// RFC 8628 §6.1: consonants only, no ambiguous characters, 20^8 combinations.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const USER_CODE_REJECTION_LIMIT = 256 - (256 % USER_CODE_ALPHABET.length);

// Control and invisible format characters (including bidi overrides) could
// disguise the request in the owner's terminal.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;

/**
 * JSON-encodes client-supplied text for the owner's terminal, escaping every
 * control and format character, including the C1 and bidi characters
 * `JSON.stringify` leaves raw.
 */
export const escapeForTerminal = (value: unknown) =>
  // JSON already escapes controls inside strings; the only raw newlines left
  // are its own indentation.
  (JSON.stringify(value, null, 2) ?? "null").replace(
    /(?!\n)[\p{Cc}\p{Cf}]/gu,
    (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );

export class DeviceAuthorizationStoreError extends Data.TaggedError(
  "DeviceAuthorizationStoreError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/** The owner tried to grant a scope the client did not request. */
export class DeviceAuthorizationScopeError extends Data.TaggedError(
  "DeviceAuthorizationScopeError",
)<{
  readonly allowedScopes: ReadonlyArray<AuthEnvironmentScope>;
}> {}

/**
 * An external MCP policy needs a key-bound request: the endpoint only accepts
 * DPoP, so a bearer grant would be unusable, and scopes would widen it.
 */
export class DeviceAuthorizationMcpPolicyError extends Data.TaggedError(
  "DeviceAuthorizationMcpPolicyError",
)<{
  readonly reason: "unbound-request" | "scopes-with-policy";
}> {}

export interface DeviceAuthorizationStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export interface DeviceAuthorizationRequest {
  readonly userCode: string;
  readonly status: "pending" | "approved";
  readonly client: AuthClientMetadata;
  readonly requestedScopes: ReadonlyArray<AuthEnvironmentScope> | null;
  readonly proofKeyThumbprint: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface DeviceAuthorizationApproval {
  readonly userCode: string;
  readonly client: AuthClientMetadata;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly ttl: Duration.Duration;
  readonly proofKeyThumbprint: string | null;
  readonly mcpPolicy: ExternalMcpGrant.ExternalMcpPolicy | null;
}

export type DeviceAuthorizationPollResult =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "SlowDown" }
  | { readonly _tag: "Denied" }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "Invalid" }
  | { readonly _tag: "ReplayedProof" }
  | { readonly _tag: "Issued"; readonly session: SessionStore.IssuedSession };

export class DeviceAuthorizationStore extends Context.Service<
  DeviceAuthorizationStore,
  {
    readonly start: (input: {
      readonly client: AuthClientMetadata;
      readonly requestedScopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly proofKeyThumbprint?: string;
    }) => Effect.Effect<Option.Option<DeviceAuthorizationStart>, DeviceAuthorizationStoreError>;
    readonly listOpen: () => Effect.Effect<
      ReadonlyArray<DeviceAuthorizationRequest>,
      DeviceAuthorizationStoreError
    >;
    /**
     * Grants `scopes` when given, else the requested scopes, else the standard
     * client scopes. `scopes` may narrow a request but never widen it; with no
     * request it may name any environment scope.
     *
     * `mcpPolicy` instead grants an external MCP client: no scopes, and the
     * policy as the session's only authority.
     */
    readonly approve: (input: {
      readonly userCode: string;
      readonly ttl?: Duration.Duration;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly mcpPolicy?: ExternalMcpGrant.ExternalMcpPolicy;
    }) => Effect.Effect<
      Option.Option<DeviceAuthorizationApproval>,
      | DeviceAuthorizationStoreError
      | DeviceAuthorizationScopeError
      | DeviceAuthorizationMcpPolicyError
    >;
    readonly deny: (userCode: string) => Effect.Effect<boolean, DeviceAuthorizationStoreError>;
    readonly poll: (input: {
      readonly deviceCode: string;
      /** The verified DPoP proof's key and `iat`, in epoch seconds. */
      readonly proof?: { readonly thumbprint: string; readonly issuedAt: number };
    }) => Effect.Effect<DeviceAuthorizationPollResult, DeviceAuthorizationStoreError>;
  }
>()("t3/auth/DeviceAuthorization.fork/DeviceAuthorizationStore") {}

/** Accepts `BCDF-GHJK`, `bcdfghjk`, or any spacing the owner typed. */
const normalizeUserCode = (value: string) => value.toUpperCase().replace(/[^A-Z]/g, "");

const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

interface DeviceAuthorizationRow {
  readonly userCode: string;
  readonly status: string;
  readonly clientJson: string;
  readonly requestedScopes: string | null;
  readonly proofKeyThumbprint: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastPolledAt: string | null;
  readonly grantedScopes: string | null;
  readonly grantedTtlMs: number | null;
  readonly mcpPolicyJson: string | null;
}

const ScopesJson = Schema.fromJsonString(AuthEnvironmentScopes);
const ClientJson = Schema.fromJsonString(AuthClientMetadata);
const decodeScopes = Schema.decodeUnknownSync(ScopesJson);
const encodeScopes = Schema.encodeSync(ScopesJson);
const decodeClient = Schema.decodeUnknownSync(ClientJson);
const encodeClient = Schema.encodeSync(ClientJson);

const toRequest = (row: DeviceAuthorizationRow): DeviceAuthorizationRequest => ({
  userCode: formatUserCode(row.userCode),
  status: row.status === "approved" ? "approved" : "pending",
  client: decodeClient(row.clientJson),
  requestedScopes: row.requestedScopes === null ? null : decodeScopes(row.requestedScopes),
  proofKeyThumbprint: row.proofKeyThumbprint,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
});

const ROW_COLUMNS = `
  user_code AS "userCode",
  status AS "status",
  client_json AS "clientJson",
  requested_scopes AS "requestedScopes",
  proof_key_thumbprint AS "proofKeyThumbprint",
  created_at AS "createdAt",
  expires_at AS "expiresAt",
  last_polled_at AS "lastPolledAt",
  granted_scopes AS "grantedScopes",
  granted_ttl_ms AS "grantedTtlMs",
  mcp_policy_json AS "mcpPolicyJson"
`;

const isoNow = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(DateTime.toUtc(now))));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const sessions = yield* SessionStore.SessionStore;
  const columns = sql.literal(ROW_COLUMNS);

  const fail = (operation: string) => (cause: unknown) =>
    new DeviceAuthorizationStoreError({ operation, cause });

  // The table stores only a digest, so a database read cannot recover a
  // device code that is still waiting for approval.
  const hashDeviceCode = (deviceCode: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(deviceCode))
      .pipe(Effect.map(Encoding.encodeBase64Url), Effect.mapError(fail("hash-device-code")));

  const generateUserCode = Effect.gen(function* () {
    let code = "";
    while (code.length < USER_CODE_LENGTH) {
      const bytes = yield* crypto.randomBytes(USER_CODE_LENGTH * 2);
      for (const byte of bytes) {
        if (byte >= USER_CODE_REJECTION_LIMIT || code.length === USER_CODE_LENGTH) continue;
        code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]!;
      }
    }
    return code;
  }).pipe(Effect.mapError(fail("generate-user-code")));

  const start: DeviceAuthorizationStore["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(DateTime.toUtc(now));
      const deviceCode = Encoding.encodeBase64Url(yield* crypto.randomBytes(DEVICE_CODE_BYTES));
      const deviceCodeHash = yield* hashDeviceCode(deviceCode);
      const userCode = yield* generateUserCode;
      const expiresAt = DateTime.toUtc(
        DateTime.add(now, { milliseconds: Duration.toMillis(DEVICE_CODE_TTL) }),
      );
      yield* sql`DELETE FROM auth_device_authorizations WHERE expires_at <= ${nowIso}`;
      // One statement counts and inserts, so concurrent starts cannot all pass
      // the cap before any of them lands.
      const admitted = yield* sql`
        INSERT INTO auth_device_authorizations (
          device_code_hash, user_code, status, client_json, requested_scopes,
          proof_key_thumbprint, created_at, expires_at
        )
        SELECT
          ${deviceCodeHash},
          ${userCode},
          'pending',
          ${encodeClient(input.client)},
          ${input.requestedScopes ? encodeScopes(input.requestedScopes) : null},
          ${input.proofKeyThumbprint ?? null},
          ${nowIso},
          ${DateTime.formatIso(expiresAt)}
        WHERE (
          SELECT COUNT(*) FROM auth_device_authorizations
          WHERE status IN ('pending', 'approved')
        ) < ${MAX_PENDING_REQUESTS}
        RETURNING device_code_hash
      `;
      if (admitted.length === 0) return Option.none<DeviceAuthorizationStart>();
      return Option.some({
        deviceCode,
        userCode: formatUserCode(userCode),
        expiresInSeconds: Duration.toSeconds(DEVICE_CODE_TTL),
        intervalSeconds: POLL_INTERVAL_SECONDS,
      });
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof DeviceAuthorizationStoreError ? cause : fail("start")(cause),
      ),
      Effect.withSpan("DeviceAuthorizationStore.start"),
    );

  const listOpen: DeviceAuthorizationStore["Service"]["listOpen"] = () =>
    Effect.gen(function* () {
      const nowIso = yield* isoNow;
      const rows = yield* sql<DeviceAuthorizationRow>`
        SELECT ${columns} FROM auth_device_authorizations
        WHERE status IN ('pending', 'approved') AND expires_at > ${nowIso}
        ORDER BY created_at DESC
      `;
      return rows.map(toRequest);
    }).pipe(Effect.mapError(fail("list")), Effect.withSpan("DeviceAuthorizationStore.listOpen"));

  const approve: DeviceAuthorizationStore["Service"]["approve"] = (input) =>
    Effect.gen(function* () {
      const nowIso = yield* isoNow;
      const ttl = input.ttl ?? DEFAULT_GRANT_TTL;
      const [row] = yield* sql<DeviceAuthorizationRow>`
        SELECT ${columns} FROM auth_device_authorizations
        WHERE user_code = ${normalizeUserCode(input.userCode)}
          AND status = 'pending'
          AND expires_at > ${nowIso}
      `;
      if (row === undefined) return Option.none<DeviceAuthorizationApproval>();
      const request = toRequest(row);
      const mcpPolicy = input.mcpPolicy ?? null;
      if (mcpPolicy !== null && input.scopes !== undefined) {
        return yield* new DeviceAuthorizationMcpPolicyError({ reason: "scopes-with-policy" });
      }
      if (mcpPolicy !== null && request.proofKeyThumbprint === null) {
        return yield* new DeviceAuthorizationMcpPolicyError({ reason: "unbound-request" });
      }
      const allowedScopes = request.requestedScopes ?? AuthAdministrativeScopes;
      if (input.scopes?.some((scope) => !allowedScopes.includes(scope))) {
        return yield* new DeviceAuthorizationScopeError({ allowedScopes });
      }
      const scopes: ReadonlyArray<AuthEnvironmentScope> =
        mcpPolicy !== null
          ? []
          : (input.scopes ?? request.requestedScopes ?? AuthStandardClientScopes);
      const updated = yield* sql<{ readonly userCode: string }>`
        UPDATE auth_device_authorizations
        SET status = 'approved',
            granted_scopes = ${encodeScopes(scopes)},
            granted_ttl_ms = ${Duration.toMillis(ttl)},
            mcp_policy_json = ${
              mcpPolicy === null ? null : ExternalMcpGrant.encodeExternalMcpPolicy(mcpPolicy)
            },
            decided_at = ${nowIso}
        WHERE user_code = ${row.userCode} AND status = 'pending'
        RETURNING user_code AS "userCode"
      `;
      if (updated.length === 0) return Option.none<DeviceAuthorizationApproval>();
      return Option.some({
        userCode: request.userCode,
        client: request.client,
        scopes,
        ttl,
        proofKeyThumbprint: request.proofKeyThumbprint,
        mcpPolicy,
      });
    }).pipe(
      Effect.catchTag("SqlError", (cause) => Effect.fail(fail("approve")(cause))),
      Effect.withSpan("DeviceAuthorizationStore.approve"),
    );

  const deny: DeviceAuthorizationStore["Service"]["deny"] = (userCode) =>
    Effect.gen(function* () {
      const nowIso = yield* isoNow;
      const updated = yield* sql<{ readonly userCode: string }>`
        UPDATE auth_device_authorizations
        SET status = 'denied', decided_at = ${nowIso}
        WHERE user_code = ${normalizeUserCode(userCode)} AND status IN ('pending', 'approved')
        RETURNING user_code AS "userCode"
      `;
      return updated.length > 0;
    }).pipe(Effect.mapError(fail("deny")), Effect.withSpan("DeviceAuthorizationStore.deny"));

  const poll: DeviceAuthorizationStore["Service"]["poll"] = (input) =>
    Effect.gen(function* () {
      const deviceCodeHash = yield* hashDeviceCode(input.deviceCode);
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(DateTime.toUtc(now));
      const [row] = yield* sql<DeviceAuthorizationRow>`
        SELECT ${columns} FROM auth_device_authorizations
        WHERE device_code_hash = ${deviceCodeHash}
      `;
      if (row === undefined || row.status === "consumed") return { _tag: "Invalid" } as const;
      // A key-bound request only answers to the same key, and an unbound one
      // cannot be upgraded or claimed by a different poller.
      if ((row.proofKeyThumbprint ?? undefined) !== input.proof?.thumbprint) {
        return { _tag: "Invalid" } as const;
      }
      if (input.proof) {
        const accepted = yield* sql`
          UPDATE auth_device_authorizations SET last_proof_iat = ${input.proof.issuedAt}
          WHERE device_code_hash = ${deviceCodeHash}
            AND (last_proof_iat IS NULL OR last_proof_iat < ${input.proof.issuedAt})
          RETURNING device_code_hash
        `;
        if (accepted.length === 0) return { _tag: "ReplayedProof" } as const;
      }
      if (row.status === "denied") return { _tag: "Denied" } as const;
      if (row.expiresAt <= nowIso) return { _tag: "Expired" } as const;

      if (row.status === "pending") {
        const tooSoon =
          row.lastPolledAt !== null &&
          now.epochMilliseconds - DateTime.makeUnsafe(row.lastPolledAt).epochMilliseconds <
            POLL_INTERVAL_SECONDS * 1_000;
        yield* sql`
          UPDATE auth_device_authorizations SET last_polled_at = ${nowIso}
          WHERE device_code_hash = ${deviceCodeHash}
        `;
        return tooSoon ? ({ _tag: "SlowDown" } as const) : ({ _tag: "Pending" } as const);
      }

      // Consume before issuing so two concurrent polls cannot both receive a
      // session, in one transaction so a failed issue leaves the approval.
      return yield* Effect.gen(function* () {
        const [claimed] = yield* sql<DeviceAuthorizationRow>`
        UPDATE auth_device_authorizations
        SET status = 'consumed'
        WHERE device_code_hash = ${deviceCodeHash} AND status = 'approved'
        RETURNING ${columns}
      `;
        if (claimed === undefined || claimed.grantedScopes === null) {
          return { _tag: "Invalid" } as const;
        }
        const session = yield* sessions.issue({
          subject: DEVICE_AUTHORIZATION_SUBJECT,
          method: claimed.proofKeyThumbprint ? "dpop-access-token" : "bearer-access-token",
          scopes: decodeScopes(claimed.grantedScopes),
          ttl: Duration.millis(claimed.grantedTtlMs ?? Duration.toMillis(DEFAULT_GRANT_TTL)),
          client: decodeClient(claimed.clientJson),
          ...(claimed.proofKeyThumbprint ? { proofKeyThumbprint: claimed.proofKeyThumbprint } : {}),
        });
        yield* sql`
        UPDATE auth_device_authorizations SET session_id = ${session.sessionId}
        WHERE device_code_hash = ${deviceCodeHash}
      `;
        if (claimed.mcpPolicyJson !== null) {
          yield* ExternalMcpGrant.recordExternalMcpGrant({
            sessionId: session.sessionId,
            policy: ExternalMcpGrant.decodeExternalMcpPolicy(claimed.mcpPolicyJson),
            clientLabel: session.client.label ?? null,
            createdAt: nowIso,
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        }
        return { _tag: "Issued", session } as const;
      }).pipe(sql.withTransaction);
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof DeviceAuthorizationStoreError ? cause : fail("poll")(cause),
      ),
      Effect.withSpan("DeviceAuthorizationStore.poll"),
    );

  return DeviceAuthorizationStore.of({ start, listOpen, approve, deny, poll });
});

export const layer = Layer.effect(DeviceAuthorizationStore, make);

const CREDENTIAL_HEADERS = { "cache-control": "no-store", pragma: "no-cache" } as const;

const oauthError = (error: string, status = 400) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers: CREDENTIAL_HEADERS });

const isDeviceType = Schema.is(AuthClientMetadataDeviceType);
const ALL_SCOPES = new Set<AuthEnvironmentScope>(AuthAdministrativeScopes);

// Packaged builds answer every origin under CORS, and these routes need no
// credential, so a web page could otherwise start a grant and read its token.
// Browsers send `Origin` on every POST; native clients send neither header.
// `Sec-Fetch-Mode` is no signal: Node's `fetch` sends it too.
const isBrowserRequest = HttpServerRequest.HttpServerRequest.pipe(
  Effect.map(
    (request) =>
      request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined,
  ),
);

const readForm = HttpServerRequest.HttpServerRequest.pipe(
  Effect.flatMap((request) => request.urlParamsBody),
  Effect.map((params) => (key: string) => Option.getOrUndefined(UrlParams.getFirst(params, key))),
);

/**
 * Verifies an optional DPoP header without recording a replay marker, so a
 * flood of fresh keys cannot grow state. `undefined` means no proof was sent;
 * `null` means a proof was sent and failed.
 */
const readProof = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.dpop === undefined) return undefined;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return null;
  const now = yield* DateTime.now;
  const result = verifyDpopProof({
    proof: request.headers.dpop,
    method: request.method,
    url: url.value.href,
    nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
  });
  return result.ok ? { thumbprint: result.thumbprint, issuedAt: result.iat } : null;
});

const deviceAuthorizationRoute = (store: DeviceAuthorizationStore["Service"]) =>
  HttpRouter.add(
    "POST",
    DEVICE_AUTHORIZATION_PATH,
    Effect.gen(function* () {
      if (yield* isBrowserRequest) return oauthError("invalid_request", 403);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const form = yield* readForm;
      const label = form("client_label")?.trim();
      const deviceType = form("client_device_type") ?? "bot";
      const os = form("client_os")?.trim();
      const scope = form("scope");
      // The owner reads these unauthenticated fields when deciding, so keep
      // them short enough to show whole.
      if (
        !label ||
        label.length > MAX_LABEL_LENGTH ||
        (os?.length ?? 0) > MAX_LABEL_LENGTH ||
        UNSAFE_TEXT.test(label) ||
        (os !== undefined && UNSAFE_TEXT.test(os))
      ) {
        return oauthError("invalid_request");
      }
      if (!isDeviceType(deviceType)) return oauthError("invalid_request");
      const requestedScopes =
        scope === undefined
          ? undefined
          : parseAllowedOAuthScope({ value: scope, allowedScopes: ALL_SCOPES });
      if (requestedScopes === null) return oauthError("invalid_scope");
      // A replayed start proof only opens another capped request bound to
      // the same key, which nobody without that key can poll.
      const proof = yield* readProof;
      if (proof === null) return oauthError("invalid_dpop_proof");

      const started = yield* store.start({
        client: deriveAuthClientMetadata({
          request,
          presented: { label, deviceType, ...(os ? { os } : {}) },
        }),
        ...(requestedScopes ? { requestedScopes } : {}),
        ...(proof ? { proofKeyThumbprint: proof.thumbprint } : {}),
      });
      if (Option.isNone(started)) return oauthError("slow_down", 429);
      return HttpServerResponse.jsonUnsafe(
        {
          device_code: started.value.deviceCode,
          user_code: started.value.userCode,
          expires_in: started.value.expiresInSeconds,
          interval: started.value.intervalSeconds,
        },
        { headers: CREDENTIAL_HEADERS },
      );
    }).pipe(
      Effect.catchTags({
        DeviceAuthorizationStoreError: (error) =>
          Effect.logError("device authorization failed", { operation: error.operation }).pipe(
            Effect.as(oauthError("server_error", 500)),
          ),
        HttpServerError: () => Effect.succeed(oauthError("invalid_request")),
      }),
    ),
  );

const POLL_ERRORS = {
  Pending: "authorization_pending",
  SlowDown: "slow_down",
  Denied: "access_denied",
  Expired: "expired_token",
  Invalid: "invalid_grant",
  ReplayedProof: "invalid_dpop_proof",
} as const;

const deviceTokenRoute = (store: DeviceAuthorizationStore["Service"]) =>
  HttpRouter.add(
    "POST",
    DEVICE_TOKEN_PATH,
    Effect.gen(function* () {
      if (yield* isBrowserRequest) return oauthError("invalid_request", 403);
      const form = yield* readForm;
      const deviceCode = form("device_code");
      if (form("grant_type") !== DEVICE_CODE_GRANT_TYPE)
        return oauthError("unsupported_grant_type");
      if (!deviceCode) return oauthError("invalid_request");
      const proof = yield* readProof;
      if (proof === null) return oauthError("invalid_dpop_proof");

      const result = yield* store.poll({ deviceCode, ...(proof ? { proof } : {}) });
      if (result._tag !== "Issued") return oauthError(POLL_ERRORS[result._tag]);
      const { session } = result;
      const now = yield* DateTime.now;
      return HttpServerResponse.jsonUnsafe(
        {
          access_token: session.token,
          token_type: session.method === "dpop-access-token" ? "DPoP" : "Bearer",
          expires_in: Math.max(
            0,
            Math.floor((session.expiresAt.epochMilliseconds - now.epochMilliseconds) / 1_000),
          ),
          // An external MCP grant carries no scopes, and OAuth has no empty scope.
          ...(session.scopes.length > 0 ? { scope: encodeOAuthScope(session.scopes) } : {}),
        },
        { headers: CREDENTIAL_HEADERS },
      );
    }).pipe(
      Effect.catchTags({
        DeviceAuthorizationStoreError: (error) =>
          Effect.logError("device token poll failed", { operation: error.operation }).pipe(
            Effect.as(oauthError("server_error", 500)),
          ),
        HttpServerError: () => Effect.succeed(oauthError("invalid_request")),
      }),
    ),
  );

export const routeLayer = Layer.unwrap(
  DeviceAuthorizationStore.useSync((store) =>
    Layer.mergeAll(deviceAuthorizationRoute(store), deviceTokenRoute(store)),
  ),
).pipe(Layer.provide(layer));
