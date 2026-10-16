/// <reference lib="es2024.promise" />
import {
  EnvironmentHttpCommonError,
  VoiceTextHttpErrorFork,
  VOICE_INPUT_ROUTE_FORK,
  VoiceInputSettingsFork,
  VoiceInputTranscriptFork,
  type VoiceInputConfigUpdateFork,
  VoiceTextSettingsFork,
  type VoiceTextConfigureFork,
  type VoiceTextTransformFork,
  type VoiceTextContextFork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
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
const decodeVoiceTextError = Schema.decodeUnknownEffect(VoiceTextHttpErrorFork);

/** Uses the selected environment's cookies, bearer grant, or refreshed relay proof. */
const requestVoiceInputFork = Effect.fn(function* <A, E>(
  prepared: PreparedConnection,
  operation:
    | "read"
    | "save"
    | "transcribe"
    | "text-read"
    | "text-save"
    | "text-transform"
    | "text-context",
  decode: (value: unknown) => Effect.Effect<A, E>,
  payload?:
    | VoiceInputConfigUpdateFork
    | Uint8Array
    | VoiceTextConfigureFork
    | VoiceTextTransformFork
    | VoiceTextContextFork,
) {
  const http = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const method = operation === "read" || operation === "text-read" ? "GET" : "POST";
  let requestUrl = "";
  const response = yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method,
    group: "orchestration",
    timeoutMs:
      operation === "transcribe"
        ? 75_000
        : operation === "text-transform" || operation === "text-context"
          ? 200_000
          : 15_000,
    url: (urls) => {
      requestUrl = environmentEndpointUrl(
        urls.generateThreadGroupTitle(),
        `${VOICE_INPUT_ROUTE_FORK}/${
          operation.startsWith("text-")
            ? `text/${operation === "text-transform" ? "transform" : operation === "text-context" ? "context" : "settings"}`
            : operation === "transcribe"
              ? "transcribe"
              : "settings"
        }`,
      );
      return requestUrl;
    },
    request: Effect.fn("voiceInput.request")(function* ({ headers }) {
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
        const authError = yield* decodeHttpError(json).pipe(Effect.option);
        if (Option.isSome(authError)) return yield* authError.value;
      }
      return { status: response.status, json };
    }),
  });
  // Decode endpoint errors outside the auth boundary, which wraps unknown failures.
  if (response.status < 200 || response.status >= 300) {
    const error = yield* decodeVoiceTextError(response.json).pipe(
      Effect.orElseSucceed(
        () => new RemoteEnvironmentAuthUndeclaredStatusError(requestUrl, response.status),
      ),
    );
    return yield* Effect.fail(error);
  }
  return yield* decode(response.json);
});

export const readVoiceInputSettingsFork = (prepared: PreparedConnection) =>
  requestVoiceInputFork(prepared, "read", decodeSettings);
export const saveVoiceInputSettingsFork = (
  prepared: PreparedConnection,
  input: VoiceInputConfigUpdateFork,
) => requestVoiceInputFork(prepared, "save", decodeSettings, input);
export const transcribeVoiceInputFork = (prepared: PreparedConnection, wav: Uint8Array) =>
  requestVoiceInputFork(prepared, "transcribe", decodeTranscript, wav);

export const readVoiceTextSettingsFork = (prepared: PreparedConnection) =>
  requestVoiceInputFork(prepared, "text-read", Schema.decodeUnknownEffect(VoiceTextSettingsFork));
export const saveVoiceTextSettingsFork = (
  prepared: PreparedConnection,
  input: VoiceTextConfigureFork,
) =>
  requestVoiceInputFork(
    prepared,
    "text-save",
    Schema.decodeUnknownEffect(VoiceTextSettingsFork),
    input,
  );
export const transformVoiceTextFork = (
  prepared: PreparedConnection,
  input: VoiceTextTransformFork,
) => requestVoiceInputFork(prepared, "text-transform", decodeTranscript, input);
export const generateVoiceTextContextFork = (
  prepared: PreparedConnection,
  input: VoiceTextContextFork,
) => requestVoiceInputFork(prepared, "text-context", decodeTranscript, input);
