import { resolveAgentSpawnOpenTarget } from "./AgentSpawnCta.logic";

interface OpenAgentsChildWork {
  (): void;
  (selectedAgentId: string | null, rosterFocusAgentId: string | null): void;
}

/** Bind one upstream spawn CTA to the fork's child-detail or fleet-roster route. */
export function createAgentSpawnOpenHandler(input: {
  readonly workflowId: string | null;
  readonly agentTaskIds: ReadonlyArray<string>;
  readonly visibleAgentIds: ReadonlyArray<string>;
  readonly onOpenAgents: OpenAgentsChildWork;
}): () => void {
  const target = resolveAgentSpawnOpenTarget(input);
  return () => input.onOpenAgents(target.selectedAgentId, target.rosterFocusAgentId);
}
