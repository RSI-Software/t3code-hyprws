import type { AuthGrantScope, AuthSessionId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpMethod } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type {
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../rpc/http.ts";
import {
  type EnvironmentHttpAuthHeaders,
  executeAuthenticatedEnvironmentHttpRequest,
} from "./environmentHttpAuth.ts";

const AUTH_MUTATION_TIMEOUT_MS = 10_000;

export class EnvironmentNotConnectedError extends Data.TaggedError(
  "@t3tools/client-runtime/state/authHttp/EnvironmentNotConnectedError",
)<{ readonly message: string }> {}

type AuthHttpClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<"auth">>>;

/** Runs one auth endpoint through the shared authenticated request boundary. */
const executeAuthRequest = Effect.fn("clientRuntime.state.authHttp.executeAuthRequest")(function* <
  A,
  E,
  R,
>(
  method: HttpMethod.HttpMethod,
  url: (urls: ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>["auth"]) => string,
  request: (input: {
    readonly client: AuthHttpClient;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new EnvironmentNotConnectedError({
      message: "This environment is not connected, so its access settings cannot be changed.",
    });
  }
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: prepared.value,
    signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    group: "auth",
    method,
    url,
    timeoutMs: AUTH_MUTATION_TIMEOUT_MS,
    request,
  });
});

export const fetchEnvironmentSessionState = Effect.fn(
  "clientRuntime.state.authHttp.fetchEnvironmentSessionState",
)(function* () {
  return yield* executeAuthRequest(
    "GET",
    (urls) => urls.session(),
    ({ client, headers }) => client.session({ headers }),
  );
});

export const createEnvironmentPairingCredential = Effect.fn(
  "clientRuntime.state.authHttp.createEnvironmentPairingCredential",
)(function* (input: {
  readonly label?: string;
  // Grant scopes: `review:write` decodes from old credentials but is not grantable.
  readonly scopes?: ReadonlyArray<AuthGrantScope>;
}) {
  const trimmedLabel = input.label?.trim();
  return yield* executeAuthRequest(
    "POST",
    (urls) => urls.pairingCredential(),
    ({ client, headers }) =>
      client.pairingCredential({
        headers,
        payload: {
          ...(trimmedLabel ? { label: trimmedLabel } : {}),
          ...(input.scopes ? { scopes: input.scopes } : {}),
        },
      }),
  );
});

export const revokeEnvironmentPairingLink = Effect.fn(
  "clientRuntime.state.authHttp.revokeEnvironmentPairingLink",
)(function* (input: { readonly id: string }) {
  return yield* executeAuthRequest(
    "POST",
    (urls) => urls.revokePairingLink(),
    ({ client, headers }) => client.revokePairingLink({ headers, payload: { id: input.id } }),
  );
});

export const revokeEnvironmentClientSession = Effect.fn(
  "clientRuntime.state.authHttp.revokeEnvironmentClientSession",
)(function* (input: { readonly sessionId: AuthSessionId }) {
  return yield* executeAuthRequest(
    "POST",
    (urls) => urls.revokeClient(),
    ({ client, headers }) =>
      client.revokeClient({ headers, payload: { sessionId: input.sessionId } }),
  );
});

export const revokeOtherEnvironmentClientSessions = Effect.fn(
  "clientRuntime.state.authHttp.revokeOtherEnvironmentClientSessions",
)(function* () {
  return yield* executeAuthRequest(
    "POST",
    (urls) => urls.revokeOtherClients(),
    ({ client, headers }) => client.revokeOtherClients({ headers }),
  );
});
