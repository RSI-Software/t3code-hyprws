import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";

export type AgentPanelSelection =
  | { readonly kind: "roster" }
  | { readonly kind: "detail"; readonly agent: RuntimeSubagent }
  | { readonly kind: "missing"; readonly agentId: string };

export function agentPanelAgents(model: AgentPanelModel): ReadonlyArray<RuntimeSubagent> {
  return [
    ...model.directAgents,
    ...model.workflows.flatMap((group) => [
      group.workflow,
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedMembers,
    ]),
  ];
}

export function resolveAgentPanelSelection(
  model: AgentPanelModel,
  selectedAgentId: string | null,
): AgentPanelSelection {
  if (selectedAgentId === null) return { kind: "roster" };
  const agent = agentPanelAgents(model).find((candidate) => candidate.id === selectedAgentId);
  return agent ? { kind: "detail", agent } : { kind: "missing", agentId: selectedAgentId };
}

export function workflowContainsAgent(
  group: AgentPanelWorkflowGroup,
  agentId: string | null,
): boolean {
  if (agentId === null) return false;
  return (
    group.workflow.id === agentId ||
    group.unphasedMembers.some((member) => member.id === agentId) ||
    group.phases.some((phase) => phase.members.some((member) => member.id === agentId))
  );
}
