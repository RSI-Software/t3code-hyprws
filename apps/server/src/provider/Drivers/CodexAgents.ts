import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseToml } from "smol-toml";

import { expandHomePath } from "../../pathExpansion.ts";

export interface CodexAgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly developerInstructions: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly sourcePath: string;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseCodexAgentDefinition(
  sourcePath: string,
  contents: string,
): CodexAgentDefinition | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(contents) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const name = nonEmptyString(parsed.name);
  const description = nonEmptyString(parsed.description);
  const developerInstructions = nonEmptyString(parsed.developer_instructions);
  if (!name || !description || !developerInstructions) {
    return undefined;
  }

  const {
    name: _name,
    description: _description,
    developer_instructions: _developerInstructions,
    ...config
  } = parsed;

  return {
    name,
    description,
    developerInstructions,
    config,
    sourcePath,
  };
}

function resolveCodexHomePath(input: {
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): string {
  const configuredHome = input.homePath?.trim() || input.environment?.CODEX_HOME?.trim();
  return configuredHome ? expandHomePath(configuredHome) : `${NodeOS.homedir()}/.codex`;
}

const readAgentDirectory = Effect.fn("CodexAgents.readDirectory")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));

  return yield* Effect.forEach(
    entries.filter((entry) => entry.endsWith(".toml")).sort(),
    (entry) => {
      const sourcePath = path.join(directory, entry);
      return fileSystem.readFileString(sourcePath).pipe(
        Effect.map((contents) => parseCodexAgentDefinition(sourcePath, contents)),
        Effect.orElseSucceed(() => undefined),
      );
    },
    { concurrency: "unbounded" },
  ).pipe(Effect.map((agents) => agents.filter((agent) => agent !== undefined)));
});

/** Discover user agents, then let project agents override matching names. */
export const discoverCodexAgents = Effect.fn("discoverCodexAgents")(function* (input: {
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}) {
  const path = yield* Path.Path;
  const directories = [path.join(resolveCodexHomePath(input), "agents")];
  if (input.cwd) {
    directories.push(path.join(input.cwd, ".codex", "agents"));
  }

  const agentsByName = new Map<string, CodexAgentDefinition>();
  for (const directory of directories) {
    const agents = yield* readAgentDirectory(directory);
    for (const agent of agents) {
      agentsByName.set(agent.name.toLowerCase(), agent);
    }
  }

  return [...agentsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
