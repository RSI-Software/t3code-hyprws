// Fork-only: the remote speech model's settings, kept in the server secret store with its API key.
import type { SpeechRemoteModelConfigFork, SpeechRemoteModelUpdateFork } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export type RemoteSpeechModelFork = SpeechRemoteModelConfigFork & { readonly apiKey: string };

export class RemoteSpeechModelStoreErrorFork extends Schema.TaggedError<RemoteSpeechModelStoreErrorFork>()(
  "RemoteSpeechModelStoreErrorFork",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Remote speech model settings ${this.operation} failed.`;
  }
}

// The name predates this design; keeping it keeps the service configured across the change.
const SECRET_NAME = "fork-voice-input";
/** Every shape the fork has stored: the current one, base URL settings, and full endpoint URLs. */
const Stored = Schema.Struct({
  provider: Schema.optionalKey(Schema.String),
  baseUrl: Schema.optionalKey(Schema.String),
  endpoint: Schema.optionalKey(Schema.String),
  streamingEndpoint: Schema.optionalKey(Schema.String),
  live: Schema.optionalKey(Schema.Boolean),
  model: Schema.String,
  apiKey: Schema.String,
});
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The canonical API root, or null for one paths cannot be appended to. */
function apiRoot(value: string) {
  try {
    const url = new URL(value.trim());
    // URL drops a bare trailing ? or #, so check the raw text.
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !/[?#]/.test(value)
      ? url.origin + url.pathname.replace(/\/+$/, "")
      : null;
  } catch {
    return null;
  }
}

/** Meta's wire is gone, so its settings read as unconfigured. */
export function parseRemoteSpeechModelFork(encoded: string): RemoteSpeechModelFork | null {
  const stored = Option.getOrUndefined(decodeStored(encoded));
  if (!stored || stored.provider === "meta") return null;
  const baseUrl = apiRoot(
    stored.baseUrl ?? stored.endpoint?.replace(/\/audio\/transcriptions\/*$/, "") ?? "",
  );
  const model = stored.model.trim();
  if (!baseUrl || !model) return null;
  return {
    baseUrl,
    model,
    live: stored.live ?? Boolean(stored.streamingEndpoint),
    apiKey: stored.apiKey,
  };
}

export class RemoteSpeechModelStoreFork extends Context.Service<
  RemoteSpeechModelStoreFork,
  {
    readonly read: Effect.Effect<RemoteSpeechModelFork | null, RemoteSpeechModelStoreErrorFork>;
    /** Null when the base URL or model is unusable. An omitted key survives an unchanged URL. */
    readonly save: (
      input: SpeechRemoteModelUpdateFork,
    ) => Effect.Effect<RemoteSpeechModelFork | null, RemoteSpeechModelStoreErrorFork>;
    readonly clear: Effect.Effect<void, RemoteSpeechModelStoreErrorFork>;
  }
>()("t3/speech/RemoteSpeechModelStore.fork/RemoteSpeechModelStoreFork") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const read = secrets.get(SECRET_NAME).pipe(
    Effect.map((stored) =>
      Option.isSome(stored)
        ? parseRemoteSpeechModelFork(new TextDecoder().decode(stored.value))
        : null,
    ),
    Effect.mapError((cause) => new RemoteSpeechModelStoreErrorFork({ operation: "read", cause })),
  );
  const save = Effect.fn("RemoteSpeechModelStore.save")(function* (
    input: SpeechRemoteModelUpdateFork,
  ) {
    const baseUrl = apiRoot(input.baseUrl);
    const model = input.model.trim();
    if (!baseUrl || !model) return null;
    const previous = yield* read;
    const apiKey = input.apiKey?.trim() ?? (previous?.baseUrl === baseUrl ? previous.apiKey : "");
    const saved: RemoteSpeechModelFork = { baseUrl, model, live: input.live, apiKey };
    const encoded = yield* encodeJson(saved).pipe(
      Effect.mapError((cause) => new RemoteSpeechModelStoreErrorFork({ operation: "save", cause })),
    );
    yield* secrets
      .set(SECRET_NAME, new TextEncoder().encode(encoded))
      .pipe(
        Effect.mapError(
          (cause) => new RemoteSpeechModelStoreErrorFork({ operation: "save", cause }),
        ),
      );
    return saved;
  });
  const clear = secrets
    .remove(SECRET_NAME)
    .pipe(
      Effect.mapError(
        (cause) => new RemoteSpeechModelStoreErrorFork({ operation: "clear", cause }),
      ),
    );
  return RemoteSpeechModelStoreFork.of({ read, save, clear });
});

export const layer = Layer.effect(RemoteSpeechModelStoreFork, make);
