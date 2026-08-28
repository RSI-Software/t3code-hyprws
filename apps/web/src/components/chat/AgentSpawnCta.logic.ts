export interface AgentSpawnOpenTarget {
  readonly selectedAgentId: string | null;
  readonly rosterFocusAgentId: string | null;
}

/** One child opens directly; a fleet opens the roster and focuses its first known member. */
export function resolveAgentSpawnOpenTarget(input: {
  readonly workflowId: string | null;
  readonly agentTaskIds: ReadonlyArray<string>;
  readonly visibleAgentIds: ReadonlyArray<string>;
}): AgentSpawnOpenTarget {
  const taskIds = new Set(input.agentTaskIds);
  const childTaskIds =
    input.workflowId === null
      ? [...taskIds]
      : [...taskIds].filter((taskId) => taskId !== input.workflowId);
  const visibleChildIds = input.visibleAgentIds.filter((agentId) => agentId !== input.workflowId);
  const singleAgentId =
    childTaskIds.length === 1
      ? childTaskIds[0]!
      : childTaskIds.length === 0 && visibleChildIds.length === 1
        ? visibleChildIds[0]!
        : null;
  return singleAgentId
    ? { selectedAgentId: singleAgentId, rosterFocusAgentId: null }
    : {
        selectedAgentId: null,
        rosterFocusAgentId: visibleChildIds[0] ?? childTaskIds[0] ?? input.workflowId,
      };
}
