import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { VoiceStreamProtocolErrorFork, type VoiceStreamAdapterFork } from "./realtime.fork.ts";

const MetaTranscript = Schema.Struct({ transcript: Schema.String });

/** Meta's push-to-talk API uses named JSON and WAV parts, unlike OpenAI uploads. */
export function metaVoiceRequestFork(endpoint: string, model: string, audio: Uint8Array) {
  const form = new FormData();
  form.set(
    "request",
    new Blob([JSON.stringify({ model, audioEncoding: "WAV", mode: "PUSH_TO_TALK" })], {
      type: "application/json",
    }),
  );
  form.set("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "dictation.wav");
  return HttpClientRequest.post(endpoint).pipe(HttpClientRequest.bodyFormData(form));
}

export const metaVoiceTranscriptFork = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(MetaTranscript)(response).pipe(
    Effect.map((body) => body.transcript),
  );

const MetaEvent = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  transcript: Schema.optionalKey(Schema.String),
  final: Schema.optionalKey(Schema.Boolean),
});
const decodeMetaEvent = Schema.decodeEffect(Schema.fromJsonString(MetaEvent));
const encodeMetaHandshake = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      authorization: Schema.Struct({ accessToken: Schema.String }),
      audioEncoding: Schema.Literal("PCM_16KHZ"),
      model: Schema.String,
      mode: Schema.Literal("PUSH_TO_TALK"),
      partialMode: Schema.Literal("CUMULATIVE"),
      emitAudioProgress: Schema.Boolean,
    }),
  ),
);

/** Meta authenticates in its handshake, takes raw PCM, and sends cumulative revisions. */
export function metaVoiceStreamFork(config: {
  model: string;
  apiKey: string;
}): VoiceStreamAdapterFork {
  return {
    start: [
      encodeMetaHandshake({
        authorization: { accessToken: `Bearer ${config.apiKey}` },
        audioEncoding: "PCM_16KHZ",
        model: config.model,
        mode: "PUSH_TO_TALK",
        partialMode: "CUMULATIVE",
        emitAudioProgress: false,
      }),
    ],
    audio: (pcm) => pcm,
    end: ['{"type":"endStream"}'],
    receive: Effect.fnUntraced(function* (frame) {
      const event = yield* decodeMetaEvent(frame);
      if (event.type === "error")
        return yield* new VoiceStreamProtocolErrorFork({ detail: "Provider failed." });
      if (event.type === undefined && event.sessionId) return { type: "ready" } as const;
      if (event.type !== "transcript") return undefined;
      if (event.transcript === undefined || event.final === undefined)
        return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid transcript." });
      return { type: "transcript", text: event.transcript, final: event.final } as const;
    }),
  };
}
