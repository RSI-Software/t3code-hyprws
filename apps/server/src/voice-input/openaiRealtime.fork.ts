import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { VoiceVocabularyFork } from "./VoiceInput.fork.ts";
import { VoiceStreamProtocolErrorFork, type VoiceStreamAdapterFork } from "./realtime.fork.ts";

const RealtimeEvent = Schema.Struct({
  type: Schema.String,
  delta: Schema.optionalKey(Schema.String),
  transcript: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
});
const decodeRealtimeEvent = Schema.decodeEffect(Schema.fromJsonString(RealtimeEvent));

/** Linear 16 → 24 kHz PCM16 upsampling; each frame holds back its last sample to interpolate across the boundary. */
export function upsamplePcmFork() {
  const step = 16000 / 24000;
  let previous = 0;
  // Index into [previous, ...frame]; starts on the first real sample.
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

/**
 * OpenAI Realtime transcription: the standard wire for every non-Meta streaming endpoint.
 * Partials arrive as deltas; the completed event carries the authoritative final text.
 */
export function openAiVoiceStreamFork(
  config: { model: string; apiKey: string },
  vocabulary: VoiceVocabularyFork = {},
): VoiceStreamAdapterFork {
  const upsample = upsamplePcmFork();
  let preview = "";
  return {
    ...(config.apiKey ? { headers: { authorization: `Bearer ${config.apiKey}` } } : {}),
    start: [
      JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: config.model, ...vocabulary },
              turn_detection: null,
            },
          },
        },
      }),
    ],
    audio: (pcm) =>
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: Buffer.from(upsample(pcm)).toString("base64"),
      }),
    end: ['{"type":"input_audio_buffer.commit"}'],
    receive: Effect.fnUntraced(function* (frame) {
      const event = yield* decodeRealtimeEvent(frame);
      switch (event.type) {
        case "session.updated":
          return { type: "ready" } as const;
        case "conversation.item.input_audio_transcription.delta":
          preview += event.delta ?? "";
          return { type: "transcript", text: preview, final: false } as const;
        case "conversation.item.input_audio_transcription.completed":
          if (event.transcript === undefined)
            return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid transcript." });
          return { type: "transcript", text: event.transcript, final: true } as const;
        case "conversation.item.input_audio_transcription.failed":
        case "error": {
          // The provider's message names the wrong model, key, or route.
          const message = event.error?.message?.trim().slice(0, 200);
          return yield* new VoiceStreamProtocolErrorFork({
            detail: message ? `Provider failed: ${message}` : "Provider failed.",
          });
        }
        default:
          return undefined;
      }
    }),
  };
}
