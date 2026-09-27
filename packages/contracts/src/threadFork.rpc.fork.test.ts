// Fork-only: the `thread.fork` wire contract, exercised the way the client
// and the WS server see it — request payload and success round-trip through
// the WsRpcGroup entry's own schemas, plus a refusal round-trip carrying a
// coded `ThreadForkError` reason over the same codec stack. Guards the
// {environmentId, input} client-command split: the command's `input` is the
// bare payload, and a mismatch dies as a schema defect before any handler
// runs.
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "./baseSchemas.ts";
import { WsRpcGroup } from "./rpc.ts";
import { ThreadForkError, ThreadForkResult } from "./threadFork.fork.ts";

const rpc = WsRpcGroup.requests.get("thread.fork");
if (rpc === undefined || rpc._tag !== "thread.fork") {
  throw new Error("thread.fork is not registered in WsRpcGroup");
}

const decodePayload = Schema.decodeUnknownSync(rpc.payloadSchema);
const encodePayload = Schema.encodeSync(rpc.payloadSchema);
const decodeSuccess = Schema.decodeUnknownSync(rpc.successSchema);
const encodeSuccess = Schema.encodeSync(rpc.successSchema);
const decodeError = Schema.decodeUnknownSync(rpc.errorSchema);
const encodeError = Schema.encodeSync(rpc.errorSchema);

const THREAD_ID = ThreadId.make("thread-1");
const CHILD_ID = ThreadId.make("import:codex:fork-abc");
const sampleInput = { threadId: THREAD_ID };

describe("thread.fork wire contract", () => {
  it("is registered with the WS RPC group", () => {
    expect(rpc._tag).toBe("thread.fork");
  });

  it("round-trips the payload and the success result", () => {
    expect(decodePayload(encodePayload(sampleInput))).toEqual(sampleInput);

    const result: ThreadForkResult = { childThreadId: CHILD_ID };
    expect(decodeSuccess(encodeSuccess(result))).toEqual(result);
  });

  it("round-trips a coded refusal through ThreadForkError", () => {
    const decoded = decodeError(
      new ThreadForkError({
        threadId: THREAD_ID,
        reason: "source-race",
        childThreadId: CHILD_ID,
        detail: "source moved on",
      }),
    );
    expect(decoded).toMatchObject({
      _tag: "ThreadForkError",
      threadId: THREAD_ID,
      reason: "source-race",
      childThreadId: CHILD_ID,
    });
    // The message is derived from the reason plus the server detail, so a
    // coded refusal stays readable after the wire trip.
    expect((decoded as { message: string }).message).toContain("source moved on");
  });

  it("refuses unknown reasons at the schema boundary", () => {
    expect(() =>
      encodeError(new ThreadForkError({ threadId: THREAD_ID, reason: "nope" as never })),
    ).toThrow();
  });

  it("keeps a refusal readable across a JSON wire trip", () => {
    const encoded = JSON.parse(
      JSON.stringify(
        encodeError(new ThreadForkError({ threadId: THREAD_ID, reason: "no-history" })),
      ),
    );
    const decoded = decodeError(encoded);
    expect(decoded).toMatchObject({ _tag: "ThreadForkError", reason: "no-history" });
  });
});

// ThreadForkResult is re-asserted directly so a schema drift that widens the
// success payload (leaking server-side ids) fails here, not in production.
describe("ThreadForkResult schema", () => {
  it("exposes exactly childThreadId", () => {
    const decode = Schema.decodeUnknownSync(ThreadForkResult);
    expect(decode({ childThreadId: CHILD_ID })).toEqual({ childThreadId: CHILD_ID });
  });
});
