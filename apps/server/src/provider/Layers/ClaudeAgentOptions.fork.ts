import type { AgentInfo as ClaudeAgentInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";

// The SDK supplies Claude agents. Keep their normalization and presentation
// separate from upstream's provider initialization, auth and usage probes.
export function parseClaudeInitializationAgents(
  agents: ReadonlyArray<ClaudeAgentInfo> | undefined,
): ReadonlyArray<ClaudeAgentInfo> {
  const agentsByName = new Map<string, ClaudeAgentInfo>();
  for (const agent of agents ?? []) {
    const name = agent.name.trim();
    const description = agent.description.trim();
    if (!name || !description) continue;
    const key = name.toLowerCase();
    if (agentsByName.has(key)) continue;
    const model = agent.model?.trim();
    agentsByName.set(key, { name, description, ...(model ? { model } : {}) });
  }
  return [...agentsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

// The probe's `agents` field. An init reply naming no agents omits it, so an
// agentless probe keeps upstream's capability shape.
export function claudeInitializationAgentsField(
  agents: ReadonlyArray<ClaudeAgentInfo> | undefined,
): { readonly agents?: ReadonlyArray<ClaudeAgentInfo> } {
  const parsed = parseClaudeInitializationAgents(agents);
  return parsed.length > 0 ? { agents: parsed } : {};
}

export function withClaudeAgentOptions(
  models: ReadonlyArray<ServerProviderModel>,
  agents: ReadonlyArray<ClaudeAgentInfo>,
): ReadonlyArray<ServerProviderModel> {
  if (agents.length === 0) return models;
  const agentDescriptor = buildSelectOptionDescriptor({
    id: "agent",
    label: "Agent",
    description: "Run this thread as a Claude custom agent.",
    options: [
      {
        value: "default",
        label: "Default",
        description: "Use Claude without a custom main-thread agent.",
        isDefault: true,
      },
      ...agents.map((agent) => ({
        value: agent.name,
        label: agent.name,
        description: agent.description,
      })),
    ],
  });
  return models.map((model) => ({
    ...model,
    capabilities: createModelCapabilities({
      optionDescriptors: [...(model.capabilities?.optionDescriptors ?? []), agentDescriptor],
    }),
  }));
}

/**
 * A selected agent overrides whatever `--agent` the configured launch args
 * carry, and "default" clears it. Startup and resume build their launch args
 * from the same place, so a selection survives a resumed session.
 */
function withClaudeAgentLaunchArgs(
  configured: Record<string, string | null>,
  selectedAgent: string | undefined,
): Record<string, string | null> {
  if (selectedAgent === undefined) return configured;
  const { agent: _configuredAgent, ...withoutAgent } = configured;
  return selectedAgent === "default" ? withoutAgent : { ...withoutAgent, agent: selectedAgent };
}

/**
 * Applies the thread's agent selection in place to the launch args a query is
 * built from, with the `withClaudeAgentLaunchArgs` precedence: a selected agent
 * overrides a configured `--agent` and "default" clears it. Without a
 * selection the configured args stay as they are.
 */
export function applyClaudeAgentLaunchArg(
  extraArgs: Record<string, string | null>,
  modelSelection: ModelSelection,
): void {
  const selectedAgent = getModelSelectionStringOptionValue(modelSelection, "agent");
  if (selectedAgent === undefined) return;
  delete extraArgs.agent;
  if (selectedAgent !== "default") extraArgs.agent = selectedAgent;
}

/**
 * Folds the agent selection into a compiled selection's query identity, so a
 * changed agent reopens the thread's query with resume. Without a selection
 * the identity is upstream's.
 */
export function withClaudeAgentQueryIdentity<Compiled extends { readonly queryIdentity: string }>(
  compiled: Compiled,
  modelSelection: ModelSelection,
): Compiled {
  const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
  if (agent === undefined) return compiled;
  return { ...compiled, queryIdentity: JSON.stringify([compiled.queryIdentity, { agent }]) };
}
