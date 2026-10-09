import {
  VoiceInputConfigFork,
  VoiceInputConfigUpdateFork,
  VoiceInputTranscriptFork,
  type VoiceInputSettingsFork,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { voiceInputProvidersFork } from "./providers.fork.ts";
import { isVoiceRecordingFork } from "./recording.fork.ts";
import { metaVoiceRequestFork, metaVoiceTranscriptFork } from "./meta.fork.ts";

export class VoiceInputError extends Schema.TaggedError<VoiceInputError>()("VoiceInputError", {
  reason: Schema.Literals([
    "settings",
    "storage",
    "disabled",
    "unsupported",
    "audio",
    "upstream",
    "response",
  ]),
  status: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "settings":
        return "Check the dictation endpoint and model.";
      case "storage":
        return "Could not load or save dictation settings.";
      case "disabled":
        return "Enable dictation in Settings first.";
      case "unsupported":
        return "This dictation provider is not implemented yet.";
      case "audio":
        return "Use a mono PCM16 WAV recording at 16 or 24 kHz, up to five minutes.";
      case "upstream":
        return this.status
          ? `Dictation provider returned HTTP ${this.status}.`
          : "Could not reach the dictation provider.";
      case "response":
        return "The dictation provider returned an invalid transcript.";
    }
  }
}

const StoredSettings = Schema.Struct({
  ...VoiceInputConfigFork.fields,
  provider: Schema.Union([VoiceInputConfigFork.fields.provider, Schema.Literal("promptletariat")]),
  apiKey: Schema.String,
});
const codec = Schema.fromJsonString(StoredSettings);
const decodeStoredSettings = (encoded: string) =>
  Schema.decodeEffect(codec)(encoded).pipe(
    Effect.map((config) => ({
      ...config,
      provider:
        config.provider === "promptletariat" ? ("openai-compatible" as const) : config.provider,
    })),
  );
const decodeConfigUpdate = Schema.decodeEffect(VoiceInputConfigUpdateFork);
const SECRET_NAME = "fork-voice-input";
const defaults = {
  enabled: false,
  provider: "meta",
  endpoint: "https://api.meta.ai/v1/asr/transcribe",
  model: "muse-voice-transcribe-1.0",
  apiKey: "",
} as const;

export class VoiceInput extends Context.Service<
  VoiceInput,
  {
    readonly settings: Effect.Effect<VoiceInputSettingsFork, VoiceInputError>;
    readonly configure: (
      input: VoiceInputConfigUpdateFork,
    ) => Effect.Effect<VoiceInputSettingsFork, VoiceInputError>;
    readonly transcribe: (audio: Uint8Array) => Effect.Effect<string, VoiceInputError>;
  }
>()("t3/voice-input/VoiceInput.fork/VoiceInput") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const client = yield* HttpClient.HttpClient;
  const writes = yield* Semaphore.make(1);

  const read = secrets.get(SECRET_NAME).pipe(
    Effect.mapError((cause) => new VoiceInputError({ reason: "storage", cause })),
    Effect.flatMap((stored) =>
      Option.isNone(stored)
        ? Effect.succeed(defaults)
        : decodeStoredSettings(new TextDecoder().decode(stored.value)).pipe(
            Effect.mapError((cause) => new VoiceInputError({ reason: "storage", cause })),
          ),
    ),
  );
  const publicSettings = ({
    apiKey,
    ...settings
  }: VoiceInputConfigFork & { apiKey: string }): VoiceInputSettingsFork => ({
    ...settings,
    hasApiKey: apiKey.length > 0,
    providers: voiceInputProvidersFork,
  });
  const configure = Effect.fn("VoiceInput.configure")(function* (
    input: VoiceInputConfigUpdateFork,
  ) {
    const config = yield* decodeConfigUpdate(input).pipe(
      Effect.mapError((cause) => new VoiceInputError({ reason: "settings", cause })),
    );
    const endpoint = yield* Effect.try({
      try: () => new URL(config.endpoint),
      catch: () => new VoiceInputError({ reason: "settings" }),
    });
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      (config.provider !== "local" && config.model.trim().length === 0)
    ) {
      return yield* new VoiceInputError({ reason: "settings" });
    }
    const previous = yield* read;
    const apiKey =
      config.apiKey?.trim() ??
      (config.provider === previous.provider && config.endpoint === previous.endpoint
        ? previous.apiKey
        : "");
    const saved = {
      enabled: config.enabled,
      provider: config.provider,
      endpoint: config.endpoint,
      model: config.model.trim(),
      apiKey,
    };
    const encoded = yield* Schema.encodeEffect(codec)(saved).pipe(
      Effect.mapError((cause) => new VoiceInputError({ reason: "storage", cause })),
    );
    yield* secrets
      .set(SECRET_NAME, new TextEncoder().encode(encoded))
      .pipe(Effect.mapError((cause) => new VoiceInputError({ reason: "storage", cause })));
    return publicSettings(saved);
  });

  const transcribe = Effect.fn("VoiceInput.transcribe")(function* (audio: Uint8Array) {
    const config = yield* read;
    if (!config.enabled) return yield* new VoiceInputError({ reason: "disabled" });
    if (!voiceInputProvidersFork.find((provider) => provider.id === config.provider)?.available) {
      return yield* new VoiceInputError({ reason: "unsupported" });
    }
    if (!isVoiceRecordingFork(audio)) return yield* new VoiceInputError({ reason: "audio" });
    let request =
      config.provider === "meta"
        ? metaVoiceRequestFork(config.endpoint, config.model, audio)
        : HttpClientRequest.post(config.endpoint);
    if (config.apiKey)
      request = HttpClientRequest.setHeader(request, "authorization", `Bearer ${config.apiKey}`);
    if (config.provider === "local") {
      request = HttpClientRequest.bodyUint8Array(request, audio, "audio/wav");
    } else if (config.provider === "openai-compatible") {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "dictation.wav");
      form.set("model", config.model);
      form.set("response_format", "json");
      request = HttpClientRequest.bodyFormData(request, form);
    }
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError((cause) => new VoiceInputError({ reason: "upstream", cause })));
    if (response.status < 200 || response.status >= 300) {
      return yield* new VoiceInputError({ reason: "upstream", status: response.status });
    }
    const text = yield* (
      config.provider === "meta"
        ? metaVoiceTranscriptFork(response)
        : HttpClientResponse.schemaBodyJson(VoiceInputTranscriptFork)(response).pipe(
            Effect.map((body) => body.text),
          )
    ).pipe(Effect.mapError((cause) => new VoiceInputError({ reason: "response", cause })));
    return text.trim();
  });
  return VoiceInput.of({
    settings: read.pipe(Effect.map(publicSettings)),
    configure: (input) => writes.withPermits(1)(configure(input)),
    transcribe: (audio) =>
      transcribe(audio).pipe(
        Effect.timeout("60 seconds"),
        Effect.mapError((cause) =>
          cause._tag === "TimeoutError"
            ? new VoiceInputError({ reason: "upstream", cause })
            : cause,
        ),
      ),
  });
});

export const layer = Layer.effect(VoiceInput, make);
