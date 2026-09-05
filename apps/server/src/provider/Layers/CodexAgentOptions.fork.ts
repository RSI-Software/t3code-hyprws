import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { CodexAgentDefinition } from "../Drivers/CodexAgents.ts";
import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";

// Codex discovery and config precedence belong to CodexAgents. This helper
// adds the discovered selection at the driver's existing snapshot boundary.
export function withCodexAgentOptions(
  models: ReadonlyArray<ServerProviderModel>,
  agents: ReadonlyArray<CodexAgentDefinition>,
): ReadonlyArray<ServerProviderModel> {
  if (agents.length === 0) return models;
  const agentDescriptor = buildSelectOptionDescriptor({
    id: "agent",
    label: "Agent",
    description: "Run this thread as a Codex custom agent.",
    options: [
      {
        value: "default",
        label: "Default",
        description: "Use Codex without a custom main-thread agent.",
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
