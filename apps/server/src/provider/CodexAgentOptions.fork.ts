import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  createModelCapabilities,
  createModelSelection,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { type CodexAgentDefinition, discoverCodexAgents } from "./Drivers/CodexAgents.ts";
import { buildSelectOptionDescriptor } from "@t3tools/provider-core/server/snapshotProbe";

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

/** A turn selected a Codex custom agent that discovery no longer finds. */
export class CodexCustomAgentUnavailableError extends Schema.TaggedError<CodexCustomAgentUnavailableError>()(
  "CodexCustomAgentUnavailableError",
  { agent: Schema.String },
) {
  override get message(): string {
    return `Codex custom agent '${this.agent}' is no longer available.`;
  }
}

function codexAgentStringConfig(
  agent: CodexAgentDefinition | undefined,
  key: string,
): string | undefined {
  const value = agent?.config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Overlays an agent's `model` and `model_reasoning_effort` config on the turn's
 * selection. Codex applies a turn's model and effort to later turns too, so the
 * agent's choice holds until a turn under another selection replaces it.
 */
function withCodexAgentModelSelection(
  selection: ModelSelection,
  agent: CodexAgentDefinition | undefined,
): ModelSelection {
  const model = codexAgentStringConfig(agent, "model");
  const effort = codexAgentStringConfig(agent, "model_reasoning_effort");
  if (model === undefined && effort === undefined) return selection;
  return createModelSelection(selection.instanceId, model ?? selection.model, [
    ...(selection.options ?? []).filter(
      (option) => effort === undefined || option.id !== "reasoningEffort",
    ),
    ...(effort === undefined ? [] : [{ id: "reasoningEffort", value: effort }]),
  ]);
}

/**
 * The agent's instructions as a `turn/start.additionalContext` entry, beside
 * T3 Code's own. Codex resends an entry only when its value changes, so a
 * thread that switches agent gets the new instructions on its next turn.
 */
export function codexAgentAdditionalContext(
  additionalContext:
    | Readonly<Record<string, V2TurnStartParams__AdditionalContextEntry>>
    | undefined,
  agentInstructions: string | undefined,
): { readonly additionalContext?: Record<string, V2TurnStartParams__AdditionalContextEntry> } {
  if (agentInstructions === undefined) return {};
  return {
    additionalContext: {
      ...additionalContext,
      t3_code_agent: { kind: "application", value: agentInstructions },
    },
  };
}

/**
 * Resolves the turn's custom agent into the selection and instructions the
 * turn starts with. "default" and no selection both mean no agent and read
 * nothing from disk; a selected agent discovery no longer finds fails the turn.
 */
export const resolveCodexTurnAgent = Effect.fn("resolveCodexTurnAgent")(function* (request: {
  readonly modelSelection: ModelSelection;
  readonly settings: { readonly homePath?: string | undefined };
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | null;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const selectedAgent = getModelSelectionStringOptionValue(request.modelSelection, "agent");
  if (selectedAgent === undefined || selectedAgent === "default") {
    return { modelSelection: request.modelSelection, agentInstructions: undefined };
  }
  const agents = yield* discoverCodexAgents({
    ...(request.settings.homePath === undefined ? {} : { homePath: request.settings.homePath }),
    environment: request.environment,
    ...(request.cwd === null ? {} : { cwd: request.cwd }),
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, request.fileSystem),
    Effect.provide(NodePath.layer),
  );
  const agent = agents.find(
    (candidate) => candidate.name.toLowerCase() === selectedAgent.toLowerCase(),
  );
  if (agent === undefined) {
    return yield* new CodexCustomAgentUnavailableError({ agent: selectedAgent });
  }
  return {
    modelSelection: withCodexAgentModelSelection(request.modelSelection, agent),
    agentInstructions: agent.developerInstructions,
  };
});
