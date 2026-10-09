import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  VoiceInputConfigUpdateFork,
  VOICE_INPUT_ROUTE_FORK,
  VOICE_INPUT_MAX_BYTES_FORK,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VoiceInput from "./VoiceInput.fork.ts";
import { failEnvironmentAuthInvalid } from "../auth/http.ts";
const isVoiceInputError = Schema.is(VoiceInput.VoiceInputError);
const decodeSettingsJson = Schema.decodeEffect(Schema.fromJsonString(VoiceInputConfigUpdateFork));

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
const authorize = (scope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
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

/** Bound untrusted uploads before allocating the joined recording. */
const readBody = (maxBytes: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* Stream.runFoldEffect(
      request.stream,
      () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
      (body, chunk) => {
        if (body.size + chunk.byteLength > maxBytes)
          return Effect.fail(new VoiceInput.VoiceInputError({ reason: "audio" }));
        body.size += chunk.byteLength;
        body.chunks.push(chunk);
        return Effect.succeed(body);
      },
    ).pipe(
      Effect.mapError((cause) =>
        isVoiceInputError(cause)
          ? cause
          : new VoiceInput.VoiceInputError({ reason: "audio", cause }),
      ),
    );
    const bytes = new Uint8Array(body.size);
    let at = 0;
    for (const chunk of body.chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return bytes;
  });

const failure = (error: VoiceInput.VoiceInputError) =>
  Effect.succeed(
    json(
      { error: error.message, code: error.reason },
      error.reason === "storage"
        ? 500
        : error.reason === "upstream" || error.reason === "response"
          ? 502
          : 400,
    ),
  );

const configureSettings = (service: VoiceInput.VoiceInput["Service"]) =>
  Effect.gen(function* () {
    const refusal = yield* authorize(AuthSettingsWriteScope);
    if (refusal) return refusal;
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
      return json({ error: "Expected JSON settings." }, 415);
    return yield* readBody(16384).pipe(
      Effect.flatMap((bytes) => decodeSettingsJson(new TextDecoder().decode(bytes))),
      Effect.mapError((cause) => new VoiceInput.VoiceInputError({ reason: "settings", cause })),
      Effect.flatMap(service.configure),
      Effect.map((settings) => json(settings)),
      Effect.catch(failure),
    );
  });

export const routes = (service: VoiceInput.VoiceInput["Service"]) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      `${VOICE_INPUT_ROUTE_FORK}/settings`,
      Effect.gen(function* () {
        const refusal = yield* authorize(AuthOrchestrationReadScope);
        if (refusal) return refusal;
        return yield* service.settings.pipe(
          Effect.map((settings) => json(settings)),
          Effect.catch(failure),
        );
      }),
    ),
    HttpRouter.add("PUT", `${VOICE_INPUT_ROUTE_FORK}/settings`, configureSettings(service)),
    // POST follows the existing browser/desktop CORS policy; PUT remains compatible.
    HttpRouter.add("POST", `${VOICE_INPUT_ROUTE_FORK}/settings`, configureSettings(service)),
    HttpRouter.add(
      "POST",
      `${VOICE_INPUT_ROUTE_FORK}/transcribe`,
      Effect.gen(function* () {
        const refusal = yield* authorize(AuthOrchestrationOperateScope);
        if (refusal) return refusal;
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers["content-type"]?.split(";")[0]?.trim() !== "audio/wav")
          return json({ error: "Expected WAV audio." }, 415);
        return yield* readBody(VOICE_INPUT_MAX_BYTES_FORK).pipe(
          Effect.flatMap(service.transcribe),
          Effect.map((text) => json({ text })),
          Effect.catch(failure),
        );
      }),
    ),
  );

export const routeLayer = Layer.unwrap(Effect.map(VoiceInput.VoiceInput, routes)).pipe(
  Layer.provide(VoiceInput.layer.pipe(Layer.provide(ServerSecretStore.layer))),
);
