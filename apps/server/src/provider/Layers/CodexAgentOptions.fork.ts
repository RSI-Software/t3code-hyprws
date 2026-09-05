import {
  type ServerProviderModel,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ProviderAdapterValidationError } from "../Errors.ts";
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

export interface CodexSessionAgentRequest {
  readonly modelSelection: ModelSelection | undefined;
  readonly boundInstanceId: ProviderInstanceId;
  readonly homePath?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string | undefined;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/**
 * Resolves the thread's custom-agent selection at session start. A missing
 * selection fails with the adapter's validation error; "default" and no
 * selection both resolve to no agent. Self-provides the filesystem services
 * `discoverCodexAgents` needs so the adapter keeps a single `yield*`.
 */
export const resolveCodexSessionAgentOption = Effect.fn("resolveCodexSessionAgentOption")(
  function* (request: CodexSessionAgentRequest) {
    const modelSelection =
      request.modelSelection?.instanceId === request.boundInstanceId
        ? request.modelSelection
        : undefined;
    const selectedAgentName = getModelSelectionStringOptionValue(modelSelection, "agent");
    const cwd = request.cwd ?? process.cwd();
    const agent =
      selectedAgentName && selectedAgentName !== "default"
        ? (yield* discoverCodexAgents({
            ...(request.homePath !== undefined ? { homePath: request.homePath } : {}),
            ...(request.environment ? { environment: request.environment } : {}),
            cwd,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, request.fileSystem),
            Effect.provideService(Path.Path, request.path),
          )).find((candidate) => candidate.name.toLowerCase() === selectedAgentName.toLowerCase())
        : undefined;
    if (selectedAgentName && selectedAgentName !== "default" && !agent) {
      return yield* new ProviderAdapterValidationError({
        provider: ProviderDriverKind.make("codex"),
        operation: "startSession",
        issue: `Codex custom agent '${selectedAgentName}' is no longer available.`,
      });
    }
    return { agent, cwd };
  },
);

/** The `runtimeInput` spread a resolved agent contributes; empty without one. */
export function codexAgentRuntimeInput(agent: CodexAgentDefinition | undefined) {
  return agent ? { agent } : {};
}
