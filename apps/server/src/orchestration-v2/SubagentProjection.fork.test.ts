import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { makeSubagentChildThread } from "./SubagentProjection.ts";

const parentThreadId = ThreadId.make("thread:subagent-watch-parent");
const providerInstanceId = ProviderInstanceId.make("codex");
const createdAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");

it("gives a subagent child the parent's pull requests without its watches", () => {
  const link = {
    host: "github.com",
    repository: "acme/app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    source: "agent",
    linkedAt: "2026-07-24T09:01:00.000Z",
    snapshot: null,
    stack: null,
  } as const;
  const watch = {
    startedAt: "2026-07-24T09:02:00.000Z",
    headSha: null,
    failedChecks: [],
    passed: false,
    remarksThrough: "2026-07-24T09:02:00.000Z",
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  };
  const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
  const parentThread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: parentThreadId,
    projectId: ProjectId.make("project:subagent-watch"),
    title: "Parent",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    pullRequests: [{ ...link, watch }],
  };
  const childThread = makeSubagentChildThread({
    parentThread,
    childThreadId: ThreadId.make("thread:subagent-watch-child"),
    parentNodeId: NodeId.make("node:subagent-parent"),
    activeProviderThreadId: null,
    providerInstanceId,
    modelSelection,
    title: "Child",
    now: createdAt,
    createdBy: "agent",
    creationSource: "provider",
  });

  assert.deepEqual(childThread.pullRequests, [link]);
  assert.deepEqual(parentThread.pullRequests?.[0]?.watch, watch);
});
