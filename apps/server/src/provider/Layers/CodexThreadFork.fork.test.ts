// Fork-only: the lazy Codex fork — the runtime reads the handler-written
// cursor and sends `thread/fork` on the client's raw request channel at the
// child's first start, failing closed with no `thread/start` fallback.
import * as NodeAssert from "node:assert/strict";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import { ThreadId } from "@t3tools/contracts";

import { openCodexThread } from "./CodexSessionRuntime.ts";
import {
  codexThreadForkOpenField,
  readCodexForkCutoffFork,
  readCodexForkSourceThreadId,
} from "./CodexThreadFork.fork.ts";

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
};

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
    ...codexThreadForkOpenField(forkCursor),
  });

/**
 * The fork branch must ride the raw channel only; the shaped `request`
 * (thread/start's home) fails the test if it is ever touched.
 */
const rawClient = (
  onCall: (method: string, payload: unknown) => Effect.Effect<unknown, unknown>,
) => ({
  raw: { request: onCall },
  request: () => Effect.die("thread/start must not be called on the fork path") as never,
});

describe("codexThreadForkOpenField", () => {
  it("reads the cutoff from a fork cursor", () => {
    expect(codexThreadForkOpenField(forkCursor)).toEqual({ forkFromLastTurnId: "turn-9" });
  });

  it("ignores a plain resume cursor", () => {
    expect(codexThreadForkOpenField({ threadId: "native-1" })).toEqual({});
  });

  it("reads the source thread id and rejects junk", () => {
    expect(readCodexForkSourceThreadId({ threadId: "native-1" })).toBe("native-1");
    expect(readCodexForkSourceThreadId({})).toBeUndefined();
    expect(readCodexForkSourceThreadId("native-1")).toBeUndefined();
  });

  it("reads a fork cursor's own cutoff and rejects junk", () => {
    expect(readCodexForkCutoffFork(forkCursor)).toBe("turn-9");
    expect(readCodexForkCutoffFork({ threadId: "native-1" })).toBeUndefined();
    expect(readCodexForkCutoffFork({ threadId: "p", forkFrom: {} })).toBeUndefined();
    expect(readCodexForkCutoffFork(null)).toBeUndefined();
  });
});

describe("openCodexThread fork branch", () => {
  it.effect("sends thread/fork from the parent at the captured turn, with no thread/start", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const client = rawClient((method, payload) => {
        calls.push({ method, payload });
        return Effect.succeed({
          ...startParamsResponse,
          thread: { ...startParamsResponse.thread, id: "forked-native-thread" },
        });
      });
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
      const client = rawClient((method) => {
        calls.push(method);
        return Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound("thread/fork"));
      });
      const exit = yield* Effect.exit(openForkedThread(client));
      NodeAssert.ok(exit._tag === "Failure");
      expect(calls).toEqual(["thread/fork"]);
    }),
  );
});
