/// <reference lib="es2024.promise" />
import {
  EnvironmentHttpCommonError,
  VOICE_INPUT_ROUTE_FORK,
  VoiceInputSettingsFork,
  VoiceInputTranscriptFork,
  type VoiceInputConfigUpdateFork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import { RemoteEnvironmentAuthUndeclaredStatusError } from "./http.ts";

const decodeSettings = Schema.decodeUnknownEffect(VoiceInputSettingsFork);
const decodeTranscript = Schema.decodeUnknownEffect(VoiceInputTranscriptFork);
const decodeHttpError = Schema.decodeUnknownEffect(EnvironmentHttpCommonError);

/** Uses the selected environment's cookies, bearer grant, or refreshed relay proof. */
const requestVoiceInputFork = Effect.fn(function* <A, E>(
  prepared: PreparedConnection,
  operation: "read" | "save" | "transcribe",
  decode: (value: unknown) => Effect.Effect<A, E>,
  payload?: VoiceInputConfigUpdateFork | Uint8Array,
) {
  const http = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const method = operation === "read" ? "GET" : "POST";
  let requestUrl = "";
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method,
    group: "orchestration",
    timeoutMs: operation === "transcribe" ? 75_000 : 15_000,
    url: (base) => {
      requestUrl = environmentEndpointUrl(
        base,
        `${VOICE_INPUT_ROUTE_FORK}/${operation === "transcribe" ? "transcribe" : "settings"}`,
      );
      return requestUrl;
    },
    request: ({ headers }) =>
      Effect.gen(function* () {
        let request = HttpClientRequest.make(method)(requestUrl).pipe(
          HttpClientRequest.setHeaders({ ...headers }),
        );
        if (payload instanceof Uint8Array) {
          request = request.pipe(HttpClientRequest.bodyUint8Array(payload, "audio/wav"));
        } else if (payload) {
          request = request.pipe(HttpClientRequest.bodyJsonUnsafe(payload));
        }
        const response = yield* http.execute(request);
        const json = yield* response.json;
        if (response.status < 200 || response.status >= 300) {
          const error = yield* decodeHttpError(json).pipe(
            Effect.catch(() =>
              Effect.succeed(
                new RemoteEnvironmentAuthUndeclaredStatusError(requestUrl, response.status),
              ),
            ),
          );
          return yield* Effect.fail(error);
        }
        return yield* decode(json);
      }),
  });
});

export const readVoiceInputSettingsFork = (prepared: PreparedConnection) =>
  requestVoiceInputFork(prepared, "read", decodeSettings);
export const saveVoiceInputSettingsFork = (
  prepared: PreparedConnection,
  input: VoiceInputConfigUpdateFork,
) => requestVoiceInputFork(prepared, "save", decodeSettings, input);
export const transcribeVoiceInputFork = (prepared: PreparedConnection, wav: Uint8Array) =>
  requestVoiceInputFork(prepared, "transcribe", decodeTranscript, wav);
