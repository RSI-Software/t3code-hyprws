import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import { resolveAgentPanelSelection, workflowContainsAgent } from "./AgentsPanel.logic";

const agent = (id: string): RuntimeSubagent => ({ id }) as RuntimeSubagent;
const group = {
  workflow: agent("workflow-1"),
  phases: [
    {
      index: 0,
      title: "Review",
      state: "pending",
      members: [agent("phase-agent")],
      activeCount: 0,
      settledCount: 0,
    },
  ],
  unphasedMembers: [agent("unphased-agent")],
} as unknown as AgentPanelWorkflowGroup;
const model = {
  directAgents: [agent("direct-agent")],
  workflows: [group],
} as unknown as AgentPanelModel;

describe("resolveAgentPanelSelection", () => {
  it("shows the roster without a selection", () => {
    expect(resolveAgentPanelSelection(model, null)).toEqual({ kind: "roster" });
  });

  it("resolves direct and nested agents", () => {
    expect(resolveAgentPanelSelection(model, "direct-agent")).toMatchObject({
      kind: "detail",
      agent: { id: "direct-agent" },
    });
    expect(resolveAgentPanelSelection(model, "phase-agent")).toMatchObject({
      kind: "detail",
      agent: { id: "phase-agent" },
    });
  });

  it("keeps a stale selection explicit while its agent is unavailable", () => {
    expect(resolveAgentPanelSelection(model, "not-retained")).toEqual({
      kind: "missing",
      agentId: "not-retained",
    });
  });
});

describe("workflowContainsAgent", () => {
  it("finds workflow, phased, and unphased focus targets", () => {
    expect(workflowContainsAgent(group, "workflow-1")).toBe(true);
    expect(workflowContainsAgent(group, "phase-agent")).toBe(true);
    expect(workflowContainsAgent(group, "unphased-agent")).toBe(true);
    expect(workflowContainsAgent(group, "other")).toBe(false);
  });
});
