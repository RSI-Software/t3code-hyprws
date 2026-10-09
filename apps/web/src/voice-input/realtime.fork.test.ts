import { afterEach, expect, it, vi } from "vite-plus/test";
import { connectLiveVoiceFork } from "./realtime.fork";

class SocketFixture extends EventTarget {
  static OPEN = 1;
  static current: SocketFixture;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | ArrayBuffer> = [];
  close = vi.fn();
  constructor() {
    super();
    SocketFixture.current = this;
  }
  send(frame: string | ArrayBuffer) {
    this.sent.push(frame);
  }
  event(data: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
  closed(code: number) {
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const fixture = () => {
  vi.stubGlobal("WebSocket", SocketFixture);
  const abort = new AbortController();
  const preview = vi.fn();
  const error = vi.fn();
  const pending = connectLiveVoiceFork("ws://voice.local/realtime", abort.signal, preview, error);
  const socket = SocketFixture.current;
  return { abort, preview, error, pending, socket };
};
it("replaces hypotheses and waits for endStream, final text, and clean close", async () => {
  const h = fixture();
  h.socket.event({ type: "ready" });
  const live = await h.pending;
  live.send(new ArrayBuffer(2560));
  h.socket.event({ type: "transcript", text: "hello word", final: false });
  h.socket.event({ type: "transcript", text: "hello world", final: false });
  expect(h.preview.mock.calls.map(([text]) => text)).toEqual(["hello word", "hello world"]);
  const complete = vi.fn();
  void live.result.then(complete);
  live.finish();
  live.finish();
  expect(h.socket.sent.filter((frame) => typeof frame === "string")).toEqual([
    '{"type":"endStream"}',
  ]);
  h.socket.event({ type: "transcript", text: "Hello world.", final: true });
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  h.socket.closed(1000);
  expect(await live.result).toBe("Hello world.");
  expect(h.error).not.toHaveBeenCalled();
});
it.each([1000, 1011])("refuses close %i without a final transcript", async (code) => {
  const h = fixture();
  h.socket.event({ type: "ready" });
  const live = await h.pending;
  live.finish();
  h.socket.closed(code);
  await expect(live.result).rejects.toThrow("Live dictation failed");
  expect(h.error).toHaveBeenCalledOnce();
});
it("cancellation closes the socket and ignores late transcripts", async () => {
  const h = fixture();
  h.socket.event({ type: "ready" });
  const live = await h.pending;
  h.abort.abort();
  h.socket.event({ type: "transcript", text: "late words", final: false });
  await expect(live.result).rejects.toThrow("cancelled");
  expect(h.socket.close).toHaveBeenCalledOnce();
  expect(h.preview).not.toHaveBeenCalled();
  expect(h.error).not.toHaveBeenCalled();
});
it("fails bounded preparation and final waits", async () => {
  vi.useFakeTimers();
  const h = fixture();
  const preparation = expect(h.pending).rejects.toThrow("Live dictation failed");
  await vi.advanceTimersByTimeAsync(15000);
  await preparation;
  const next = fixture();
  next.socket.event({ type: "ready" });
  const live = await next.pending;
  live.finish();
  const result = expect(live.result).rejects.toThrow("Live dictation failed");
  await vi.advanceTimersByTimeAsync(60000);
  await result;
});
it("reports backpressure instead of queuing unbounded audio", async () => {
  const h = fixture();
  h.socket.event({ type: "ready" });
  const live = await h.pending;
  h.socket.bufferedAmount = 32001;
  live.send(new ArrayBuffer(2560));
  await expect(live.result).rejects.toThrow();
  expect(h.socket.sent).toEqual([]);
  expect(h.error).toHaveBeenCalledOnce();
});
