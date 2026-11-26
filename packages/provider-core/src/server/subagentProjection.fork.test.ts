import { assert, it } from "@effect/vitest";
import {
  IssueTrackerKind,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { makeSubagentChildThread } from "./subagentProjection.ts";

it("a delegated child leaves its parent's issue links to the parent", () => {
  const now = DateTime.makeUnsafe("2026-11-26T09:00:00.000Z");
  const parentId = ThreadId.make("thread:parent");
  const instanceId = ProviderInstanceId.make("claude");
  const parent: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: parentId,
    projectId: ProjectId.make("project:app"),
    title: "Parent",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-haiku-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    issues: [
      {
        tracker: IssueTrackerKind.make("linear"),
        host: "linear.app",
        scope: "ENG",
        key: "ENG-1",
        projectId: ProjectId.make("project:app"),
        url: "https://linear.app/acme/issue/ENG-1",
        source: "agent",
        linkedAt: "2026-11-26T09:00:00.000Z",
        displayKey: "ENG-1",
        title: "Settings label says Setings",
      },
    ],
  };
  const child = makeSubagentChildThread({
    parentThread: parent,
    childThreadId: ThreadId.make("thread:child"),
    parentNodeId: NodeId.make("node:task"),
    activeProviderThreadId: null,
    providerInstanceId: instanceId,
    modelSelection: parent.modelSelection,
    title: "Child",
    now,
    createdBy: "agent",
    creationSource: "mcp",
  });
  assert.deepEqual(child.issues, []);
});
