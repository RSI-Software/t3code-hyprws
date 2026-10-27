import type { VoiceInputConfigUpdateFork, VoiceTextSettingsFork } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Socket from "effect/socket/Socket";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VoiceInput from "./VoiceInput.fork.ts";
import * as VoiceText from "./VoiceText.fork.ts";

function recording(rate = 16000) {
  const audio = new Uint8Array(44 + rate * 2);
  const view = new DataView(audio.buffer);
  const tag = (at: number, value: string) => audio.set(new TextEncoder().encode(value), at);
  tag(0, "RIFF");
  view.setUint32(4, audio.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, rate * 2, true);
  return audio;
}
const openai: VoiceInputConfigUpdateFork = {
  enabled: true,
  provider: "openai-compatible",
  baseUrl: "http://127.0.0.1:8788/v1",
  live: false,
  model: "nemo",
};
const meta = {
  enabled: true,
  provider: "meta",
  baseUrl: "https://api.meta.ai/v1",
  live: true,
  model: "muse-voice-transcribe-1.0",
} satisfies VoiceInputConfigUpdateFork;
const silentSocket = Socket.make({
  reader: Effect.succeed({ pull: Effect.never, upgrade: () => Effect.void }),
  writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
});

function harness(
  body: unknown = { text: " spoken words " },
  status = 200,
  customClient?: HttpClient.HttpClient,
) {
  const stored = new Map<string, Uint8Array>();
  const speech = { defaults: { terms: "" }, projects: {} as Record<string, { terms: string }> };
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(stored.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        stored.set(name, value);
      }),
    create: () => Effect.die("not used"),
    getOrCreateRandom: () => Effect.die("not used"),
    remove: (name) =>
      Effect.sync(() => {
        stored.delete(name);
      }),
  });
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  const layer = VoiceInput.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerSecretStore.ServerSecretStore, secrets),
        Layer.succeed(HttpClient.HttpClient, customClient ?? client),
        Layer.mock(VoiceText.VoiceText)({
          settings: Effect.sync(() => speech as unknown as VoiceTextSettingsFork),
        }),
      ),
    ),
  );
  const run = <A, E, R = never>(
    use: (service: VoiceInput.VoiceInput["Service"]) => Effect.Effect<A, E, R>,
  ) => Effect.flatMap(VoiceInput.VoiceInput, use).pipe(Effect.provide(layer));
  return { stored, requests, speech, run };
}

