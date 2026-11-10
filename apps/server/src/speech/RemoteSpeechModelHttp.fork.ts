// Fork-only: reads and saves the remote speech model's settings. Selection and use go through
// upstream's voice endpoints, where the service appears as one more model.
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  SPEECH_REMOTE_MODEL_ROUTE_FORK,
  SpeechRemoteModelUpdateFork,
  type AuthEnvironmentScope,
  type SpeechRemoteModelSettingsFork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid } from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as RemoteSpeechModelStore from "./RemoteSpeechModelStore.fork.ts";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

const authorize = Effect.fn("RemoteSpeechModelHttp.authorize")(function* (
  scope: AuthEnvironmentScope,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  return yield* auth.authenticateHttpRequest(request).pipe(
    Effect.map((session) =>
      session.scopes.includes(scope)
        ? null
        : json({ error: "Permission required.", requiredScope: scope }, 403),
    ),
    Effect.catch((error) =>
      EnvironmentAuth.isServerAuthCredentialError(error)
        ? failEnvironmentAuthInvalid(
            EnvironmentAuth.serverAuthCredentialReason(error),
            EnvironmentAuth.serverAuthDpopFailureReason(error),
          ).pipe(Effect.catch(HttpServerRespondable.toResponse))
        : Effect.succeed(json({ error: "Authentication failed." }, 500)),
    ),
  );
});

const publicSettings = (
  remote: RemoteSpeechModelStore.RemoteSpeechModelFork | null,
): SpeechRemoteModelSettingsFork =>
  remote
    ? {
        baseUrl: remote.baseUrl,
        model: remote.model,
        live: remote.live,
        hasApiKey: !!remote.apiKey,
      }
    : { baseUrl: "", model: "", live: false, hasApiKey: false };

const storageFailure = () => Effect.succeed(json({ error: "Could not access the settings." }, 500));

export const routeLayerFork = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* RemoteSpeechModelStore.RemoteSpeechModelStoreFork;
    const save = Effect.gen(function* () {
      const refusal = yield* authorize(AuthSettingsWriteScope);
      if (refusal) return refusal;
      const input = yield* HttpServerRequest.schemaBodyJson(SpeechRemoteModelUpdateFork).pipe(
        Effect.option,
      );
      if (input._tag === "None") return json({ error: "Invalid settings." }, 400);
      const saved = yield* store.save(input.value);
      return saved
        ? json(publicSettings(saved))
        : json({ error: "Check the base URL and model." }, 400);
    }).pipe(Effect.catch(storageFailure));
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        SPEECH_REMOTE_MODEL_ROUTE_FORK,
        Effect.gen(function* () {
          const refusal = yield* authorize(AuthOrchestrationReadScope);
          if (refusal) return refusal;
          return json(publicSettings(yield* store.read));
        }).pipe(Effect.catch(storageFailure)),
      ),
      HttpRouter.add("POST", SPEECH_REMOTE_MODEL_ROUTE_FORK, save),
    );
  }),
).pipe(Layer.provide(RemoteSpeechModelStore.layer), Layer.provide(ServerSecretStore.layer));
