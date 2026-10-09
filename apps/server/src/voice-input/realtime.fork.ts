import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

const Event = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  transcript: Schema.optionalKey(Schema.String),
  final: Schema.optionalKey(Schema.Boolean),
});
const decode = Schema.decodeEffect(Schema.fromJsonString(Event));
const encodeHandshake = Schema.encodeSync(
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
const encodeTranscript = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("transcript"),
      text: Schema.String,
      final: Schema.Boolean,
    }),
  ),
);
class VoiceStreamProtocolErrorFork extends Schema.TaggedError<VoiceStreamProtocolErrorFork>()(
  "VoiceStreamProtocolErrorFork",
  { detail: Schema.String },
) {}

/** The configured upload origin also owns Meta's sibling realtime endpoint. */
export function metaRealtimeUrlFork(endpoint: string) {
  const url = new URL(endpoint);
  if (!url.pathname.endsWith("/transcribe")) throw new Error("Invalid Meta endpoint.");
  url.pathname = url.pathname.replace(/\/transcribe$/, "/realtime");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** One push-to-talk stream; only normalized transcripts cross back to the client. */
export const streamMetaVoiceFork = Effect.fn("VoiceInput.streamMeta")(function* (
  client: Socket.Socket,
  upstream: Socket.Socket,
  config: { model: string; apiKey: string },
) {
  const downstreamReader = yield* client.reader;
  const downstreamWriter = yield* client.writer;
  const reader = yield* upstream.reader;
  const writer = yield* upstream.writer;
  yield* writer.write(
    encodeHandshake({
      authorization: { accessToken: `Bearer ${config.apiKey}` },
      audioEncoding: "PCM_16KHZ",
      model: config.model,
      mode: "PUSH_TO_TALK",
      partialMode: "CUMULATIVE",
      emitAudioProgress: false,
    }),
  );
  let ready = false;
  let ended = false;
  let final = false;
  let bytes = 0;
  const endInput = yield* Deferred.make<void>();
  const receive = Effect.gen(function* () {
    while (true) {
      const frames = yield* ready ? reader.pull : reader.pull.pipe(Effect.timeout("10 seconds"));
      for (const frame of frames) {
        if (typeof frame !== "string" || frame.length > 65536)
          return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid event." });
        const event = yield* decode(frame);
        if (event.type === "error")
          return yield* new VoiceStreamProtocolErrorFork({ detail: "Provider failed." });
        if (!ready) {
          if (event.type !== undefined || !event.sessionId)
            return yield* new VoiceStreamProtocolErrorFork({ detail: "Missing acknowledgement." });
          ready = true;
          yield* downstreamWriter.write('{"type":"ready"}');
        } else if (event.type === "transcript") {
          if (
            event.transcript === undefined ||
            event.final === undefined ||
            final ||
            (event.final && !ended)
          ) {
            return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid transcript." });
          }
          final = event.final;
          yield* downstreamWriter.write(
            encodeTranscript({ type: "transcript", text: event.transcript, final }),
          );
        }
      }
    }
  }).pipe(
    Effect.catch((error) =>
      Socket.isSocketError(error) &&
      error.reason._tag === "SocketCloseError" &&
      error.reason.code === 1000 &&
      final
        ? Effect.void
        : Effect.fail(error),
    ),
  );
  const send = Effect.gen(function* () {
    while (true) {
      for (const frame of yield* downstreamReader.pull) {
        if (!ready || ended)
          return yield* new VoiceStreamProtocolErrorFork({ detail: "Unexpected audio." });
        if (typeof frame === "string") {
          if (frame !== '{"type":"endStream"}')
            return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid control." });
          ended = true;
          yield* writer.write(frame);
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
          yield* writer.write(frame);
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
