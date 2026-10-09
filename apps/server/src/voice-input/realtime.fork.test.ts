import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Exit from "effect/Exit";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { metaRealtimeUrlFork, streamMetaVoiceFork } from "./realtime.fork.ts";

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
const harness = Effect.gen(function* () {
  const client = yield* fixture;
  const upstream = yield* fixture;
  const fiber = yield* streamMetaVoiceFork(client.socket, upstream.socket, {
    model: "muse",
    apiKey: "private-key",
  }).pipe(Effect.scoped, Effect.forkChild);
  const handshake = yield* upstream.read;
  return { client, upstream, fiber, handshake };
});
const ready = (h: Effect.Success<typeof harness>) =>
  Effect.gen(function* () {
    yield* h.upstream.send('{"sessionId":"session"}');
    expect(yield* h.client.read).toBe('{"type":"ready"}');
  });

it("derives a realtime endpoint on the configured origin", () => {
  expect(metaRealtimeUrlFork("https://api.meta.ai/v1/asr/transcribe")).toBe(
    "wss://api.meta.ai/v1/asr/realtime",
  );
  expect(metaRealtimeUrlFork("http://localhost:8788/asr/transcribe")).toBe(
    "ws://localhost:8788/asr/realtime",
  );
  expect(() => metaRealtimeUrlFork("https://api.meta.ai/other")).toThrow();
});
it.effect(
  "streams PCM and cumulative revisions, then drains final output through clean close",
  () =>
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
      yield* h.upstream.close();
      yield* Fiber.join(h.fiber);
      expect(h.client.closed()).toBe(true);
      expect(h.upstream.closed()).toBe(true);
    }),
);
it.effect.each([
  { frame: new Uint8Array(1), acknowledge: true },
  { frame: new Uint8Array(6402), acknowledge: true },
  { frame: new Uint8Array(2560), acknowledge: false },
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
it.effect("bounds handshake and final latency", () =>
  Effect.gen(function* () {
    const handshake = yield* harness;
    yield* TestClock.adjust("10 seconds");
    expect(Exit.isFailure(yield* Fiber.await(handshake.fiber))).toBe(true);
    const h = yield* harness;
    yield* ready(h);
    yield* h.client.send('{"type":"endStream"}');
    yield* h.upstream.read;
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
