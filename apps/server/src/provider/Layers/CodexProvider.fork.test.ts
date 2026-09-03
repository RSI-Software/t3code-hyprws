import { assert, it } from "@effect/vitest";
import { withCodexAgentOptions } from "./CodexProvider.ts";
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
