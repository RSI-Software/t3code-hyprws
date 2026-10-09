import type { VoiceInputConfigUpdateFork } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VoiceInput from "./VoiceInput.fork.ts";

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
const local: VoiceInputConfigUpdateFork = {
  enabled: true,
  provider: "local",
  endpoint: "http://127.0.0.1:8788/transcribe",
  model: "",
};

function harness(body: unknown = { text: " spoken words " }, status = 200) {
  const stored = new Map<string, Uint8Array>();
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
        Layer.succeed(HttpClient.HttpClient, client),
      ),
    ),
  );
  const run = <A, E>(use: (service: VoiceInput.VoiceInput["Service"]) => Effect.Effect<A, E>) =>
    Effect.flatMap(VoiceInput.VoiceInput, use).pipe(Effect.provide(layer));
  return { stored, requests, run };
}

describe("external dictation service", () => {
  it.effect("reads the previous custom-service identifier without losing its saved key", () =>
    Effect.gen(function* () {
      const h = harness();
      h.stored.set(
        "fork-voice-input",
        new TextEncoder().encode(
          JSON.stringify({
            ...local,
            provider: "promptletariat",
            model: "whisper",
            apiKey: "legacy-secret",
          }),
        ),
      );
      const settings = yield* h.run((s) => s.settings);
      expect(settings).toMatchObject({
        provider: "openai-compatible",
        hasApiKey: true,
        enabled: true,
      });
      expect(JSON.stringify(settings)).not.toContain("legacy-secret");
      yield* h.run((s) => s.transcribe(recording()));
      expect(h.requests[0]?.headers.authorization).toBe("Bearer legacy-secret");
    }),
  );
  it.effect("starts disabled and redacts keys", () =>
    Effect.gen(function* () {
      const h = harness();
      expect(yield* h.run((s) => s.settings)).toMatchObject({ enabled: false, hasApiKey: false });
      const settings = yield* h.run((s) => s.configure({ ...local, apiKey: "test-secret" }));
      expect(settings.hasApiKey).toBe(true);
      expect(JSON.stringify(settings)).not.toContain("test-secret");
      expect(settings).not.toHaveProperty("apiKey");
    }),
  );
  it.effect("uploads raw WAV with optional bearer auth", () =>
    Effect.gen(function* () {
      const h = harness();
      const audio = recording();
      const text = yield* h.run((s) =>
        Effect.gen(function* () {
          yield* s.configure({ ...local, apiKey: "local-key" });
          return yield* s.transcribe(audio);
        }),
      );
      expect(text).toBe("spoken words");
      expect(h.requests[0]?.url).toBe(local.endpoint);
      expect(h.requests[0]?.headers).toMatchObject({
        authorization: "Bearer local-key",
        "content-type": "audio/wav",
      });
      expect(h.requests[0]?.body).toMatchObject({ _tag: "Uint8Array", body: audio });
    }),
  );
  it.effect("uses the OpenAI-compatible multipart contract", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run((s) =>
        Effect.gen(function* () {
          yield* s.configure({
            ...local,
            provider: "openai-compatible",
            endpoint: "http://localhost:9000/v1/audio/transcriptions",
            model: "nemo",
          });
          yield* s.transcribe(recording());
        }),
      );
      const body = h.requests[0]?.body;
      if (body?._tag !== "FormData") throw new Error("Expected upload");
      expect(body.formData.get("model")).toBe("nemo");
      expect(body.formData.get("response_format")).toBe("json");
      expect(body.formData.get("file")).toBeInstanceOf(Blob);
      expect(h.requests[0]?.headers.authorization).toBeUndefined();
    }),
  );
  it.effect("retains keys only for the same destination and supports removal", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run((s) =>
        Effect.gen(function* () {
          yield* s.configure({ ...local, apiKey: "original" });
          expect((yield* s.configure(local)).hasApiKey).toBe(true);
          expect(
            (yield* s.configure({ ...local, endpoint: "http://localhost:9000/transcribe" }))
              .hasApiKey,
          ).toBe(false);
          yield* s.configure({ ...local, apiKey: "original" });
          expect((yield* s.configure({ ...local, apiKey: "" })).hasApiKey).toBe(false);
        }),
      );
    }),
  );
  it.effect("refuses disabled and stub providers before any request", () =>
    Effect.gen(function* () {
      const h = harness();
      expect(yield* h.run((s) => s.transcribe(recording())).pipe(Effect.flip)).toMatchObject({
        reason: "disabled",
      });
      yield* h.run((s) => s.configure({ ...local, provider: "deepgram", model: "nova" }));
      expect(yield* h.run((s) => s.transcribe(recording())).pipe(Effect.flip)).toMatchObject({
        reason: "unsupported",
      });
      expect(h.requests).toHaveLength(0);
    }),
  );
  it.effect.each([
    "file:///tmp/audio",
    "https://user:password@example.com/transcribe",
    "https://example.com/#token",
  ])("rejects unsafe endpoint %s", (endpoint) =>
    Effect.gen(function* () {
      const h = harness();
      expect(
        yield* h.run((s) => s.configure({ ...local, endpoint })).pipe(Effect.flip),
      ).toMatchObject({ reason: "settings" });
      expect(h.stored.size).toBe(0);
    }),
  );
  it.effect.each([new Uint8Array(0), new Uint8Array(100), recording(48000)])(
    "refuses invalid recordings",
    (audio) =>
      Effect.gen(function* () {
        const h = harness();
        yield* h.run((s) => s.configure(local));
        expect(yield* h.run((s) => s.transcribe(audio)).pipe(Effect.flip)).toMatchObject({
          reason: "audio",
        });
        expect(h.requests).toHaveLength(0);
      }),
  );
  it.effect("reports status without private provider details", () =>
    Effect.gen(function* () {
      const h = harness({ error: "private detail" }, 401);
      yield* h.run((s) => s.configure(local));
      expect((yield* h.run((s) => s.transcribe(recording())).pipe(Effect.flip)).message).toBe(
        "Dictation provider returned HTTP 401.",
      );
    }),
  );
  it.effect("rejects invalid transcripts and accepts empty speech", () =>
    Effect.gen(function* () {
      const invalid = harness({ text: 42 });
      yield* invalid.run((s) => s.configure(local));
      expect(yield* invalid.run((s) => s.transcribe(recording())).pipe(Effect.flip)).toMatchObject({
        reason: "response",
      });
      const empty = harness({ text: " " });
      yield* empty.run((s) => s.configure(local));
      expect(yield* empty.run((s) => s.transcribe(recording()))).toBe("");
    }),
  );
});
