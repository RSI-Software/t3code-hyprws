import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { type CodexAgentDefinition, discoverCodexAgents } from "../Drivers/CodexAgents.ts";
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

/**
 * Discovery needs `FileSystem` and `Path`, while the driver's provider check
 * runs at `R = never`. Acquire both once at instance creation and return a
 * decorator that folds discovered agents into an existing snapshot effect, so
 * the driver keeps upstream's snapshot composition and gains one call.
 */
export const makeCodexAgentOptionsDecorator = Effect.fn("makeCodexAgentOptionsDecorator")(
  function* (input: {
    readonly homePath?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly cwd?: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const agents = discoverCodexAgents(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    return <Snapshot extends { readonly models: ReadonlyArray<ServerProviderModel> }, E, R>(
      snapshot: Effect.Effect<Snapshot, E, R>,
    ): Effect.Effect<Snapshot, E, R> =>
      Effect.zipWith(
        snapshot,
        agents,
        (draft, discovered) => ({
          ...draft,
          models: withCodexAgentOptions(draft.models, discovered),
        }),
        { concurrent: true },
      );
  },
);
