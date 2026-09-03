import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { derivePendingApprovals, sortThreadActivities } from "./threadActivity";
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
