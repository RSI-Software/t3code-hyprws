import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import * as CodexRpc from "effect-codex-app-server/rpc";
import { buildTurnStartParams, openCodexThread } from "./CodexSessionRuntime.ts";
function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}
describe("buildTurnStartParams", () => {
  it.effect("keeps custom-agent instructions when applying T3 collaboration mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Implement it",
        model: "gpt-5.6-sol",
        effort: "high",
        interactionMode: "default",
        agentDeveloperInstructions: "Work from first principles.",
      });
      const instructions = params.collaborationMode?.settings.developer_instructions;
      NodeAssert.ok(instructions?.startsWith("Work from first principles.\n\n"));
      NodeAssert.ok(instructions?.includes("as gpt-5.6-sol with high"));
    }),
  );
});
describe("openCodexThread", () => {
  it.effect("layers a selected Codex custom agent onto thread start", () =>
    Effect.gen(function* () {
      const calls: Array<{
        method: "thread/start" | "thread/resume";
        payload: unknown;
      }> = [];
      const started = makeThreadOpenResponse("agent-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };
      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-agent"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.6-sol",
        serviceTier: undefined,
        resumeThreadId: undefined,
        agent: {
          name: "fable",
          description: "Shape product direction",
          developerInstructions: "Work from first principles.",
          config: {
            model: "gpt-5.6-sol",
            model_reasoning_effort: "high",
          },
          sourcePath: "/tmp/fable.toml",
        },
      });
      NodeAssert.deepStrictEqual(calls, [
        {
          method: "thread/start",
          payload: {
            cwd: "/tmp/project",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            approvalsReviewer: "user",
            model: "gpt-5.6-sol",
            developerInstructions: "Work from first principles.",
            config: {
              model: "gpt-5.6-sol",
              model_reasoning_effort: "high",
            },
          },
        },
      ]);
    }),
  );
});
