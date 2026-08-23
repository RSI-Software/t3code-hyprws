import { assert, it } from "@effect/vitest";
import { withCodexAgentOptions } from "./CodexAgentOptions.fork.ts";
import type { ServerProviderModel } from "@t3tools/contracts";

it("keeps unextended Codex snapshots identical and discovery config immutable", () => {
  const models: ReadonlyArray<ServerProviderModel> = [
    { slug: "one", name: "One", isCustom: false, capabilities: null },
    { slug: "two", name: "Two", isCustom: true, capabilities: null },
  ];
  assert.strictEqual(withCodexAgentOptions(models, []), models);
  const agent = {
    name: "reviewer",
    description: "Review",
    developerInstructions: "Inspect first",
    config: { model: "gpt-review" },
    sourcePath: "/project/.codex/agents/reviewer.toml",
  };
  const adapted = withCodexAgentOptions(models, [agent]);
  assert.deepStrictEqual(
    adapted.map((model) => model.capabilities?.optionDescriptors?.[0]?.id),
    ["agent", "agent"],
  );
  assert.isNull(models[0]!.capabilities);
  assert.deepStrictEqual(agent.config, { model: "gpt-review" });
});
it("adds discovered Codex agents to every model", () => {
  const models = withCodexAgentOptions(
    [{ slug: "gpt-test", name: "GPT Test", isCustom: false, capabilities: null }],
    [
      {
        name: "fable",
        description: "Shape product direction",
        developerInstructions: "Work from first principles.",
        config: {},
        sourcePath: "/tmp/fable.toml",
      },
    ],
  );
  assert.deepStrictEqual(models[0]?.capabilities?.optionDescriptors, [
    {
      id: "agent",
      label: "Agent",
      type: "select",
      description: "Run this thread as a Codex custom agent.",
      options: [
        {
          id: "default",
          label: "Default",
          description: "Use Codex without a custom main-thread agent.",
          isDefault: true,
        },
        { id: "fable", label: "fable", description: "Shape product direction" },
      ],
      currentValue: "default",
    },
  ]);
});
