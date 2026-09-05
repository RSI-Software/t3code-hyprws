import { assert, it } from "@effect/vitest";
import {
  parseClaudeInitializationAgents,
  withClaudeAgentOptions,
} from "./ClaudeAgentOptions.fork.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type { ServerProviderModel } from "@t3tools/contracts";

it("normalizes SDK agents without changing first-definition precedence", () => {
  assert.deepStrictEqual(
    parseClaudeInitializationAgents([
      { name: " Beta ", description: " Two ", model: " " },
      { name: " alpha ", description: " One ", model: " opus " },
      { name: "ALPHA", description: "duplicate", model: "sonnet" },
      { name: "", description: "invalid" },
      { name: "invalid", description: " " },
    ]),
    [
      { name: "alpha", description: "One", model: "opus" },
      { name: "Beta", description: "Two" },
    ],
  );
  assert.deepStrictEqual(parseClaudeInitializationAgents(undefined), []);
});

it("preserves models without agents and existing options on every configured model", () => {
  const models: ReadonlyArray<ServerProviderModel> = [
    {
      slug: "one",
      name: "One",
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          { id: "thinking", type: "boolean", label: "Thinking", currentValue: true },
        ],
      }),
    },
    { slug: "two", name: "Two", isCustom: true, capabilities: null },
  ];
  assert.strictEqual(withClaudeAgentOptions(models, []), models);
  const adapted = withClaudeAgentOptions(models, [{ name: "reviewer", description: "Review" }]);
  assert.deepStrictEqual(
    adapted.map((model) => model.slug),
    ["one", "two"],
  );
  assert.deepStrictEqual(
    adapted[0]?.capabilities?.optionDescriptors?.[0],
    models[0]?.capabilities?.optionDescriptors?.[0],
  );
  assert.strictEqual(adapted[1]?.capabilities?.optionDescriptors?.[0]?.id, "agent");
  assert.strictEqual(models[0]?.capabilities?.optionDescriptors?.length, 1);
});
it("adds discovered Claude agents to every model", () => {
  const models = withClaudeAgentOptions(
    [{ slug: "claude-test", name: "Claude Test", isCustom: false, capabilities: null }],
    [{ name: "fable", description: "Shape product direction", model: "opus" }],
  );
  assert.deepEqual(models[0]?.capabilities?.optionDescriptors, [
    {
      id: "agent",
      label: "Agent",
      type: "select",
      description: "Run this thread as a Claude custom agent.",
      options: [
        {
          id: "default",
          label: "Default",
          description: "Use Claude without a custom main-thread agent.",
          isDefault: true,
        },
        { id: "fable", label: "fable", description: "Shape product direction" },
      ],
      currentValue: "default",
    },
  ]);
});
