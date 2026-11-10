import {
  EnvironmentHttpCommonError,
  SPEECH_REMOTE_MODEL_ROUTE_FORK,
  SpeechRemoteModelSettingsFork,
  type SpeechRemoteModelUpdateFork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";

const decodeSettings = Schema.decodeUnknownEffect(SpeechRemoteModelSettingsFork);
const decodeHttpError = Schema.decodeUnknownEffect(EnvironmentHttpCommonError);

export class SpeechRemoteModelErrorFork extends Schema.TaggedError<SpeechRemoteModelErrorFork>()(
  "SpeechRemoteModelErrorFork",
  { status: Schema.Number },
) {
  override get message(): string {
    if (this.status === 400) return "Check the base URL and model.";
    if (this.status === 403) return "Changing the remote model needs settings access.";
    return "The remote model settings are unavailable.";
  }
}

/** Uses the environment's cookies, bearer grant, or refreshed relay proof. */
const request = Effect.fn("speechRemoteModel.request")(function* (
  prepared: PreparedConnection,
  payload?: SpeechRemoteModelUpdateFork,
) {
  const http = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const method = payload ? "POST" : "GET";
  let requestUrl = "";
  const response = yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method,
    group: "orchestration",
    timeoutMs: 15_000,
    url: (urls) => {
      requestUrl = environmentEndpointUrl(
        urls.generateThreadGroupTitle(),
        SPEECH_REMOTE_MODEL_ROUTE_FORK,
      );
      return requestUrl;
    },
    request: Effect.fn("speechRemoteModel.send")(function* ({ headers }) {
      let request = HttpClientRequest.make(method)(requestUrl).pipe(
        HttpClientRequest.setHeaders({ ...headers }),
      );
      if (payload) request = request.pipe(HttpClientRequest.bodyJsonUnsafe(payload));
      const response = yield* http.execute(request);
      const json = yield* response.json;
      if (response.status < 200 || response.status >= 300) {
        const authError = yield* decodeHttpError(json).pipe(Effect.option);
        if (Option.isSome(authError)) return yield* authError.value;
      }
      return { status: response.status, json };
    }),
  });
  // Endpoint errors surface outside the auth boundary, which wraps unknown failures.
  if (response.status < 200 || response.status >= 300)
    return yield* new SpeechRemoteModelErrorFork({ status: response.status });
  return yield* decodeSettings(response.json);
});

export const readSpeechRemoteModelFork = (prepared: PreparedConnection) => request(prepared);
export const saveSpeechRemoteModelFork = (
  prepared: PreparedConnection,
  input: SpeechRemoteModelUpdateFork,
) => request(prepared, input);
