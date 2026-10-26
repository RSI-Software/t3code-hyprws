import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Exit from "effect/Exit";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { metaVoiceStreamFork } from "./meta.fork.ts";
import { openAiVoiceStreamFork, upsamplePcmFork } from "./openaiRealtime.fork.ts";
import { relayVoiceStreamFork, type VoiceStreamAdapterFork } from "./realtime.fork.ts";

const fixture = Effect.gen(function* () {
  const input = yield* Queue.make<Uint8Array | string, Socket.SocketError>();
  const output = yield* Queue.make<Uint8Array | string | Socket.CloseEvent>();
  let closed = false;
  const socket = Socket.make({
    reader: Effect.acquireRelease(
      Effect.succeed({
        pull: Queue.take(input).pipe(Effect.map((frame) => [frame] as const)),
        upgrade: () => Effect.void,
      }),
      () =>
        Effect.sync(() => {
          closed = true;
        }),
    ),
    writer: Effect.succeed({
      write: (frame) => Queue.offer(output, frame).pipe(Effect.asVoid),
      writeAll: (frames) => Queue.offerAll(output, frames).pipe(Effect.asVoid),
    }),
  });
  return {
    socket,
    input,
    output,
    closed: () => closed,
    send: (frame: Uint8Array | string) => Queue.offer(input, frame),
    read: Queue.take(output),
    close: (code = 1000) =>
      Queue.fail(input, new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) })),
  };
});
const relay = (adapter: VoiceStreamAdapterFork) =>
  Effect.gen(function* () {
    const client = yield* fixture;
    const upstream = yield* fixture;
    const fiber = yield* relayVoiceStreamFork(client.socket, upstream.socket, adapter).pipe(
      Effect.scoped,
      Effect.forkChild,
    );
    const handshake = yield* upstream.read;
    return { client, upstream, fiber, handshake };
  });
const harness = relay(metaVoiceStreamFork({ model: "muse", apiKey: "private-key" }));
const ready = (h: Effect.Success<typeof harness>) =>
  Effect.gen(function* () {
    yield* h.upstream.send('{"sessionId":"session"}');
    expect(yield* h.client.read).toBe('{"type":"ready"}');
  });

