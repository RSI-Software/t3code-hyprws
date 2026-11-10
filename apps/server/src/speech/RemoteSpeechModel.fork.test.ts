import {
  DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  SPEECH_REMOTE_MODEL_ID_FORK,
  type EnvironmentSpeechModel,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteSpeechModel from "./RemoteSpeechModel.fork.ts";
import * as SpeechService from "./SpeechService.ts";

// The shape the fork's first dictation settings saved, still on disk for existing installs.
const legacy = {
  enabled: true,
  provider: "openai-compatible",
  endpoint: "https://speech.example/v1/audio/transcriptions",
  streamingEndpoint: "wss://speech.example/v1/realtime?intent=transcription",
  model: "nemo",
  apiKey: "private-key",
};
const localModel = {
  id: "local",
  active: true,
  languages: ["en"],
} as unknown as EnvironmentSpeechModel;
const options = {
  ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
  speechCustomWords: [{ term: "Promptletariat", aliases: ["prompt proletariat"] }],
};
const audio = new Uint8Array(new Float32Array([0, 0.5, -0.5, 0.25]).buffer);

const harness = Effect.fn(function* (stored: unknown = legacy) {
  const secrets = new Map<string, Uint8Array>([
    ["fork-voice-input", new TextEncoder().encode(JSON.stringify(stored))],
  ]);
  const settings = { speechModelId: "local" };
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const socket = {
    input: yield* Queue.make<string, Socket.SocketError>(),
    output: yield* Queue.make<string | Uint8Array | Socket.CloseEvent>(),
  };
  const opened: Array<{ url: string; headers: unknown }> = [];
  const layer = RemoteSpeechModel.layerFork((url, headers) =>
    Effect.sync(() => {
      opened.push({ url, headers });
      return Socket.make({
        reader: Effect.succeed({
          pull: Queue.take(socket.input).pipe(Effect.map((frame) => [frame] as const)),
          upgrade: () => Effect.void,
        }),
        writer: Effect.succeed({
          write: (frame) => Queue.offer(socket.output, frame).pipe(Effect.asVoid),
          writeAll: (frames) => Queue.offerAll(socket.output, frames).pipe(Effect.asVoid),
        }),
      });
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SpeechService.SpeechService)({
          models: () => Effect.succeed({ models: [localModel] }),
          transcribe: () => Effect.succeed("local text"),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.sync(
            () =>
              ({
                ...settings,
                speechAcceleration: "auto",
                speechModelUnloadTimeout: "min_15",
              }) as unknown as ServerSettingsValue,
          ),
          updateSettings: (patch) =>
            Effect.sync(() => {
              settings.speechModelId = patch.speechModelId ?? settings.speechModelId;
              return settings as unknown as ServerSettingsValue;
            }),
        }),
        Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
            set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
            create: () => Effect.die("not used"),
            getOrCreateRandom: () => Effect.die("not used"),
            remove: (name) => Effect.sync(() => void secrets.delete(name)),
          }),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests.push(request);
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ text: " prompt proletariat works " }),
              );
            }),
          ),
        ),
      ),
    ),
  );
  const run = <A, E, R>(
    use: (service: SpeechService.SpeechService["Service"]) => Effect.Effect<A, E, R>,
  ) => Effect.flatMap(SpeechService.SpeechService, use).pipe(Effect.provide(layer));
  return { settings, requests, socket, opened, run };
});

describe("remote speech model", () => {
  it.each([
    {
      name: "legacy endpoints",
      stored: legacy,
      expected: { baseUrl: "https://speech.example/v1", live: true },
    },
    {
      name: "base URL settings",
      stored: {
        provider: "openai-compatible",
        baseUrl: "https://speech.example/v1/",
        live: false,
        model: "nemo",
        apiKey: "",
      },
      expected: { baseUrl: "https://speech.example/v1", live: false },
    },
    { name: "Meta", stored: { ...legacy, provider: "meta" }, expected: null },
    {
      name: "a URL with a query",
      stored: { ...legacy, endpoint: "https://speech.example/v1?x=1" },
      expected: null,
    },
  ])("reads $name", ({ stored, expected }) => {
    const parsed = RemoteSpeechModel.parseRemoteSpeechModelFork(JSON.stringify(stored));
    expect(parsed && { baseUrl: parsed.baseUrl, live: parsed.live }).toEqual(expected);
  });

  it.effect("transcribes locally until the remote model is selected", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.run((speech) =>
        Effect.gen(function* () {
          expect(
            (yield* speech.models(false)).models.map(({ id, active }) => [id, active]),
          ).toEqual([
            [SPEECH_REMOTE_MODEL_ID_FORK, false],
            ["local", true],
          ]);
          expect(yield* speech.transcribe(audio, options)).toBe("local text");

          const selected = yield* speech.selectModel(SPEECH_REMOTE_MODEL_ID_FORK);
          expect(h.settings.speechModelId).toBe(SPEECH_REMOTE_MODEL_ID_FORK);
          expect(selected.models.map(({ active }) => active)).toEqual([true, false]);
          expect(yield* speech.transcribe(audio, options)).toBe("Promptletariat works");

          const [request] = h.requests;
          expect(request?.url).toBe("https://speech.example/v1/audio/transcriptions");
          expect(request?.headers.authorization).toBe("Bearer private-key");
          const form = request?.body._tag === "FormData" ? request.body.formData : undefined;
          expect([form?.get("model"), form?.get("prompt")]).toEqual(["nemo", "Promptletariat"]);
        }),
      );
    }),
  );

  it.effect("relays a live recording over OpenAI Realtime", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.settings.speechModelId = SPEECH_REMOTE_MODEL_ID_FORK;
      yield* h.run((speech) =>
        Effect.gen(function* () {
          const starting = yield* speech.startStream(options).pipe(Effect.forkChild);
          const session = String(yield* Queue.take(h.socket.output));
          expect(JSON.parse(session).session.audio.input.transcription).toEqual({
            model: "nemo",
            prompt: "Promptletariat",
          });
          expect(h.opened).toEqual([
            {
              url: "wss://speech.example/v1/realtime?intent=transcription",
              headers: { authorization: "Bearer private-key" },
            },
          ]);
          yield* Queue.offer(h.socket.input, '{"type":"session.updated"}');
          const stream = yield* Fiber.join(starting);

          yield* stream.feed(audio);
          const append = JSON.parse(String(yield* Queue.take(h.socket.output)));
          expect(append.type).toBe("input_audio_buffer.append");
          // Four 16 kHz samples, minus the one held back to interpolate, become five at 24 kHz.
          expect(Buffer.from(append.audio, "base64").byteLength).toBe(10);

          const finishing = yield* stream.finish.pipe(Effect.forkChild);
          expect(yield* Queue.take(h.socket.output)).toBe('{"type":"input_audio_buffer.commit"}');
          yield* Queue.offer(
            h.socket.input,
            '{"type":"conversation.item.input_audio_transcription.completed","transcript":"prompt proletariat works"}',
          );
          expect(yield* Fiber.join(finishing)).toBe("Promptletariat works");
        }).pipe(Effect.scoped),
      );
    }),
  );
});
