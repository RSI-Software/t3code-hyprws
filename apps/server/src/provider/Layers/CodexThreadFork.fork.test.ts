// Fork-only: the lazy Codex fork — the runtime reads the handler-written
// cursor and sends `thread/fork` on the child's first start, failing closed
// with no `thread/start` fallback.
import * as NodeAssert from "node:assert/strict";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import { ThreadId } from "@t3tools/contracts";

import { openCodexThread } from "./CodexSessionRuntime.ts";
import {
  codexThreadForkOpenField,
  readCodexForkSourceThreadId,
  type CodexThreadForkOpenRequest,
} from "./CodexThreadFork.fork.ts";

function makeForkResponse(threadId: string) {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    thread: { id: threadId },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/fork"];
}

const startParamsResponse = {
  cwd: "/tmp/project",
  model: "gpt-5.3-codex",
  modelProvider: "openai",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: { type: "danger-full-access" },
  thread: {
    id: "unused",
    createdAt: "2026-04-18T00:00:00.000Z",
    source: { session: "cli" },
    turns: [],
    status: { state: "idle", activeFlags: [] },
  },
} as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];

const forkCursor = {
  threadId: "parent-native-thread",
  forkFrom: { lastTurnId: "turn-9" },
};

const openForkedThread = (client: unknown) =>
  openCodexThread({
    client: client as Parameters<typeof openCodexThread>[0]["client"],
    threadId: ThreadId.make("child-thread"),
    runtimeMode: "full-access",
    cwd: "/tmp/project",
    requestedModel: undefined,
    serviceTier: undefined,
    resumeThreadId: "parent-native-thread",
    ...codexThreadForkOpenField(
      forkCursor,
      (client as { request: CodexThreadForkOpenRequest }).request,
    ),
  });

describe("codexThreadForkOpenField", () => {
  it("reads the cutoff from a fork cursor", () => {
    expect(codexThreadForkOpenField(forkCursor, undefined as never)).toEqual({
      forkFromLastTurnId: "turn-9",
    } as never);
  });

  it("ignores a plain resume cursor", () => {
    expect(codexThreadForkOpenField({ threadId: "native-1" }, undefined as never)).toEqual({});
  });

  it("reads the source thread id and rejects junk", () => {
    expect(readCodexForkSourceThreadId({ threadId: "native-1" })).toBe("native-1");
    expect(readCodexForkSourceThreadId({})).toBeUndefined();
    expect(readCodexForkSourceThreadId("native-1")).toBeUndefined();
  });
});

describe("openCodexThread fork branch", () => {
  it.effect("sends thread/fork from the parent at the captured turn, with no thread/start", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const client = {
        request: (method: "thread/start" | "thread/fork", payload: unknown) => {
          calls.push({ method, payload });
          return Effect.succeed(
            method === "thread/fork"
              ? makeForkResponse("forked-native-thread")
              : startParamsResponse,
          ) as never;
        },
        raw: {
          request: (method: string, payload: unknown) => {
            calls.push({ method, payload });
            return Effect.succeed(startParamsResponse as unknown);
          },
        },
      };
      const opened = yield* openForkedThread(client);
      expect(opened.thread.id).toBe("forked-native-thread");
      expect(calls.map((call) => call.method)).toEqual(["thread/fork"]);
      const payload = calls[0]?.payload as {
        threadId: string;
        lastTurnId: string;
        excludeTurns: boolean;
        cwd: string;
      };
      expect(payload.threadId).toBe("parent-native-thread");
      expect(payload.lastTurnId).toBe("turn-9");
      expect(payload.excludeTurns).toBe(true);
      expect(payload.cwd).toBe("/tmp/project");
    }),
  );

  it.effect("fails closed when the fork request errors — no thread/start fallback", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = {
        request: (method: "thread/start" | "thread/fork", _payload: unknown) => {
          calls.push(method);
          return method === "thread/fork"
            ? (Effect.fail(
                CodexErrors.CodexAppServerRequestError.methodNotFound("thread/fork"),
              ) as never)
            : (Effect.succeed(startParamsResponse) as never);
        },
        raw: {
          request: (method: string, _payload: unknown) => {
            calls.push(method);
            return Effect.succeed(startParamsResponse as unknown);
          },
        },
      };
      const exit = yield* Effect.exit(openForkedThread(client));
      NodeAssert.ok(exit._tag === "Failure");
      expect(calls).toEqual(["thread/fork"]);
    }),
  );

  it.effect("fails closed when no fork request is installed", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = {
        request: (method: "thread/start" | "thread/fork", _payload: unknown) => {
          calls.push(method);
          return Effect.succeed(
            method === "thread/fork"
              ? makeForkResponse("forked-native-thread")
              : startParamsResponse,
          ) as never;
        },
        raw: {
          request: (method: string, _payload: unknown) => {
            calls.push(method);
            return Effect.succeed(startParamsResponse as unknown);
          },
        },
      };
      const exit = yield* Effect.exit(
        openCodexThread({
          client: client as Parameters<typeof openCodexThread>[0]["client"],
          threadId: ThreadId.make("child-thread"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: undefined,
          serviceTier: undefined,
          resumeThreadId: "parent-native-thread",
          forkFromLastTurnId: "turn-9",
          // forkRequest deliberately absent.
        }),
      );
      NodeAssert.ok(exit._tag === "Failure");
      expect(calls).toEqual([]);
    }),
  );
});
