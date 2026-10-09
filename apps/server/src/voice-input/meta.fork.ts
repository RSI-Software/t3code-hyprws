import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

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
