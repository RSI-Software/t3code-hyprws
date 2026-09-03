import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";
const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-06T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
};
describe("runtimeEventToActivities task provider ownership", () => {
  for (const providerName of ["codex", "claudeAgent"] as const) {
    it(`stamps ${providerName} on every reconstructable task lifecycle row`, () => {
      const provider = ProviderDriverKind.make(providerName);
      const taskId = RuntimeTaskId.make(`${providerName}-agent`);
      const events = [
        {
          ...base,
          provider,
          type: "task.started",
          eventId: EventId.make(`${providerName}-started`),
          payload: { taskId, description: "Child started" },
        },
        {
          ...base,
          provider,
          type: "task.progress",
          eventId: EventId.make(`${providerName}-progress`),
          payload: { taskId, description: "Child", summary: "Inspecting" },
        },
        {
          ...base,
          provider,
          type: "task.progress",
          eventId: EventId.make(`${providerName}-usage`),
          payload: { taskId, description: "Child", typedUsage: { totalTokens: 42 } },
        },
        {
          ...base,
          provider,
          type: "task.updated",
          eventId: EventId.make(`${providerName}-updated`),
          payload: { taskId, status: "waiting" },
        },
        {
          ...base,
          provider,
          type: "task.completed",
          eventId: EventId.make(`${providerName}-completed`),
          payload: { taskId, status: "completed", summary: "Done" },
        },
      ] satisfies ReadonlyArray<ProviderRuntimeEvent>;
      const activities = events.flatMap((event) => runtimeEventToActivities(event));
      expect(activities).toHaveLength(5);
      expect(activities.map((activity) => activity.kind)).toEqual([
        "task.started",
        "task.progress",
        "task.progress",
        "task.updated",
        "task.completed",
      ]);
      for (const activity of activities) {
        expect(activity.payload).toMatchObject({ provider });
        expect(activity).not.toHaveProperty("sequence");
      }
    });
  }
});
