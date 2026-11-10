import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as RemoteSpeechModelStore from "./RemoteSpeechModelStore.fork.ts";

// The shape the fork's first dictation settings saved, still on disk for existing installs.
const legacy = {
  enabled: true,
  provider: "openai-compatible",
  endpoint: "https://speech.example/v1/audio/transcriptions",
  streamingEndpoint: "wss://speech.example/v1/realtime?intent=transcription",
  model: "nemo",
  apiKey: "private-key",
};

const withStore = <A, E>(
  use: (store: RemoteSpeechModelStore.RemoteSpeechModelStoreFork["Service"]) => Effect.Effect<A, E>,
) => {
  const secrets = new Map<string, Uint8Array>([
    ["fork-voice-input", new TextEncoder().encode(JSON.stringify(legacy))],
  ]);
  return Effect.flatMap(RemoteSpeechModelStore.RemoteSpeechModelStoreFork, use).pipe(
    Effect.provide(
      RemoteSpeechModelStore.layer.pipe(
        Layer.provide(
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
        ),
      ),
    ),
  );
};

describe("remote speech model settings", () => {
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
    const parsed = RemoteSpeechModelStore.parseRemoteSpeechModelFork(JSON.stringify(stored));
    expect(parsed && { baseUrl: parsed.baseUrl, live: parsed.live }).toEqual(expected);
  });

  it.effect.each([
    {
      name: "keeps the key when it is omitted and the URL is unchanged",
      input: { baseUrl: "https://speech.example/v1/", model: "nemo", live: true },
      apiKey: "private-key",
    },
    {
      name: "drops the key when the URL changes",
      input: { baseUrl: "https://other.example/v1", model: "nemo", live: true },
      apiKey: "",
    },
    {
      name: "clears the key when an empty one is sent",
      input: { baseUrl: "https://speech.example/v1", model: "nemo", live: true, apiKey: " " },
      apiKey: "",
    },
    {
      name: "refuses an unusable URL",
      input: { baseUrl: "ftp://speech.example", model: "nemo", live: true },
      apiKey: null,
    },
  ])("save $name", ({ input, apiKey }) =>
    withStore((store) =>
      Effect.gen(function* () {
        const saved = yield* store.save(input);
        expect(saved?.apiKey ?? null).toBe(apiKey);
        expect((yield* store.read)?.apiKey).toBe(saved ? apiKey : "private-key");
      }),
    ),
  );
});
