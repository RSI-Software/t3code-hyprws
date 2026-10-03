import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveCodexTurnAgent } from "../../provider/Layers/CodexAgentOptions.fork.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

const SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
  options: [{ id: "reasoningEffort", value: "low" }],
} satisfies ModelSelection;

const withAgent = (agent: string): ModelSelection => ({
  ...SELECTION,
  options: [...SELECTION.options, { id: "agent", value: agent }],
});

it.layer(NodeServices.layer)("Codex main-thread agent selection", (it) => {
  const turnParams = (modelSelection: ModelSelection, hasT3Mcp: boolean) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-agent-" });
      yield* fileSystem.makeDirectory(path.join(homePath, "agents"));
      yield* fileSystem.writeFileString(
        path.join(homePath, "agents", "reviewer.toml"),
        [
          'name = "reviewer"',
          'description = "Review changes"',
          'developer_instructions = "Inspect before editing."',
          'model = "gpt-review"',
          'model_reasoning_effort = "high"',
        ].join("\n"),
      );
      const agent = yield* resolveCodexTurnAgent({
        modelSelection,
        settings: { homePath },
        environment: {},
        cwd: null,
        fileSystem,
      });
      return yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-agent",
        codexInput: [{ type: "text", text: "review this" }],
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
        modelSelection: agent.modelSelection,
        hasT3Mcp,
        agentInstructions: agent.agentInstructions,
      });
    }).pipe(Effect.scoped);

  it.effect("starts the turn with the agent's model, effort and instructions", () =>
    Effect.gen(function* () {
      const params = yield* turnParams(withAgent("Reviewer"), true);
      assert.equal(params.model, "gpt-review");
      assert.equal(params.effort, "high");
      assert.deepEqual(params.additionalContext?.t3_code_agent, {
        kind: "application",
        value: "Inspect before editing.",
      });
      assert.property(params.additionalContext ?? {}, "t3_code_orchestration");
      const withoutT3Mcp = yield* turnParams(withAgent("reviewer"), false);
      assert.deepEqual(Object.keys(withoutT3Mcp.additionalContext ?? {}), ["t3_code_agent"]);
    }),
  );

  it.effect("starts the turn unchanged without an agent or with default", () =>
    Effect.gen(function* () {
      const baseline = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-agent",
        codexInput: [{ type: "text", text: "review this" }],
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
        modelSelection: SELECTION,
        hasT3Mcp: true,
      });
      assert.deepEqual(yield* turnParams(SELECTION, true), baseline);
      assert.deepEqual(yield* turnParams(withAgent("default"), true), baseline);
    }),
  );

  it.effect("fails the turn when the selected agent is gone", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(turnParams(withAgent("missing"), true));
      assert.equal(error._tag, "CodexCustomAgentUnavailableError");
    }),
  );
});
