import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import type * as Socket from "effect/socket/Socket";

const encodeTranscript = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("transcript"),
      text: Schema.String,
      final: Schema.Boolean,
    }),
  ),
);
export class VoiceStreamProtocolErrorFork extends Schema.TaggedError<VoiceStreamProtocolErrorFork>()(
  "VoiceStreamProtocolErrorFork",
  { detail: Schema.String },
) {}

/** A full transcript replaces the previous preview; nothing else reaches the client. */
export type VoiceStreamUpdateFork =
  | { readonly type: "ready" }
  | { readonly type: "transcript"; readonly text: string; readonly final: boolean }
  | undefined;

/** One provider's realtime wire for one session; the relay owns limits, order, and the client protocol. */
export interface VoiceStreamAdapterFork {
  readonly headers?: Record<string, string>;
  /** Sent once the upstream socket opens. */
  readonly start: ReadonlyArray<string>;
  /** Encodes one validated 16 kHz mono PCM16 client frame. */
  readonly audio: (pcm: Uint8Array) => string | Uint8Array;
  /** Ends input and requests the final transcript. */
  readonly end: ReadonlyArray<string>;
  readonly receive: (
    frame: string,
  ) => Effect.Effect<VoiceStreamUpdateFork, Schema.SchemaError | VoiceStreamProtocolErrorFork>;
}

/** One push-to-talk stream; the session ends when the final transcript reaches the client. */
export const relayVoiceStreamFork = Effect.fn("VoiceInput.relayStream")(function* (
  client: Socket.Socket,
  upstream: Socket.Socket,
  adapter: VoiceStreamAdapterFork,
) {
  const downstreamReader = yield* client.reader;
  const downstreamWriter = yield* client.writer;
  const reader = yield* upstream.reader;
  const writer = yield* upstream.writer;
  for (const frame of adapter.start) yield* writer.write(frame);
  let ready = false;
  let ended = false;
  let bytes = 0;
  const endInput = yield* Deferred.make<void>();
  const receive = Effect.gen(function* () {
    while (true) {
      const frames = yield* ready ? reader.pull : reader.pull.pipe(Effect.timeout("10 seconds"));
      for (const frame of frames) {
        if (typeof frame !== "string" || frame.length > 65536)
          return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid event." });
        const update = yield* adapter.receive(frame);
        if (update?.type === "ready" && !ready) {
          ready = true;
          yield* downstreamWriter.write('{"type":"ready"}');
        } else if (update?.type === "transcript") {
          if (!ready || (update.final && !ended))
            return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid transcript." });
          yield* downstreamWriter.write(encodeTranscript(update));
          if (update.final) return;
        }
      }
    }
  });
  const send = Effect.gen(function* () {
    while (true) {
      for (const frame of yield* downstreamReader.pull) {
        if (!ready || ended)
          return yield* new VoiceStreamProtocolErrorFork({ detail: "Unexpected audio." });
        if (typeof frame === "string") {
          if (frame !== '{"type":"endStream"}')
            return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid control." });
          ended = true;
          for (const control of adapter.end) yield* writer.write(control);
          yield* Deferred.succeed(endInput, undefined);
        } else {
          bytes += frame.byteLength;
          if (
            !frame.byteLength ||
            frame.byteLength % 2 ||
            frame.byteLength > 6400 ||
            bytes > 32000 * 300
          ) {
            return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid audio." });
          }
          yield* writer.write(adapter.audio(frame));
        }
      }
    }
  });
  const finalDeadline = Deferred.await(endInput).pipe(
    Effect.andThen(Effect.never.pipe(Effect.timeout("60 seconds"))),
  );
  yield* Effect.raceFirst(receive, Effect.raceFirst(send, finalDeadline)).pipe(
    Effect.timeout("360 seconds"),
  );
});
