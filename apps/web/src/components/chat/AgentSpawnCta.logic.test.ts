import { describe, expect, it } from "vite-plus/test";

import { resolveAgentSpawnOpenTarget } from "./AgentSpawnCta.logic";

describe("resolveAgentSpawnOpenTarget", () => {
  it("opens a single direct spawn", () => {
    expect(
      resolveAgentSpawnOpenTarget({
        workflowId: null,
        agentTaskIds: ["agent-1"],
        visibleAgentIds: ["agent-1"],
      }),
    ).toEqual({ selectedAgentId: "agent-1", rosterFocusAgentId: null });
  });

  it("opens a workflow's sole child instead of its coordinator", () => {
    expect(
      resolveAgentSpawnOpenTarget({
        workflowId: "workflow-1",
        agentTaskIds: ["workflow-1", "agent-1"],
        visibleAgentIds: ["agent-1"],
      }),
    ).toEqual({ selectedAgentId: "agent-1", rosterFocusAgentId: null });
  });

  it("reveals a multi-child group without selecting one", () => {
    expect(
      resolveAgentSpawnOpenTarget({
        workflowId: null,
        agentTaskIds: ["agent-1", "agent-2"],
        visibleAgentIds: ["agent-1", "agent-2"],
      }),
    ).toEqual({ selectedAgentId: null, rosterFocusAgentId: "agent-1" });
  });

  it("does not open the only currently visible member of a known fleet", () => {
    expect(
      resolveAgentSpawnOpenTarget({
        workflowId: null,
        agentTaskIds: ["agent-1", "agent-2"],
        visibleAgentIds: ["agent-1"],
      }),
    ).toEqual({ selectedAgentId: null, rosterFocusAgentId: "agent-1" });
  });
});
