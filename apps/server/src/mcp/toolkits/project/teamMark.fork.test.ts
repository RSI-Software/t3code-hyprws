import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationMessageContext,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import type { Caller } from "../../threadAccess.ts";
import { teamMarkRightsFork } from "./teamMark.fork.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");
const userMessageId = MessageId.make("message-1");

const threadCaller = (context: OrchestrationMessageContext | undefined): Caller => ({
  scope: {
    environmentId: EnvironmentId.make("env-host"),
    requestNamespace: "thread",
    thread: {
      threadId,
      providerSessionId: "session-1",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    },
    client: undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  },
  caller: { id: threadId, activeRunId: runId, latestRunId: runId } as OrchestrationV2ThreadShell,
  threads: {
    getThreadRecords: () => Effect.succeed({ runs: [{ id: runId, userMessageId }] }),
    getMessagesById: () =>
      Effect.succeed(new Map([[userMessageId, { id: userMessageId, context }]])),
  } as unknown as ThreadManagement.ThreadManagementService["Service"],
  limits: { runtimeMode: "full-access", interactionMode: "default" },
});

const attributed = (
  attribution: Partial<OrchestrationMessageContext>,
): OrchestrationMessageContext => ({ version: 1, records: [], ...attribution });

const outcome = (caller: Caller) =>
  teamMarkRightsFork(caller).pipe(
    Effect.match({ onFailure: (error) => error.code, onSuccess: () => "allowed" }),
  );

it.effect("an agent marks a team project only for a user who holds sharing rights", () =>
  Effect.gen(function* () {
    expect(yield* outcome(threadCaller(undefined))).toBe("allowed");
    expect(
      yield* outcome(
        threadCaller(attributed({ collaboratorFork: { name: "Alex", text: "hi", host: true } })),
      ),
    ).toBe("allowed");

    expect(
      yield* outcome(
        threadCaller(attributed({ collaboratorFork: { name: "Jordan", text: "mark it" } })),
      ),
    ).toBe("capability_denied");
    expect(
      yield* outcome(
        threadCaller(
          attributed({ collaboratorFork: { name: "Jordan", text: "mark it", sentByHost: true } }),
        ),
      ),
    ).toBe("capability_denied");
    const client = threadCaller(undefined);
    const fullAccessClient: Caller = {
      ...client,
      caller: undefined,
      scope: {
        ...client.scope,
        thread: undefined,
        client: { sessionId: "client-1", label: "Claude Code", access: "full-access" },
      },
    };
    expect(yield* outcome(fullAccessClient)).toBe("capability_denied");
  }),
);
