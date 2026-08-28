import { describe, expect, it } from "vite-plus/test";
import { EventId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import type { OrchestrationThread } from "@t3tools/contracts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { forkSupersedes } from "../../../../scripts/lib/fork-supersedes.ts";
const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;
const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};
describe("applyThreadDetailEvent", () => {
  describe("thread.activity-appended", () => {
    it("preserves an explicit activity sequence over the event sequence", () => {
      const result = applyThreadDetailEvent(baseThread, {
        ...baseEventFields,
        sequence: 12,
        occurredAt: "2026-04-01T11:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.activity-appended",
        payload: {
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-explicit-sequence"),
            tone: "tool",
            kind: "file-edit",
            summary: "Edited src/index.ts",
            payload: {},
            turnId: TurnId.make("turn-1"),
            sequence: 7,
            createdAt: "2026-04-01T11:00:00.000Z",
          },
        },
      });
      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities[0]?.sequence).toBe(7);
      }
    });
    it("keeps legacy unsequenced history before newly sequenced live activity", () => {
      const legacyActivity = {
        id: EventId.make("activity-legacy-completed"),
        tone: "info" as const,
        kind: "agent-completed",
        summary: "Child completed",
        payload: {},
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-04-01T10:00:00.000Z",
      };
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: [legacyActivity] },
        {
          ...baseEventFields,
          sequence: 12,
          occurredAt: "2026-04-01T11:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-live-running"),
              tone: "info",
              kind: "agent-status",
              summary: "Child resumed",
              payload: { status: "running" },
              turnId: TurnId.make("turn-1"),
              createdAt: "2026-04-01T11:00:00.000Z",
            },
          },
        },
      );
      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((activity) => activity.id)).toEqual([
          "activity-legacy-completed",
          "activity-live-running",
        ]);
        expect(result.thread.activities[1]?.sequence).toBe(12);
      }
    });
    it("preserves authoritative reconnect snapshot order when live activity arrives", () => {
      const createdAt = "2026-04-01T10:00:00.000Z";
      const snapshotActivities = [
        {
          id: EventId.make("activity-z-spawned"),
          tone: "info" as const,
          kind: "agent-spawned",
          summary: "Child spawned",
          payload: {},
          turnId: TurnId.make("turn-1"),
          createdAt,
        },
        {
          id: EventId.make("activity-a-completed"),
          tone: "info" as const,
          kind: "agent-completed",
          summary: "Child completed",
          payload: {},
          turnId: TurnId.make("turn-1"),
          createdAt,
        },
      ];
      const result = applyThreadDetailEvent(
        { ...baseThread, activities: snapshotActivities },
        {
          ...baseEventFields,
          sequence: 12,
          occurredAt: "2026-04-01T11:00:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-live-running"),
              tone: "info",
              kind: "agent-status",
              summary: "Child resumed",
              payload: { status: "running" },
              turnId: TurnId.make("turn-1"),
              createdAt,
            },
          },
        },
      );
      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((activity) => activity.id)).toEqual([
          "activity-z-spawned",
          "activity-a-completed",
          "activity-live-running",
        ]);
        expect(result.thread.activities[2]?.sequence).toBe(12);
      }
    });
    forkSupersedes({
      upstream:
        "packages/client-runtime/src/state/threadReducer.test.ts > repairs snapshot ordering before fast-path appends engage",
      reason:
        "unsequenced activities predate server-side sequencing, so the fork orders them before sequenced ones instead of last",
      commit: "060b0670edf",
    });
    it("repairs snapshot ordering before fast-path appends engage, unsequenced rows first", () => {
      const makeActivity = (id: string, sequence: number | null) => ({
        id: EventId.make(id),
        tone: "tool" as const,
        kind: "command",
        summary: `Ran ${id}`,
        payload: {},
        turnId: TurnId.make("turn-1"),
        ...(sequence === null ? {} : { sequence }),
        createdAt: "2026-04-01T11:00:00.000Z",
      });
      // A snapshot arrives in DB order, which can transpose sequenced rows and
      // leads with the unsequenced ones; an in-order live append must repair
      // that whole prefix rather than freeze it behind the fast path.
      const result = applyThreadDetailEvent(
        {
          ...baseThread,
          activities: [
            makeActivity("activity-null", null),
            makeActivity("activity-b", 2),
            makeActivity("activity-a", 1),
          ],
        },
        {
          ...baseEventFields,
          sequence: 135,
          occurredAt: "2026-04-01T11:01:00.000Z",
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-1"),
          type: "thread.activity-appended",
          payload: {
            threadId: ThreadId.make("thread-1"),
            activity: makeActivity("activity-c", 3),
          },
        },
      );
      expect(result.kind).toBe("updated");
      if (result.kind === "updated") {
        expect(result.thread.activities.map((activity) => activity.id)).toEqual([
          "activity-null",
          "activity-a",
          "activity-b",
          "activity-c",
        ]);
      }
    });
  });
});
