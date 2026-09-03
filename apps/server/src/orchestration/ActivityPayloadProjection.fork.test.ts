import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  CorrelationId,
  EventId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import {
  projectActivityEvent,
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "./ActivityPayloadProjection.ts";
function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}
describe("projectActivityEvent", () => {
  function appendedEvent(activitySequence?: number): OrchestrationEvent {
    return {
      type: "thread.activity-appended",
      sequence: 42,
      eventId: EventId.make("event-42"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("thread-1"),
      occurredAt: "2026-08-01T10:00:00.000Z",
      commandId: CommandId.make("command-42"),
      causationEventId: null,
      correlationId: CorrelationId.make("command-42"),
      metadata: {},
      payload: {
        threadId: ThreadId.make("thread-1"),
        activity: {
          ...activity({ agentId: "agent-1" }),
          ...(activitySequence === undefined ? {} : { sequence: activitySequence }),
        },
      },
    } as OrchestrationEvent;
  }
  it("does not duplicate the envelope sequence on adapter-shaped live activity", () => {
    const projected = projectActivityEvent(appendedEvent());
    expect(projected.type).toBe("thread.activity-appended");
    if (projected.type !== "thread.activity-appended") return;
    expect(projected.payload.activity.sequence).toBeUndefined();
  });
  it("preserves an explicitly assigned activity sequence", () => {
    const projected = projectActivityEvent(appendedEvent(7));
    expect(projected.type).toBe("thread.activity-appended");
    if (projected.type !== "thread.activity-appended") return;
    expect(projected.payload.activity.sequence).toBe(7);
  });
});
describe("projectThreadDetailSnapshot", () => {
  it("omits redundant activity sequences from the full thread snapshot", () => {
    const projected = projectThreadDetailSnapshot({
      snapshotSequence: 42,
      thread: {
        activities: [{ ...activity({ agentId: "agent-1" }), sequence: 7 }],
      },
    } as unknown as OrchestrationThreadDetailSnapshot);
    expect(projected.thread.activities[0]?.sequence).toBeUndefined();
  });
});
