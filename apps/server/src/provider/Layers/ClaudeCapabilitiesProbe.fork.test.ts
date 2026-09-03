import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  buildClaudeCapabilitiesProbeQueryOptions,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  probeClaudeCapabilities,
  withClaudeAgentOptions,
} from "./ClaudeProvider.ts";
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
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
