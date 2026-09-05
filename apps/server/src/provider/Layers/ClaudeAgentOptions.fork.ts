import type { AgentInfo as ClaudeAgentInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
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