it.effect("streams PCM and cumulative revisions, then ends on the final transcript", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    expect(h.handshake).toContain('"accessToken":"Bearer private-key"');
    expect(h.handshake).toContain('"audioEncoding":"PCM_16KHZ"');
    expect(h.handshake).toContain('"partialMode":"CUMULATIVE"');
    yield* ready(h);
    const audio = new Uint8Array(2560);
    yield* h.client.send(audio);
    expect(yield* h.upstream.read).toEqual(audio);
    yield* h.upstream.send('{"type":"audioProgress","audioProcessedMs":80}');
    for (const transcript of ["hello word", "hello world"]) {
      yield* h.upstream.send(`{"type":"transcript","transcript":"${transcript}","final":false}`);
      expect(yield* h.client.read).toBe(
        `{"type":"transcript","text":"${transcript}","final":false}`,
      );
    }
    yield* h.client.send('{"type":"endStream"}');
    expect(yield* h.upstream.read).toBe('{"type":"endStream"}');
    yield* h.upstream.send('{"type":"transcript","transcript":"Hello world.","final":true}');
    expect(yield* h.client.read).toBe('{"type":"transcript","text":"Hello world.","final":true}');
    yield* Fiber.join(h.fiber);
    expect(h.client.closed()).toBe(true);
    expect(h.upstream.closed()).toBe(true);
  }),
);
it.effect.each([
  { frame: new Uint8Array(1), acknowledge: true },
  { frame: new Uint8Array(6402), acknowledge: true },
  { frame: new Uint8Array(1), acknowledge: false },
  { frame: '{"type":"configure","apiKey":"client-key"}', acknowledge: true },
])("rejects invalid input without forwarding it", ({ frame, acknowledge }) =>
  Effect.gen(function* () {
    const h = yield* harness;
    if (acknowledge) yield* ready(h);
    yield* h.client.send(frame);
    expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
    expect(h.upstream.closed()).toBe(true);
  }),
);
it.effect("refuses clean close without a final transcript", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* ready(h);
    yield* h.upstream.close();
    expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
  }),
);
it.effect("holds audio until the provider is ready, then bounds the final wait", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const audio = new Uint8Array(2560);
    yield* h.client.send(audio);
    yield* h.client.send('{"type":"endStream"}');
    // A cold model may take minutes; the final deadline has not started.
    yield* TestClock.adjust("120 seconds");
    expect(h.fiber.pollUnsafe()).toBeUndefined();
    yield* ready(h);
    expect(yield* h.upstream.read).toEqual(audio);
    expect(yield* h.upstream.read).toBe('{"type":"endStream"}');
    yield* TestClock.adjust("60 seconds");
    expect(Exit.isFailure(yield* Fiber.await(h.fiber))).toBe(true);
  }),
);
it.effect("cancellation releases both sockets", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* ready(h);
    yield* Fiber.interrupt(h.fiber);
    expect(h.client.closed()).toBe(true);
    expect(h.upstream.closed()).toBe(true);
  }),
);
it.effect("speaks OpenAI Realtime transcription and keeps a cumulative preview", () =>
  Effect.gen(function* () {
    const h = yield* relay(openAiVoiceStreamFork({ model: "nemo", apiKey: "" }));
    expect(JSON.parse(h.handshake as string)).toMatchObject({
      type: "session.update",
      session: { audio: { input: { format: { rate: 24000 }, turn_detection: null } } },
    });
    yield* h.upstream.send('{"type":"session.created"}');
    yield* h.upstream.send('{"type":"session.updated"}');
    expect(yield* h.client.read).toBe('{"type":"ready"}');
    yield* h.client.send(new Uint8Array(2560));
    const append = JSON.parse((yield* h.upstream.read) as string);
    expect(append.type).toBe("input_audio_buffer.append");
    expect(Buffer.from(append.audio, "base64").byteLength).toBe(3838);
    for (const [delta, text] of [
      ["hello", "hello"],
      [" world", "hello world"],
    ]) {
      yield* h.upstream.send(
        `{"type":"conversation.item.input_audio_transcription.delta","delta":"${delta}"}`,
      );
      expect(yield* h.client.read).toBe(`{"type":"transcript","text":"${text}","final":false}`);
    }
    yield* h.client.send('{"type":"endStream"}');
    expect(yield* h.upstream.read).toBe('{"type":"input_audio_buffer.commit"}');
    yield* h.upstream.send(
      '{"type":"conversation.item.input_audio_transcription.completed","transcript":"Hello world."}',
    );
    expect(yield* h.client.read).toBe('{"type":"transcript","text":"Hello world.","final":true}');
    yield* Fiber.join(h.fiber);
  }),
);
it.effect.each([
  { edit: '"edited_text":"Ship it Friday."', final: ',"edited":"Ship it Friday."' },
  { edit: null, final: "" },
])("waits briefly for a transcript edit, else sends the raw final", ({ edit, final }) =>
  Effect.gen(function* () {
    const h = yield* relay(
      openAiVoiceStreamFork(
        { model: "nemo", apiKey: "" },
        { prompt: "", transcript_edit: "Tidy." },
      ),
    );
    yield* h.upstream.send('{"type":"session.updated"}');
    expect(yield* h.client.read).toBe('{"type":"ready"}');
    yield* h.client.send('{"type":"endStream"}');
    expect(yield* h.upstream.read).toBe('{"type":"input_audio_buffer.commit"}');
    yield* h.upstream.send(
      '{"type":"conversation.item.input_audio_transcription.completed","transcript":"um ship it friday"}',
    );
    if (edit)
      yield* h.upstream.send(
        `{"type":"prlt.conversation.item.input_audio_transcription.edited","text":"um ship it friday",${edit}}`,
      );
    else yield* TestClock.adjust("1500 millis");
    expect(yield* h.client.read).toBe(
      `{"type":"transcript","text":"um ship it friday","final":true${final}}`,
    );
    yield* Fiber.join(h.fiber);
  }),
);
it.effect("fails at once on OpenAI Realtime error and transcription failure events", () =>
  Effect.gen(function* () {
    for (const type of ["error", "conversation.item.input_audio_transcription.failed"]) {
      const h = yield* relay(openAiVoiceStreamFork({ model: "nemo", apiKey: "" }));
      yield* h.upstream.send(`{"type":"${type}","error":{"message":"bad model"}}`);
      const error = yield* Fiber.join(h.fiber).pipe(Effect.flip);
      expect(error).toMatchObject({ detail: "Provider failed: bad model" });
    }
  }),
);
it("upsamples 16 kHz PCM to 24 kHz continuously across frames", () => {
  const ramp = new Int16Array(64).map((_, i) => i * 100);
  const upsample = upsamplePcmFork();
  const bytes = new Uint8Array(ramp.buffer);
  const split = [upsample(bytes.subarray(0, 42)), upsample(bytes.subarray(42))];
  const whole = upsamplePcmFork()(bytes);
  const joined = new Uint8Array(split[0]!.byteLength + split[1]!.byteLength);
  joined.set(split[0]!);
  joined.set(split[1]!, split[0]!.byteLength);
  expect(joined).toEqual(whole);
  const samples = new Int16Array(whole.buffer, whole.byteOffset, whole.byteLength / 2);
  expect(samples.length).toBe(95);
  expect(Array.from(samples.slice(0, 4))).toEqual([0, 67, 133, 200]);
});
