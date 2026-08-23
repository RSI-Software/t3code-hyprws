import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverCodexAgents, parseCodexAgentDefinition } from "./CodexAgents.ts";

it("parses a Codex custom agent and keeps its config layer", () => {
  assert.deepEqual(
    parseCodexAgentDefinition(
      "/tmp/fable.toml",
      [
        'name = "fable"',
        'description = "Shape product direction"',
        'developer_instructions = "Work from first principles."',
        'model = "gpt-5.6-sol"',
        'model_reasoning_effort = "high"',
      ].join("\n"),
    ),
    {
      name: "fable",
      description: "Shape product direction",
      developerInstructions: "Work from first principles.",
      config: {
        model: "gpt-5.6-sol",
        model_reasoning_effort: "high",
      },
      sourcePath: "/tmp/fable.toml",
    },
  );
  assert.equal(parseCodexAgentDefinition("/tmp/broken.toml", "name = ["), undefined);
});

it.layer(NodeServices.layer)("Codex custom agent discovery", (it) => {
  it.effect("discovers user agents and lets project definitions override matching names", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-agents-" });
      const homePath = path.join(root, "home");
      const cwd = path.join(root, "project");
      const userAgents = path.join(homePath, "agents");
      const projectAgents = path.join(cwd, ".codex", "agents");
      yield* fileSystem.makeDirectory(userAgents, { recursive: true });
      yield* fileSystem.makeDirectory(projectAgents, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(userAgents, "fable.toml"),
        [
          'name = "fable"',
          'description = "User description"',
          'developer_instructions = "User instructions"',
        ].join("\n"),
      );
      yield* fileSystem.writeFileString(
        path.join(projectAgents, "fable.toml"),
        [
          'name = "fable"',
          'description = "Project description"',
          'developer_instructions = "Project instructions"',
        ].join("\n"),
      );

      const agents = yield* discoverCodexAgents({ homePath, cwd });

      assert.equal(agents.length, 1);
      assert.equal(agents[0]?.description, "Project description");
      assert.equal(agents[0]?.developerInstructions, "Project instructions");
      assert.equal(agents[0]?.sourcePath, path.join(projectAgents, "fable.toml"));
    }).pipe(Effect.scoped),
  );
});
