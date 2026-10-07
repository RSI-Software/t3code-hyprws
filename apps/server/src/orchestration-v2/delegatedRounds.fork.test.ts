import { assert, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2Subagent,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { decideDelegatedRoundFork, delegatedRoundCoveredFork } from "./delegatedRounds.fork.ts";

const now = DateTime.makeUnsafe("2026-10-07T00:00:00.000Z");
const parentThreadId = ThreadId.make("thread:parent");
const childThreadId = ThreadId.make("thread:child");
const task: OrchestrationV2Subagent = {
  id: NodeId.make("node:task"),
  threadId: parentThreadId,
  runId: RunId.make("run:parent-1"),
  parentNodeId: NodeId.make("node:parent"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerThreadId: null,
  childThreadId,
  nativeTaskRef: null,
  prompt: "Review",
  title: null,
  model: null,
  status: "completed",
  result: "done",
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};
const decide = (runs: ReadonlyArray<{ readonly status: "completed" | "running" }>) =>
  decideDelegatedRoundFork({
    continueTaskId: task.id,
    parentThreadId,
    parentRunId: RunId.make("run:parent-2"),
    subagents: [task],
    child: { thread: { id: childThreadId, archivedAt: null, deletedAt: null }, runs },
    completionWake: undefined,
    now,
  });

it("refuses a round while the child still runs work of its own", () => {
  assert.deepInclude(decide([{ status: "completed" }, { status: "running" }]), {
    refused: `Task ${task.id} has child work still running; wait for it to finish.`,
  });
  assert.include(decide([{ status: "completed" }]), { status: "running" });
});

it("treats a transfer without a run key as the first round's result only", () => {
  const legacy = {
    type: "subagent_result",
    sourcePoint: { threadId: childThreadId },
  } as OrchestrationV2ContextTransfer;
  const running = { status: "running" } as const;
  assert.isTrue(
    delegatedRoundCoveredFork(running, legacy, { id: RunId.make("run:1"), ordinal: 1 }),
  );
  assert.isFalse(
    delegatedRoundCoveredFork(running, legacy, { id: RunId.make("run:2"), ordinal: 2 }),
  );
  assert.isTrue(delegatedRoundCoveredFork(task, legacy, { id: RunId.make("run:2"), ordinal: 2 }));
});
