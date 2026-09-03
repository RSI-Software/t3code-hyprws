import { describe, expect, it } from "vite-plus/test";
import { codexFeedbackMessage } from "@t3tools/client-runtime/state/threads";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  buildPendingUserInputAnswers,
  buildThreadFeed,
  derivePendingApprovals,
  deriveThreadFeedPresentation,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  sortThreadActivities,
  togglePendingUserInputOptionSelection,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
} from "./threadActivity";
const singleSelectQuestion = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime should be used?",
  options: [
    { label: "Go", description: "One binary" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;
const multiSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "Which data should be collected?",
  options: [
    { label: "Orders", description: "Receipts" },
    { label: "Listings", description: "Inventory" },
  ],
  multiSelect: true,
} as const;
describe("pending approvals", () => {
  it("preserves snapshot order before sorting sequenced live activities", () => {
    const requested = makeActivity({
      id: EventId.make("z-approval-requested"),
      kind: "approval.requested",
      summary: "Approval requested",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { requestId: "req-snapshot", requestKind: "command" },
    });
    const resolved = makeActivity({
      id: EventId.make("a-approval-resolved"),
      kind: "approval.resolved",
      summary: "Approval resolved",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { requestId: "req-snapshot", decision: "accept" },
    });
    const laterLive = makeActivity({
      id: EventId.make("live-later"),
      kind: "runtime.warning",
      summary: "Later live activity",
      createdAt: "2026-08-24T00:00:00.000Z",
      sequence: 12,
    });
    const earlierLive = makeActivity({
      id: EventId.make("live-earlier"),
      kind: "runtime.warning",
      summary: "Earlier live activity",
      createdAt: "2026-08-24T00:00:00.000Z",
      sequence: 11,
    });
    const sorted = sortThreadActivities([requested, resolved, laterLive, earlierLive]);
    expect(sorted.map((activity) => activity.id)).toEqual([
      "z-approval-requested",
      "a-approval-resolved",
      "live-earlier",
      "live-later",
    ]);
    expect(derivePendingApprovals(sorted)).toEqual([]);
  });
});
function makeActivity(
  input: Partial<OrchestrationThreadActivity> &
    Pick<OrchestrationThreadActivity, "id" | "kind" | "summary" | "createdAt">,
): OrchestrationThreadActivity {
  return {
    tone: "info",
    payload: {},
    turnId: null,
    ...input,
  };
}
function makeThread(
  input: Partial<OrchestrationThread> & Pick<OrchestrationThread, "id" | "projectId" | "title">,
): OrchestrationThread {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...input,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
  };
}
