import type { ServerProviderModel } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeCodexAgentOptionsDecorator } from "../Layers/CodexAgentOptions.fork.ts";

const MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "gpt-test", name: "GPT Test", isCustom: false, capabilities: null },
];

type CodexSnapshot = {
  readonly status: "ready";
  readonly models: ReadonlyArray<ServerProviderModel>;
};

class CodexProbeError extends Data.TaggedError("CodexProbeError")<{ readonly detail: string }> {}

const AGENT_TOML = [
  'name = "reviewer"',
  'description = "Review the diff"',
  'developer_instructions = "Read the diff first."',
].join("\n");

// The driver composes discovery through this decorator so upstream keeps its
// snapshot pipeline, its `R = never` provider check and its own platform-service
// acquisition. These cover the behavior that boundary has to preserve.
it.layer(NodeServices.layer)("CodexDriver agent selection boundary", (it) => {
  it.effect("folds discovered agents into the snapshot the provider check already builds", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-driver-" });
      yield* fileSystem.makeDirectory(path.join(homePath, "agents"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(homePath, "agents", "reviewer.toml"), AGENT_TOML);

      const withCodexAgentSelection = yield* makeCodexAgentOptionsDecorator({ homePath });
      const snapshot = yield* withCodexAgentSelection(
        Effect.succeed<CodexSnapshot>({ status: "ready", models: MODELS }),
      );

      assert.equal(snapshot.status, "ready");
      assert.deepEqual(snapshot.models[0]?.capabilities?.optionDescriptors, [
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
            { id: "reviewer", label: "reviewer", description: "Review the diff" },
          ],
          currentValue: "default",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the snapshot untouched when no agent is discovered", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-driver-" });

      const withCodexAgentSelection = yield* makeCodexAgentOptionsDecorator({ homePath });
      const snapshot = yield* withCodexAgentSelection(
        Effect.succeed<CodexSnapshot>({ status: "ready", models: MODELS }),
      );

      assert.strictEqual(snapshot.models, MODELS);
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces the wrapped snapshot's failure instead of masking it with discovery", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-codex-driver-" });

      const withCodexAgentSelection = yield* makeCodexAgentOptionsDecorator({ homePath });
      const probe: Effect.Effect<CodexSnapshot, CodexProbeError> = Effect.fail(
        new CodexProbeError({ detail: "codex spawner unavailable" }),
      );
      const failure = yield* withCodexAgentSelection(probe).pipe(Effect.flip);

      assert.equal(failure.detail, "codex spawner unavailable");
    }).pipe(Effect.scoped),
  );
});
