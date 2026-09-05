import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vite-plus/test";
import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { probeClaudeCapabilities } from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.effect("carries the init reply's agents onto the probed capabilities", () =>
  Effect.gen(function* () {
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
      () =>
        ({
          initializationResult: async () => ({
            account: { email: "dev@example.com" },
            commands: [],
            agents: [{ name: "fable", description: "Shape product direction", model: "opus" }],
          }),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
            rate_limits_available: false,
          }),
        }) as unknown as ReturnType<typeof ClaudeSdk.query>,
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const capabilities = yield* probeClaudeCapabilities(
      decodeClaudeSettings({ binaryPath: "claude" }),
    );
    assert.deepEqual(capabilities?.agents, [
      { name: "fable", description: "Shape product direction", model: "opus" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
