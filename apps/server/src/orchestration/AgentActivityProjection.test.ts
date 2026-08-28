import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectAgentActivity } from "./AgentActivityProjection.ts";

function activity(payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make("activity-1"),
    tone: "tool",
    kind: "tool.completed",
    summary: "Read /home/alice/private/project/file.ts",
    payload,
    turnId: null,
    sequence: 7,
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

describe("projectAgentActivity", () => {
  it("removes local paths while preserving relative diff paths", () => {
    const projected = projectAgentActivity(
      activity({
        agentId: "agent-1",
        runHandles: {
          runId: "run-1",
          scriptPath: "/home/alice/.claude/projects/workflow.js",
          transcriptDir: "/home/alice/.claude/transcripts/run-1",
          sessionUrl: "https://example.test/session/1",
        },
        files: [{ path: "src/index.ts" }, { path: "/home/alice/private/secret.ts" }],
      }),
    );

    expect(projected.summary).toBe("Read [local path]");
    expect(projected.payload).toEqual({
      agentId: "agent-1",
      runHandles: { runId: "run-1", sessionUrl: "https://example.test/session/1" },
      files: [{ path: "src/index.ts" }, {}],
    });
    expect(projected.truncated).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("/home/alice");
  });

  it("caps nested strings, collections, and depth and reports truncation", () => {
    const projected = projectAgentActivity(
      activity({
        entries: Array.from({ length: 75 }, (_, index) => ({ index })),
        detail: "x".repeat(20_000),
        deep: { one: { two: { three: { four: { five: { six: "hidden" } } } } } },
      }),
    );

    expect(projected.truncated).toBe(true);
    expect(JSON.stringify(projected.payload).length).toBeLessThan(17_000);
    expect((projected.payload as { entries: unknown[] }).entries).toHaveLength(50);
  });
});
