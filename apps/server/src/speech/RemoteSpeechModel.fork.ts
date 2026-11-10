// Fork-only: an OpenAI-compatible transcription service offered as one more model on upstream's
// SpeechService, so every client's environment dictation, live preview included, reaches it.
import {
  SPEECH_REMOTE_MODEL_ID_FORK,
  type EnvironmentSpeechModel,
  type SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { applySpeechAliases } from "./customWords.ts";
import { removeSpeechFillerWords } from "./fillerWords.ts";
import * as RemoteSpeechModelStore from "./RemoteSpeechModelStore.fork.ts";
import * as SpeechService from "./SpeechService.ts";

type RemoteSpeechModelFork = RemoteSpeechModelStore.RemoteSpeechModelFork;

const Transcript = Schema.Struct({ text: Schema.String });
const RealtimeEvent = Schema.Struct({
  type: Schema.String,
  delta: Schema.optionalKey(Schema.String),
  transcript: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
});
const decodeRealtimeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RealtimeEvent));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

function pcm16(samples: Float32Array) {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  samples.forEach((sample, index) =>
    view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true),
  );
  return new Uint8Array(view.buffer);
}

function wav(samples: Float32Array) {
  const data = pcm16(samples);
  const header = new DataView(new ArrayBuffer(44));
  const tag = (at: number, value: string) =>
    [...value].forEach((char, index) => header.setUint8(at + index, char.charCodeAt(0)));
  tag(0, "RIFF");
  header.setUint32(4, 36 + data.byteLength, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, 16_000, true);
  header.setUint32(28, 32_000, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  tag(36, "data");
  header.setUint32(40, data.byteLength, true);
  return new Blob([header.buffer, data], { type: "audio/wav" });
}

/** Linear 16 → 24 kHz PCM16 for OpenAI Realtime; each frame holds back its last sample to interpolate across the boundary. */
function upsamplePcmFork() {
  const step = 16000 / 24000;
  let previous = 0;
  let position = 1;
  return (pcm: Uint8Array) => {
    const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const count = pcm.byteLength / 2;
    const at = (i: number) => (i === 0 ? previous : input.getInt16((i - 1) * 2, true));
    const output = new DataView(new ArrayBuffer((Math.ceil((count - position) / step) + 1) * 2));
    let written = 0;
    for (; position < count; position += step) {
      const i = Math.floor(position);
      const sample = at(i) + (at(i + 1) - at(i)) * (position - i);
      output.setInt16(written++ * 2, Math.round(sample), true);
    }
    position -= count;
    if (count) previous = at(count);
    return new Uint8Array(output.buffer, 0, written * 2);
  };
}

/** Terms go out as the standard `prompt`; aliases apply afterwards, so any service gets them. */
const vocabulary = (options: SpeechTranscriptionOptions) =>
  options.speechCustomWords
    .map(({ term }) => term)
    .join(", ")
    .slice(0, 4096);

const finalize = (text: string, options: SpeechTranscriptionOptions) => {
  const corrected = applySpeechAliases(text, options.speechCustomWords);
  return (
    options.speechRemoveFillerWords
      ? removeSpeechFillerWords(corrected, options.speechLanguage, options.speechCorrectionWord)
      : corrected
  ).trim();
};

const isInvalidAudio = Schema.is(SpeechService.SpeechInvalidAudioError);
const decodePcm = (bytes: Uint8Array) =>
  Effect.try({
    try: () => SpeechService.decodeSpeechPcm(bytes),
    catch: (cause) =>
      isInvalidAudio(cause)
        ? cause
        : new SpeechService.SpeechOperationError({ operation: "decode", cause }),
  });

const hostOf = (baseUrl: string) => new URL(baseUrl).host;

/** Lists every catalog language, so no language filter hides the remote service. */
function remoteModelEntry(
  remote: RemoteSpeechModelFork,
  active: boolean,
  languages: ReadonlyArray<string>,
): EnvironmentSpeechModel {
  return {
    id: SPEECH_REMOTE_MODEL_ID_FORK,
    name: remote.model,
    description: `Runs on ${hostOf(remote.baseUrl)}. This environment forwards your recording there.`,
    size: 0,
    languages: [...languages],
    accuracy: 0,
    speed: 0,
    recommended: false,
    supportsStreaming: remote.live,
    supportsLanguageDetection: true,
    supportsTranslation: false,
    active,
    state: "installed",
  };
}

/** Opens the provider's Realtime socket; tests substitute a scripted one. */
export type OpenRealtimeSocketFork = (
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
) => Effect.Effect<Socket.Socket, never, Scope.Scope>;

// `ws` stays on HTTP/1.1; undici's HTTP/2 WebSocket rejects some valid provider handshakes.
const openRealtimeSocket: OpenRealtimeSocketFork = (url, headers) =>
  Socket.makeWebSocket(url, { openTimeout: "10 seconds", ...(headers ? { headers } : {}) }).pipe(
    Effect.provide(NodeWS.layerWebSocketConstructor),
  );

const make = Effect.fn("RemoteSpeechModel.make")(function* (openSocket: OpenRealtimeSocketFork) {
  const local = yield* SpeechService.SpeechService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
  const store = yield* RemoteSpeechModelStore.RemoteSpeechModelStoreFork;
  // Removal restores the remote selection after upstream replaces it; a selection must not interleave.
  const selection = yield* Semaphore.make(1);

  /** The remote service, when this environment has it configured and selected. */
  const selected = Effect.gen(function* () {
    const { speechModelId } = yield* settings.getSettings;
    if (speechModelId !== SPEECH_REMOTE_MODEL_ID_FORK) return null;
    return yield* store.read;
  }).pipe(
    Effect.mapError(
      (cause) => new SpeechService.SpeechOperationError({ operation: "settings", cause }),
    ),
  );

  const models = Effect.fn("RemoteSpeechModel.models")(function* (includeBenchmarks: boolean) {
    const remote = yield* store.read.pipe(
      Effect.mapError(
        (cause) => new SpeechService.SpeechOperationError({ operation: "model listing", cause }),
      ),
    );
    const active = remote !== null && (yield* selected) !== null;
    const { models } = yield* local.models(includeBenchmarks);
    if (!remote) return { models };
    return {
      models: [
        remoteModelEntry(remote, active, [...new Set(models.flatMap((model) => model.languages))]),
        ...models.map((model) => (active ? { ...model, active: false } : model)),
      ],
    };
  });

  const selectRemote = (operation: string) =>
    settings
      .updateSettings({ speechModelId: SPEECH_REMOTE_MODEL_ID_FORK })
      .pipe(
        Effect.mapError((cause) => new SpeechService.SpeechOperationError({ operation, cause })),
      );

  const transcribeRemote = Effect.fn("RemoteSpeechModel.transcribe")(
    function* (
      remote: RemoteSpeechModelFork,
      bytes: Uint8Array,
      options: SpeechTranscriptionOptions,
    ) {
      const samples = yield* decodePcm(bytes);
      if (samples.length === 0) return "";
      const form = new FormData();
      form.set("file", wav(samples), "dictation.wav");
      form.set("model", remote.model);
      form.set("response_format", "json");
      if (options.speechLanguage !== "auto") form.set("language", options.speechLanguage);
      const prompt = vocabulary(options);
      if (prompt) form.set("prompt", prompt);
      let request = HttpClientRequest.post(`${remote.baseUrl}/audio/transcriptions`).pipe(
        HttpClientRequest.bodyFormData(form),
      );
      if (remote.apiKey) request = request.pipe(HttpClientRequest.bearerToken(remote.apiKey));
      const response = yield* http.execute(request);
      if (response.status < 200 || response.status >= 300)
        return yield* new SpeechService.SpeechOperationError({
          operation: "transcription",
          cause: `HTTP ${response.status}`,
        });
      const { text } = yield* HttpClientResponse.schemaBodyJson(Transcript)(response);
      return finalize(text, options);
    },
    (effect) =>
      effect.pipe(
        Effect.timeout("2 minutes"),
        Effect.mapError((cause) =>
          cause._tag === "SpeechInvalidAudioError" || cause._tag === "SpeechOperationError"
            ? cause
            : new SpeechService.SpeechOperationError({ operation: "transcription", cause: cause }),
        ),
      ),
  );

  const streamRemote = Effect.fn("RemoteSpeechModel.stream")(
    function* (remote: RemoteSpeechModelFork, options: SpeechTranscriptionOptions) {
      const socket = yield* openSocket(
        `${remote.baseUrl.replace(/^http/, "ws")}/realtime?intent=transcription`,
        remote.apiKey ? { authorization: `Bearer ${remote.apiKey}` } : undefined,
      );
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const prompt = vocabulary(options);
      yield* writer.write(
        yield* encodeJson({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: {
                  model: remote.model,
                  ...(options.speechLanguage === "auto"
                    ? {}
                    : { language: options.speechLanguage }),
                  ...(prompt ? { prompt } : {}),
                },
                turn_detection: null,
              },
            },
          },
        }),
      );
      const ready = yield* Deferred.make<void, SpeechService.SpeechOperationError>();
      const final = yield* Deferred.make<string, SpeechService.SpeechOperationError>();
      const fail = (detail: unknown) => {
        const error = new SpeechService.SpeechOperationError({
          operation: "live transcription",
          cause: detail,
        });
        return Deferred.fail(ready, error).pipe(Effect.andThen(Deferred.fail(final, error)));
      };
      let preview = "";
      let revision = 0;
      yield* Effect.gen(function* () {
        while (true) {
          for (const frame of yield* reader.pull) {
            const event = Option.getOrUndefined(
              decodeRealtimeEvent(
                typeof frame === "string" ? frame : new TextDecoder().decode(frame),
              ),
            );
            switch (event?.type) {
              case "session.updated":
                yield* Deferred.succeed(ready, undefined);
                break;
              case "conversation.item.input_audio_transcription.delta":
                preview += event.delta ?? "";
                revision += 1;
                break;
              case "conversation.item.input_audio_transcription.completed":
                yield* Deferred.succeed(final, event.transcript ?? preview);
                break;
              case "conversation.item.input_audio_transcription.failed":
              case "error":
                // The provider's message names the wrong model, key, or route.
                yield* fail(event.error?.message?.trim().slice(0, 200) ?? event.type);
            }
          }
        }
      }).pipe(Effect.catch(fail), Effect.forkScoped);
      // A cold model can take a while to load; the client holds audio until ready.
      yield* Deferred.await(ready).pipe(Effect.timeout("2 minutes"));
      const upsample = upsamplePcmFork();
      const stream: SpeechService.SpeechStream = {
        feed: (bytes) =>
          decodePcm(bytes).pipe(
            Effect.flatMap((samples) =>
              encodeJson({
                type: "input_audio_buffer.append",
                audio: Buffer.from(upsample(pcm16(samples))).toString("base64"),
              }),
            ),
            Effect.flatMap((frame) => writer.write(frame)),
            Effect.mapError((cause) =>
              cause._tag === "SpeechInvalidAudioError" || cause._tag === "SpeechOperationError"
                ? cause
                : new SpeechService.SpeechOperationError({
                    operation: "live transcription",
                    cause: cause,
                  }),
            ),
            Effect.as({
              revision,
              text: preview ? { committed: "", tentative: preview } : null,
            }),
          ),
        finish: writer.write('{"type":"input_audio_buffer.commit"}').pipe(
          Effect.andThen(Deferred.await(final)),
          Effect.timeout("60 seconds"),
          Effect.map((text) => finalize(text, options)),
          Effect.mapError((cause) =>
            cause._tag === "SpeechOperationError"
              ? cause
              : new SpeechService.SpeechOperationError({
                  operation: "live transcription",
                  cause: cause,
                }),
          ),
        ),
      };
      return stream;
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause._tag === "SpeechOperationError"
            ? cause
            : new SpeechService.SpeechOperationError({
                operation: "live transcription",
                cause: cause,
              }),
        ),
      ),
  );

  const status = Effect.gen(function* () {
    const remote = yield* selected;
    if (!remote) return yield* local.status;
    const { speechAcceleration, speechModelUnloadTimeout } = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new SpeechService.SpeechOperationError({ operation: "status", cause }),
      ),
    );
    return {
      supported: true as const,
      state: "ready" as const,
      modelId: SPEECH_REMOTE_MODEL_ID_FORK,
      model: remote.model,
      size: 0,
      supportsStreaming: remote.live,
      supportsBufferedStreaming: remote.live,
      supportsTranslation: false,
      supportsLanguageDetection: true,
      acceleration: speechAcceleration,
      benchmarkTier: "accelerated" as const,
      modelUnloadTimeout: speechModelUnloadTimeout,
      gpuDevices: [],
    };
  });

  // No spread: a method upstream adds fails the typecheck rather than skipping the remote model.
  return SpeechService.SpeechService.of({
    status,
    models,
    // Upstream calls answer with its own catalog; every model change answers with the wrapped one.
    downloadModel: Effect.fn("RemoteSpeechModel.downloadModel")(function* (modelId: string) {
      yield* local.downloadModel(modelId);
      return yield* models(false);
    }),
    linkModels: Effect.fn("RemoteSpeechModel.linkModels")(function* (source: string) {
      const remote = yield* selected;
      yield* local.linkModels(source);
      if (remote) yield* selectRemote("model linking");
      return yield* models(false);
    }, selection.withPermits(1)),
    cancelDownload: Effect.fn("RemoteSpeechModel.cancelDownload")(function* (modelId: string) {
      yield* local.cancelDownload(modelId);
      return yield* models(false);
    }),
    selectModel: Effect.fn("RemoteSpeechModel.selectModel")(function* (modelId: string) {
      if (modelId !== SPEECH_REMOTE_MODEL_ID_FORK) {
        yield* local.selectModel(modelId);
        return yield* models(false);
      }
      const remote = yield* store.read.pipe(
        Effect.mapError(
          (cause) =>
            new SpeechService.SpeechOperationError({ operation: "model selection", cause }),
        ),
      );
      if (!remote) return yield* new SpeechService.SpeechModelNotFoundError({ modelId });
      yield* selectRemote("model selection");
      return yield* models(false);
    }, selection.withPermits(1)),
    // Removing the remote model forgets the service; the selection falls back to the default model.
    removeModel: Effect.fn("RemoteSpeechModel.removeModel")(function* (modelId: string) {
      if (modelId === SPEECH_REMOTE_MODEL_ID_FORK) {
        yield* store.clear.pipe(
          Effect.mapError(
            (cause) =>
              new SpeechService.SpeechOperationError({ operation: "model removal", cause }),
          ),
        );
        return yield* models(false);
      }
      const remote = yield* selected;
      yield* local.removeModel(modelId);
      // Upstream reads the remote id as its default model, and replaces it when that model goes.
      if (remote) yield* selectRemote("model removal");
      return yield* models(false);
    }, selection.withPermits(1)),
    prepareModel: Effect.flatMap(selected, (remote) => (remote ? Effect.void : local.prepareModel)),
    transcribe: Effect.fn("RemoteSpeechModel.route")(function* (
      bytes: Uint8Array,
      options: SpeechTranscriptionOptions,
    ) {
      const remote = yield* selected;
      return yield* remote
        ? transcribeRemote(remote, bytes, options)
        : local.transcribe(bytes, options);
    }),
    startStream: Effect.fn("RemoteSpeechModel.startStream")(function* (
      options: SpeechTranscriptionOptions,
    ) {
      const remote = yield* selected;
      return yield* remote ? streamRemote(remote, options) : local.startStream(options);
    }),
    // Upstream answers with its local model's status; the selection may be the remote one.
    updateAcceleration: Effect.fn("RemoteSpeechModel.updateAcceleration")(function* (acceleration) {
      yield* local.updateAcceleration(acceleration);
      return yield* status;
    }),
    updateModelUnloadTimeout: Effect.fn("RemoteSpeechModel.updateModelUnloadTimeout")(
      function* (timeout) {
        yield* local.updateModelUnloadTimeout(timeout);
        return yield* status;
      },
    ),
  });
});

/** Wraps upstream's layer, keeping its own dependencies on the outer context. */
export const layer = (openSocket: OpenRealtimeSocketFork) =>
  Layer.effect(SpeechService.SpeechService, make(openSocket));

export const wrapSpeechServiceFork = <E, R>(
  upstream: Layer.Layer<SpeechService.SpeechService, E, R>,
) =>
  layer(openRealtimeSocket).pipe(
    Layer.provide(upstream),
    Layer.provide(RemoteSpeechModelStore.layer),
    Layer.provide(ServerSecretStore.layer),
  );
