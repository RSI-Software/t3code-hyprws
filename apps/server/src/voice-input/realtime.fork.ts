import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Socket from "effect/socket/Socket";

const encodeTranscript = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("transcript"),
      text: Schema.String,
      final: Schema.Boolean,
      edited: Schema.optionalKey(Schema.String),
    }),
  ),
);
export class VoiceStreamProtocolErrorFork extends Schema.TaggedError<VoiceStreamProtocolErrorFork>()(
  "VoiceStreamProtocolErrorFork",
  { detail: Schema.String },
) {}

/** A full transcript replaces the previous preview; `edited` is the service's cleanup of the final one. */
export type VoiceStreamUpdateFork =
  | { readonly type: "ready" }
  | { readonly type: "transcript"; readonly text: string; readonly final: boolean }
  | { readonly type: "edited"; readonly text: string }
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
  /** An `edited` update may follow the final transcript. */
  readonly awaitsEdit?: boolean;
  readonly receive: (
    frame: string,
  ) => Effect.Effect<VoiceStreamUpdateFork, Schema.SchemaError | VoiceStreamProtocolErrorFork>;
}

/**
 * One push-to-talk stream; the session ends when the final transcript reaches the client.
 * Audio may arrive before the provider is ready (a cold model can take minutes to load):
 * it is held in order and forwarded once ready, so recording never waits on the provider.
 */
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
  let delivered = false;
  let bytes = 0;
  const isReady = yield* Deferred.make<void>();
  const endInput = yield* Deferred.make<void>();
  // Validated client input in arrival order; `null` ends input.
  const input = yield* Queue.unbounded<Uint8Array | null>();
  // One provider frame at a time, so a batch never splits across the final and its edit.
  let pulled: Array<string | Uint8Array> = [];
  const nextUpdate = Effect.gen(function* () {
    while (pulled.length === 0) pulled = [...(yield* reader.pull)];
    const frame = pulled.shift();
    if (typeof frame !== "string" || frame.length > 65536)
      return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid event." });
    return yield* adapter.receive(frame);
  });
  // The edit trails the final transcript and never arrives on the service's timeout or error;
  // the client then falls back to its own cleanup.
  const awaitEdit = Effect.gen(function* () {
    while (true) {
      const update = yield* nextUpdate;
      if (update?.type === "edited") return update.text;
    }
  }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  const receive = Effect.gen(function* () {
    while (true) {
      const update = yield* nextUpdate;
      if (update?.type === "ready" && !ready) {
        ready = true;
        yield* downstreamWriter.write('{"type":"ready"}');
        yield* Deferred.succeed(isReady, undefined);
      } else if (update?.type === "transcript") {
        if (!ready || (update.final && !delivered))
          return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid transcript." });
        if (!update.final) {
          yield* downstreamWriter.write(encodeTranscript(update));
          continue;
        }
        const edited = adapter.awaitsEdit && update.text.trim() ? yield* awaitEdit : undefined;
        yield* downstreamWriter.write(
          encodeTranscript(edited === undefined ? update : { ...update, edited }),
        );
        return;
      }
    }
  });
  const accept = Effect.gen(function* () {
    while (true) {
      for (const frame of yield* downstreamReader.pull) {
        if (ended) return yield* new VoiceStreamProtocolErrorFork({ detail: "Unexpected audio." });
        if (typeof frame === "string") {
          if (frame !== '{"type":"endStream"}')
            return yield* new VoiceStreamProtocolErrorFork({ detail: "Invalid control." });
          ended = true;
          yield* Queue.offer(input, null);
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
          yield* Queue.offer(input, frame);
        }
      }
    }
  });
  const forward = Effect.gen(function* () {
    yield* Deferred.await(isReady);
    while (true) {
      const frame = yield* Queue.take(input);
      if (frame) {
        yield* writer.write(adapter.audio(frame));
        continue;
      }
      for (const control of adapter.end) yield* writer.write(control);
      delivered = true;
      yield* Deferred.succeed(endInput, undefined);
      return yield* Effect.never;
    }
  });
  // The final wait starts once the provider has every frame, not when the user stops.
  const finalDeadline = Deferred.await(endInput).pipe(
    Effect.andThen(Effect.never.pipe(Effect.timeout("60 seconds"))),
  );
  yield* Effect.raceFirst(
    receive,
    Effect.raceFirst(accept, Effect.raceFirst(forward, finalDeadline)),
  ).pipe(Effect.timeout("360 seconds"));
});
