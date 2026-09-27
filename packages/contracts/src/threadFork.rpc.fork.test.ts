// Fork-only: the `thread.fork` wire contract, exercised the way the client
// and the WS server see it — request payload, success, and every refusal
// round-trip through the WsRpcGroup entry's own schemas. Guards the
// {environmentId, input} client-command split: the command's `input` is the
// bare payload, and a mismatch dies as a schema defect before any handler
// runs.
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AuthOrchestrationOperateScope, EnvironmentAuthorizationError } from "./auth.ts";
import { WsRpcGroup } from "./rpc.ts";
import {
  ThreadForkInstanceMismatchError,
  ThreadForkNativeForkError,
  ThreadForkNotQuiescentError,
  ThreadForkOrchestrationError,
  ThreadForkResult,
  ThreadForkSourceMissingError,
  ThreadForkSourceStateError,
  ThreadForkUnsupportedProviderError,
} from "./threadFork.fork.ts";
import { ThreadId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const rpc = WsRpcGroup.requests.get("thread.fork");
if (rpc === undefined || rpc._tag !== "thread.fork") {
  throw new Error("thread.fork is not registered in WsRpcGroup");
}

const decodePayload = Schema.decodeUnknownSync(rpc.payloadSchema);
const decodeSuccess = Schema.decodeUnknownSync(rpc.successSchema);
const decodeError = Schema.decodeUnknownSync(rpc.errorSchema);
const encodePayload = Schema.encodeSync(rpc.payloadSchema);
const encodeError = Schema.encodeSync(rpc.errorSchema);

const CHILD_ID = ThreadId.make("import:codex-1:fork-07070707-0707-4707-8707-070707070707");

describe("thread.fork wire contract", () => {
  it("round-trips the request payload", () => {
    const payload = { threadId: ThreadId.make("thread-1") };
    const decoded = decodePayload(payload);
    expect(decoded.threadId).toBe("thread-1");
    expect(encodePayload({ threadId: ThreadId.make("thread-1") })).toEqual({
      threadId: "thread-1",
    });
  });

  it("refuses a wire payload that never carried the command's input", () => {
    // Regression: the client command target is {environmentId, input}; when
    // the input slot is empty the wire payload is undefined and the server
    // must refuse loudly instead of forking nothing.
    expect(() => decodePayload(undefined)).toThrow();
    // Extra client-side keys are stripped, not refused.
    expect(decodePayload({ environmentId: "environment-1", threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
  });

  it("round-trips the success result", () => {
    const result: ThreadForkResult = { childThreadId: CHILD_ID };
    expect(decodeSuccess({ childThreadId: CHILD_ID })).toEqual(result);
  });

  it("round-trips each tagged refusal from its wire form", () => {
    const refusals = [
      new ThreadForkSourceMissingError({ threadId: ThreadId.make("thread-1") }),
      new ThreadForkUnsupportedProviderError({
        threadId: ThreadId.make("thread-1"),
        provider: ProviderDriverKind.make("opencode"),
      }),
      new ThreadForkInstanceMismatchError({
        threadId: ThreadId.make("thread-1"),
        threadInstanceId: ProviderInstanceId.make("codex-1"),
        bindingInstanceId: ProviderInstanceId.make("codex-2"),
      }),
      new ThreadForkNotQuiescentError({ threadId: ThreadId.make("thread-1"), reason: "turn" }),
      new ThreadForkNotQuiescentError({ threadId: ThreadId.make("thread-1"), reason: "requests" }),
      new ThreadForkNativeForkError({
        threadId: ThreadId.make("thread-1"),
        provider: ProviderDriverKind.make("claudeAgent"),
        cause: new Error("forkSession failed"),
      }),
      new ThreadForkSourceStateError({
        threadId: ThreadId.make("thread-1"),
        reason: "no-cursor",
      }),
      new ThreadForkSourceStateError({
        threadId: ThreadId.make("thread-1"),
        reason: "no-fork-point",
      }),
      new ThreadForkSourceStateError({ threadId: ThreadId.make("thread-1"), reason: "no-history" }),
      new ThreadForkSourceStateError({ threadId: ThreadId.make("thread-1"), reason: "deleted" }),
      new ThreadForkSourceStateError({ threadId: ThreadId.make("thread-1"), reason: "archived" }),
      new ThreadForkOrchestrationError({
        threadId: ThreadId.make("thread-1"),
        childThreadId: null,
        cause: new Error("projection read failed"),
      }),
      new EnvironmentAuthorizationError({
        message: "not allowed",
        requiredScope: AuthOrchestrationOperateScope,
      }),
    ];
    for (const refusal of refusals) {
      // The client decodes the failure from its encoded wire form.
      const wire = encodeError(refusal) as { readonly _tag: string };
      const decoded = decodeError(wire) as { readonly _tag: string };
      expect(decoded._tag).toBe(refusal._tag);
    }
  });
});
