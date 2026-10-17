import {
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { VOICE_INPUT_ROUTE_FORK } from "@t3tools/contracts";
import { runVoiceInputRequestFork } from "./client.fork";

export interface LiveVoiceSessionFork {
  readonly active: boolean;
  send(audio: ArrayBuffer): void;
  finish(): void;
  cancel(): void;
  readonly result: Promise<string>;
}

/**
 * Resolves once the socket opens, so recording never waits on the provider: the server holds
 * audio until the provider is ready. Cumulative hypotheses replace each other; the final result
 * waits for a clean close.
 */
export function connectLiveVoiceFork(
  url: string,
  signal: AbortSignal,
  onPreview: (text: string) => void,
): Promise<LiveVoiceSessionFork> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const final = Promise.withResolvers<string>();
    // A failure during recording surfaces only when the caller awaits result.
    void final.promise.catch(() => {});
    let open = false;
    let ready = false;
    let ended = false;
    let transcript: string | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    // The final wait starts once the provider is ready and input has ended.
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(fail, ready && ended ? 60000 : 310000);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      socket.close();
    };
    const fail = (error = new Error("Live dictation failed.")) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      final.reject(error);
    };
    const cancel = () => fail(new DOMException("Dictation cancelled.", "AbortError"));
    const session: LiveVoiceSessionFork = {
      get active() {
        return !settled && !ended;
      },
      result: final.promise,
      cancel,
      send: (audio) => {
        if (
          settled ||
          ended ||
          socket.readyState !== WebSocket.OPEN ||
          socket.bufferedAmount > 32000
        ) {
          fail();
          return;
        }
        socket.send(audio);
      },
      finish: () => {
        if (settled || ended) return;
        ended = true;
        if (ready) armTimer();
        socket.send('{"type":"endStream"}');
      },
    };
    timer = setTimeout(fail, 15000);
    signal.addEventListener("abort", cancel, { once: true });
    socket.addEventListener("open", () => {
      if (settled) return;
      open = true;
      armTimer();
      resolve(session);
    });
    socket.addEventListener("error", () => fail());
    socket.addEventListener("message", ({ data }) => {
      if (settled) return;
      try {
        if (typeof data !== "string" || data.length > 65536) throw new Error("Invalid event.");
        const event: unknown = JSON.parse(data);
        if (typeof event !== "object" || !event || !("type" in event))
          throw new Error("Invalid event.");
        if (event.type === "ready" && open && !ready) {
          ready = true;
          if (ended) armTimer();
        } else if (
          event.type === "transcript" &&
          ready &&
          "text" in event &&
          typeof event.text === "string" &&
          "final" in event &&
          typeof event.final === "boolean"
        ) {
          if (transcript !== null || (event.final && !ended)) throw new Error("Unexpected final.");
          if (event.final) transcript = event.text;
          onPreview(event.text);
        } else {
          throw new Error("Invalid event.");
        }
      } catch {
        fail();
      }
    });
    socket.addEventListener("close", ({ code }) => {
      if (settled) return;
      if (code !== 1000 || transcript === null || !ended) return fail();
      settled = true;
      cleanup();
      final.resolve(transcript);
    });
  });
}

export async function prepareLiveVoiceFork(
  prepared: PreparedConnection,
  signal: AbortSignal,
  onPreview: (text: string) => void,
) {
  const access = await runVoiceInputRequestFork(
    resolveDeviceHubAccess({ prepared, hubBasePath: VOICE_INPUT_ROUTE_FORK }),
    signal,
  );
  return connectLiveVoiceFork(
    withDeviceHubQuery(`${access.wsBase}/realtime`, access),
    signal,
    onPreview,
  );
}
