import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationMessageContext,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { requireTeamMarkRightsFork } from "./teamMark.fork.ts";

const parentId = ThreadId.make("thread-parent");
const childId = ThreadId.make("thread-child");
const runId = RunId.make("run-1");

interface FixtureThread {
  readonly parent?: ThreadId;
  /** The user messages of `runId`, first one starting it. */
  readonly messages: ReadonlyArray<OrchestrationMessageContext | undefined>;
}

const attributed = (
  attribution: Partial<OrchestrationMessageContext>,
): OrchestrationMessageContext => ({ version: 1, records: [], ...attribution });
const collaborator = attributed({ collaboratorFork: { name: "Jordan", text: "mark it" } });

const threadsOf = (fixtures: Record<ThreadId, FixtureThread>) => {
  const shell = (id: ThreadId) => ({
    id,
    deletedAt: null,
    activeRunId: runId,
    latestRunId: runId,
    runtimeMode: "full-access",
    interactionMode: "default",
    lineage: {
      parentThreadId: fixtures[id]?.parent ?? null,
      relationshipToParent: fixtures[id]?.parent === undefined ? null : "subagent",
      rootThreadId: parentId,
    },
  });
  const messages = (id: ThreadId) =>
    (fixtures[id]?.messages ?? []).map((context, index) => ({
      id: MessageId.make(`${id}-message-${index}`),
      runId,
      role: "user",
      context,
    }));
  return Layer.succeed(ThreadManagement.ThreadManagementService, {
    getThreadShell: (id: ThreadId) => Effect.succeed(shell(id)),
    getThreadRecords: (id: ThreadId) =>
      Effect.succeed({
        thread: shell(id),
        runs: [{ id: runId, userMessageId: messages(id)[0]?.id }],
        messages: messages(id),
        subagents: Object.entries(fixtures)
          .filter(([, child]) => child.parent === id)
          .map(([child]) => ({ id: NodeId.make("task-1"), runId, childThreadId: child })),
      }),
    getMessagesById: (id: ThreadId) =>
      Effect.succeed(new Map(messages(id).map((message) => [message.id, message]))),
  } as unknown as ThreadManagement.ThreadManagementService["Service"]);
};

const scope = (
  caller: { readonly threadId: ThreadId } | { readonly client: true },
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-host"),
  requestNamespace: "thread",
  thread:
    "threadId" in caller
      ? {
          threadId: caller.threadId,
          providerSessionId: "session-1",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        }
      : undefined,
  client:
    "client" in caller
      ? { sessionId: "client-1", label: "Claude Code", access: "full-access" }
      : undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const markAs = (
  caller: { readonly threadId: ThreadId } | { readonly client: true },
  fixtures: Record<ThreadId, FixtureThread>,
) => {
  const threads = threadsOf(fixtures);
  return requireTeamMarkRightsFork({ teamFork: true }).pipe(
    Effect.match({ onFailure: (error) => error.code, onSuccess: () => "allowed" }),
    Effect.provide(
      Layer.merge(threads, Layer.succeed(McpInvocationContext.McpInvocationContext, scope(caller))),
    ),
  );
};

const asParent = (...messages: FixtureThread["messages"]) =>
  markAs({ threadId: parentId }, { [parentId]: { messages } });

it.effect("an agent marks a team project only for a user who holds sharing rights", () =>
  Effect.gen(function* () {
    expect(yield* asParent(undefined)).toBe("allowed");
    expect(
      yield* asParent(attributed({ collaboratorFork: { name: "Alex", text: "hi", host: true } })),
    ).toBe("allowed");
    expect(yield* asParent(collaborator)).toBe("capability_denied");
    expect(
      yield* asParent(
        attributed({ collaboratorFork: { name: "Jordan", text: "mark it", sentByHost: true } }),
      ),
    ).toBe("capability_denied");
    expect(yield* markAs({ client: true }, {})).toBe("capability_denied");
  }),
);

it.effect("a collaborator steering the host's run takes the host's rights away", () =>
  Effect.gen(function* () {
    expect(yield* asParent(undefined, collaborator)).toBe("capability_denied");
  }),
);

it.effect("a delegated agent holds the rights of the run that delegated it", () =>
  Effect.gen(function* () {
    const delegated = (parentMessages: FixtureThread["messages"]) =>
      markAs(
        { threadId: childId },
        {
          [parentId]: { messages: parentMessages },
          [childId]: { parent: parentId, messages: [undefined] },
        },
      );
    expect(yield* delegated([undefined])).toBe("allowed");
    expect(yield* delegated([collaborator])).toBe("capability_denied");
  }),
);