describe("external dictation service", () => {
  it.effect.each([
    {
      legacy: {
        provider: "promptletariat",
        endpoint: "https://stt.example/v1/",
        streamingEndpoint: "wss://stt.example/v1/realtime?intent=transcription",
      },
      expected: { baseUrl: "https://stt.example/v1", live: true, enabled: true },
    },
    {
      legacy: {
        provider: "groq",
        endpoint: " https://stt.example/v1/audio/transcriptions/ ",
        streamingEndpoint: "",
      },
      expected: { baseUrl: "https://stt.example/v1", live: false, enabled: true },
    },
    {
      // Meta settings from before streaming URLs.
      legacy: { provider: "meta", endpoint: "https://api.meta.ai/v1/asr/transcribe" },
      expected: { provider: "meta", baseUrl: "https://api.meta.ai/v1", live: true, enabled: true },
    },
    {
      // Local HTTP posted a different body; it waits for reconfiguring.
      legacy: { provider: "local", endpoint: "http://127.0.0.1:8080/transcribe" },
      expected: { baseUrl: "http://127.0.0.1:8080/transcribe", enabled: false },
    },
    {
      legacy: {
        provider: "openai",
        endpoint: "https://stt.example/v1/audio/transcriptions?api-version=1",
      },
      expected: { enabled: false },
    },
  ])("migrates $legacy.provider URL settings and keeps the saved key", ({ legacy, expected }) =>
    Effect.gen(function* () {
      const h = harness();
      h.stored.set(
        "fork-voice-input",
        new TextEncoder().encode(
          JSON.stringify({ enabled: true, model: "m", apiKey: "legacy-secret", ...legacy }),
        ),
      );
      const settings = yield* h.run((s) => s.settings);
      expect(settings).toMatchObject({
        provider: "openai-compatible",
        ...expected,
        hasApiKey: true,
      });
      expect(JSON.stringify(settings)).not.toContain("legacy-secret");
    }),
  );
  it.effect("bounds provider latency and interrupts pending requests", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let released = false;
      const client = HttpClient.make(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            }),
          ),
        ),
      );
      const h = harness(undefined, 200, client);
      yield* h.run((s) => s.configure(openai));
      const pending = yield* h
        .run((s) => s.transcribe(recording()))
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust("61 seconds");
      expect(yield* Fiber.join(pending)).toMatchObject({ reason: "upstream" });
      expect(released).toBe(true);
    }),
  );
  it.effect("uses Meta's JSON request and WAV audio parts and reads transcript", () =>
    Effect.gen(function* () {
      const h = harness({ transcript: " meta words " });
      const audio = recording();
      const text = yield* h.run((s) =>
        Effect.gen(function* () {
          yield* s.configure({ ...meta, apiKey: "meta-key" });
          return yield* s.transcribe(audio);
        }),
      );
      expect(text).toBe("meta words");
      expect(h.requests[0]?.url).toBe("https://api.meta.ai/v1/asr/transcribe");
      expect(h.requests[0]?.headers.authorization).toBe("Bearer meta-key");
      const body = h.requests[0]?.body;
      if (body?._tag !== "FormData") throw new Error("Expected Meta multipart upload");
      const request = body.formData.get("request");
      const file = body.formData.get("audio");
      if (!(request instanceof Blob) || !(file instanceof Blob))
        throw new Error("Expected JSON and WAV parts");
      expect(request.type).toBe("application/json");
      expect(JSON.parse(yield* Effect.promise(() => request.text()))).toEqual({
        model: "muse-voice-transcribe-1.0",
        audioEncoding: "WAV",
        mode: "PUSH_TO_TALK",
      });
      expect(file.type).toBe("audio/wav");
      expect(new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))).toEqual(audio);
      expect(body.formData.has("file")).toBe(false);
    }),
  );
  it.effect.each([{ text: "wrong response shape" }, { transcript: 42 }])(
    "rejects invalid Meta responses",
    (body) =>
      Effect.gen(function* () {
        const h = harness(body);
        yield* h.run((s) => s.configure(meta));
        expect(yield* h.run((s) => s.transcribe(recording())).pipe(Effect.flip)).toMatchObject({
          reason: "response",
        });
      }),
  );
  it.effect("starts disabled and redacts keys", () =>
    Effect.gen(function* () {
      const h = harness();
      expect(yield* h.run((s) => s.settings)).toMatchObject({ enabled: false, hasApiKey: false });
      const settings = yield* h.run((s) => s.configure({ ...openai, apiKey: "test-secret" }));
      expect(settings.hasApiKey).toBe(true);
      expect(JSON.stringify(settings)).not.toContain("test-secret");
      expect(settings).not.toHaveProperty("apiKey");
    }),
  );
  it.effect("uploads OpenAI multipart below the base URL with optional bearer auth", () =>
    Effect.gen(function* () {
      const h = harness();
      const text = yield* h.run((s) =>
        Effect.gen(function* () {
          yield* s.configure({ ...openai, baseUrl: "http://127.0.0.1:8788/v1/" });
          return yield* s.transcribe(recording());
        }),
      );
      expect(text).toBe("spoken words");
      expect(h.requests[0]?.url).toBe("http://127.0.0.1:8788/v1/audio/transcriptions");
      expect(h.requests[0]?.headers.authorization).toBeUndefined();
      const body = h.requests[0]?.body;
      if (body?._tag !== "FormData") throw new Error("Expected upload");
      expect(body.formData.get("model")).toBe("nemo");
      expect(body.formData.get("response_format")).toBe("json");
      expect(body.formData.get("file")).toBeInstanceOf(Blob);
    }),
  );
  it.effect("sends project terms as the prompt and applies their spelling rules", () =>
    Effect.gen(function* () {
      const h = harness({ text: " Cube  control, then CUBECTOL and cubectoland. " });
      h.speech.defaults.terms = "shared";
      h.speech.projects.p1 = {
        terms: "cube control, cubectol -> kubectl\n\n Hyprland \nVec<T>\nfive words is too long",
      };
      const texts = yield* h.run((s) =>
        Effect.gen(function* () {
          yield* s.configure(openai);
          return [yield* s.transcribe(recording(), "p1"), yield* s.transcribe(recording(), "gone")];
        }),
      );
      const [project, shared] = h.requests.map((request) =>
        request.body._tag === "FormData" ? request.body.formData : new FormData(),
      );
      // Only standard fields; one entry over four words would make the list read as prose.
      expect([...(project?.keys() ?? [])].toSorted()).toEqual([
        "file",
        "model",
        "prompt",
        "response_format",
      ]);
      expect(project?.get("prompt")).toBe("kubectl, Hyprland, Vec<T>");
      expect(shared?.get("prompt")).toBe("shared");
      expect(texts).toEqual([
        "kubectl, then kubectl and cubectoland.",
        "Cube  control, then CUBECTOL and cubectoland.",
      ]);
    }),
  );
  it.effect("retains keys only for the same destination and supports removal", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run((s) =>
        Effect.gen(function* () {
          yield* s.configure({ ...openai, apiKey: "original" });
          expect((yield* s.configure({ ...openai, live: true, model: "other" })).hasApiKey).toBe(
            true,
          );
          expect(
            (yield* s.configure({ ...openai, baseUrl: "http://localhost:9000/v1" })).hasApiKey,
          ).toBe(false);
          yield* s.configure({ ...openai, apiKey: "original" });
          expect((yield* s.configure({ ...openai, apiKey: "" })).hasApiKey).toBe(false);
        }),
      );
    }),
  );
  it.effect("refuses a disabled service before any request", () =>
    Effect.gen(function* () {
      const h = harness();
      expect(yield* h.run((s) => s.transcribe(recording())).pipe(Effect.flip)).toMatchObject({
        reason: "disabled",
      });
      expect(h.requests).toHaveLength(0);
    }),
  );
  it.effect.each([
    { baseUrl: "file:///tmp/audio" },
    { baseUrl: "wss://example.com/v1" },
    { baseUrl: "https://user:password@example.com/v1" },
    { baseUrl: "https://example.com/v1?key=secret" },
    { baseUrl: "https://example.com/#token" },
    { baseUrl: "https://example.com/v1?" },
    { baseUrl: "https://example.com/v1#" },
    { model: " " },
  ])("rejects unsafe settings %o", (fields) =>
    Effect.gen(function* () {
      const h = harness();
      expect(
        yield* h.run((s) => s.configure({ ...openai, ...fields })).pipe(Effect.flip),
      ).toMatchObject({ reason: "settings" });
      expect(h.stored.size).toBe(0);
    }),
  );
  it.effect.each([new Uint8Array(0), new Uint8Array(100), recording(48000)])(
    "refuses invalid recordings",
    (audio) =>
      Effect.gen(function* () {
        const h = harness();
        yield* h.run((s) => s.configure(openai));
        expect(yield* h.run((s) => s.transcribe(audio)).pipe(Effect.flip)).toMatchObject({
          reason: "audio",
        });
        expect(h.requests).toHaveLength(0);
      }),
  );
  it.effect("reports status without private provider details", () =>
    Effect.gen(function* () {
      const h = harness({ error: "private detail" }, 401);
      yield* h.run((s) => s.configure(openai));
      expect((yield* h.run((s) => s.transcribe(recording())).pipe(Effect.flip)).message).toBe(
        "Dictation provider returned HTTP 401.",
      );
    }),
  );
  it.effect("rejects invalid transcripts and accepts empty speech", () =>
    Effect.gen(function* () {
      const invalid = harness({ text: 42 });
      yield* invalid.run((s) => s.configure(openai));
      expect(yield* invalid.run((s) => s.transcribe(recording())).pipe(Effect.flip)).toMatchObject({
        reason: "response",
      });
      const empty = harness({ text: " " });
      yield* empty.run((s) => s.configure(openai));
      expect(yield* empty.run((s) => s.transcribe(recording()))).toBe("");
    }),
  );
  it.effect.each([
    {
      config: { ...openai, live: true },
      url: "ws://127.0.0.1:8788/v1/realtime?intent=transcription",
      headers: { authorization: "Bearer stream-key" },
      start: '"transcription":{"model":"nemo","prompt":"kubectl"}',
    },
    {
      config: meta,
      url: "wss://api.meta.ai/v1/asr/realtime",
      headers: undefined,
      start: '"accessToken":"Bearer stream-key"',
    },
  ] as const)("opens $config.provider's streaming socket with its key", ({ config, ...expected }) =>
    Effect.gen(function* () {
      const h = harness();
      h.speech.defaults.terms = "kubectl";
      yield* h.run((s) => s.configure({ ...config, apiKey: "stream-key" }));
      const opened = Promise.withResolvers<{ url: string; options: unknown; start: unknown }>();
      const upstream = Layer.succeed(Socket.WebSocketConstructor, (url, options) => ({
        readyState: 1,
        addEventListener: () => {},
        removeEventListener: () => {},
        close: () => {},
        send: (start) => opened.resolve({ url, options, start }),
      }));
      const fiber = yield* h
        .run((s) => s.stream(silentSocket))
        .pipe(Effect.scoped, Effect.provide(upstream), Effect.forkChild);
      const { url, options, start } = yield* Effect.promise(() => opened.promise);
      yield* Fiber.interrupt(fiber);
      expect(url).toBe(expected.url);
      expect(options).toEqual(
        expected.headers ? { protocols: undefined, headers: expected.headers } : undefined,
      );
      expect(start).toContain(expected.start);
    }),
  );
  it.effect("refuses a live socket while live preview is off", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run((s) => s.configure(openai));
      expect(
        yield* h
          .run((s) => s.stream(silentSocket))
          .pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal), Effect.flip),
      ).toMatchObject({ reason: "live" });
    }),
  );
});
