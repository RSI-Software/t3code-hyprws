import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner, type ManagedRelayDpopProofInput } from "../relay/managedRelay.ts";
import { layerRemoteHttpClient } from "./http.ts";
import {
  readVoiceInputSettingsFork,
  transcribeVoiceInputFork,
  saveVoiceInputSettingsFork,
} from "./voiceInput.fork.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("dictation-test"),
  label: "Dictation",
  httpBaseUrl: "https://environment.test/base",
  wsBaseUrl: "wss://environment.test",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  target,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://environment.test/ws",
  httpAuthorization: null,
};
const settings = {
  enabled: true,
  provider: "local",
  endpoint: "http://localhost:9000/transcribe",
  model: "",
  hasApiKey: false,
  providers: [],
};

it.effect("refreshes rejected relay credentials and signs the renewed destination", () =>
  Effect.gen(function* () {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const rejected: Array<string | undefined> = [];
    const proofs: Array<ManagedRelayDpopProofInput> = [];
    const relay = new RelayConnectionTarget({
      environmentId: target.environmentId,
      label: target.label,
    });
    const fetchFn: typeof fetch = (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(
        calls.length === 1
          ? Response.json(
              {
                _tag: "EnvironmentAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "test-trace",
              },
              { status: 401 },
            )
          : Response.json(settings),
      );
    };
    const layer = Layer.mergeAll(
      layerRemoteHttpClient(fetchFn),
      Layer.mock(RemoteEnvironmentAuthorization)({
        authorizeDpopHttp: (input) =>
          Effect.sync(() => {
            rejected.push(input.rejectedAccessToken);
            const renewed = input.rejectedAccessToken !== undefined;
            return {
              environmentId: target.environmentId,
              label: target.label,
              httpBaseUrl: renewed ? "https://renewed.test" : "https://current.test",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: renewed ? "renewed" : "current",
                expiresAtEpochMs: 3_600_000,
              },
            };
          }),
      }),
      Layer.mock(ManagedRelayDpopSigner)({
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return "request-proof";
          }),
      }),
    );
    const result = yield* readVoiceInputSettingsFork({
      ...prepared,
      target: relay,
      httpAuthorization: { _tag: "Dpop", accessToken: "expired", expiresAtEpochMs: 0 },
    }).pipe(Effect.provide(layer));
    expect(result).toEqual(settings);
    expect(rejected).toEqual([undefined, "current"]);
    expect(calls.map((c) => c.url)).toEqual([
      "https://current.test/api/fork/voice-input/settings",
      "https://renewed.test/api/fork/voice-input/settings",
    ]);
    expect(proofs).toEqual([
      { method: "GET", url: calls[0]!.url, accessToken: "current" },
      { method: "GET", url: calls[1]!.url, accessToken: "renewed" },
    ]);
    expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("DPoP renewed");
  }),
);

it.effect("reads the destination environment with cookie authentication", () =>
  Effect.gen(function* () {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: typeof fetch = (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(Response.json(settings));
    };
    const result = yield* readVoiceInputSettingsFork(prepared).pipe(
      Effect.provide(layerRemoteHttpClient(fetchFn)),
    );
    expect(result).toEqual(settings);
    expect(calls[0]?.url).toBe("https://environment.test/api/fork/voice-input/settings");
    expect(calls[0]?.init.credentials).toBe("include");
  }),
);

it.effect("uploads WAV bytes with the selected environment bearer grant", () =>
  Effect.gen(function* () {
    let request: RequestInit = {};
    const fetchFn: typeof fetch = (_url, init) => {
      request = init ?? {};
      return Promise.resolve(Response.json({ text: "Dictated text" }));
    };
    const wav = new Uint8Array([82, 73, 70, 70]);
    const result = yield* transcribeVoiceInputFork(
      { ...prepared, httpAuthorization: { _tag: "Bearer", token: "environment-grant" } },
      wav,
    ).pipe(Effect.provide(layerRemoteHttpClient(fetchFn)));
    expect(result.text).toBe("Dictated text");
    const headers = new Headers(request.headers);
    expect(headers.get("authorization")).toBe("Bearer environment-grant");
    expect(headers.get("content-type")).toBe("audio/wav");
    expect(request.body).toEqual(wav);
  }),
);

it.effect("preserves omitted API keys when saving settings", () =>
  Effect.gen(function* () {
    let request: RequestInit = {};
    const fetchFn: typeof fetch = (_url, init) => {
      request = init ?? {};
      return Promise.resolve(Response.json(settings));
    };
    yield* saveVoiceInputSettingsFork(prepared, {
      enabled: true,
      provider: "local",
      endpoint: settings.endpoint,
      model: "",
    }).pipe(Effect.provide(layerRemoteHttpClient(fetchFn)));
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).not.toHaveProperty("apiKey");
  }),
);

it.effect("rejects malformed transcript responses", () =>
  Effect.gen(function* () {
    const result = yield* transcribeVoiceInputFork(prepared, new Uint8Array()).pipe(
      Effect.provide(
        layerRemoteHttpClient(() =>
          Promise.resolve(Response.json({ transcript: "wrong protocol" })),
        ),
      ),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
  }),
);
