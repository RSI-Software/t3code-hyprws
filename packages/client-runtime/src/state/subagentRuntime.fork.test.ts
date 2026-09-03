import { describe, expect, it } from "vite-plus/test";
import { classifyTaskAgentKind, type OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  foldSubagentActivities,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isAgentAttributedToolActivity,
  isSubagentActivityKind,
  isTimelineBypassActivity,
  workflowCardMembers,
} from "./subagentRuntime.ts";
let sequence = 0;
/**
 * Fixtures model POST-INGESTION rows: ingestion stamps agentKind on every
 * task.* payload, so the helper stamps too (same classifier). Pass an
 * explicit agentKind (or agentKind: undefined via legacy()) to override.
 */
function activity(
  kind: string,
  payload: Record<string, unknown>,
  at = `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
): OrchestrationThreadActivity {
  sequence += 1;
  const stamped =
    kind.startsWith("task.") && !("agentKind" in payload)
      ? {
          ...payload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
            agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
          }),
        }
      : payload;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload: stamped,
    turnId: null,
    createdAt: at,
  } as unknown as OrchestrationThreadActivity;
}
/** A pre-stamp row (legacy thread / old server): no agentKind at all. */
function legacyActivity(
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  sequence += 1;
  return {
    id: `activity-${sequence}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: `2026-08-01T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}
function fold(rows: ReadonlyArray<OrchestrationThreadActivity>) {
  return foldSubagentActivities(rows);
}
describe("foldSubagentActivities", () => {
  it("folds the provider across the full task lifecycle", () => {
    const [agent] = fold([
      activity("task.started", { taskId: "provider-lifecycle", provider: "codex" }),
      activity("task.progress", {
        taskId: "provider-lifecycle",
        provider: "codex",
        summary: "Working",
      }),
      activity("task.updated", {
        taskId: "provider-lifecycle",
        provider: "codex",
        status: "waiting",
      }),
      activity("task.completed", {
        taskId: "provider-lifecycle",
        provider: "codex",
        status: "completed",
      }),
    ]);
    expect(agent?.provider).toBe("codex");
  });
  it("reconstructs provider from a retained terminal row", () => {
    const [agent] = fold([
      activity("task.completed", {
        taskId: "provider-reconstructed",
        provider: "claudeAgent",
        status: "completed",
      }),
    ]);
    expect(agent?.provider).toBe("claudeAgent");
  });
  it("keeps legacy provider unknown", () => {
    const [agent] = fold([
      activity("task.started", { taskId: "legacy-provider", taskType: "local_agent" }),
    ]);
    expect(agent?.provider).toBeNull();
  });
  it("ignores a malformed provider", () => {
    const [agent] = fold([
      activity("task.started", { taskId: "bad-provider", provider: "not a provider!" }),
    ]);
    expect(agent?.provider).toBeNull();
  });
  it("does not erase a known provider when a later row is missing or malformed", () => {
    const [agent] = fold([
      activity("task.started", { taskId: "sticky-provider", provider: "codex" }),
      activity("task.progress", {
        taskId: "sticky-provider",
        provider: "bad provider!",
        summary: "Still working",
      }),
      activity("task.updated", { taskId: "sticky-provider", status: "waiting" }),
    ]);
    expect(agent?.provider).toBe("codex");
  });
});
