import { assert, it } from "@effect/vitest";
import {
  CommandId,
  OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
type ProviderAdapterV2Shape = ProviderAdapterV2["Service"];
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

// Fork: Reset order dispatches `thread.active.reorder` with a null key, which
// returns the thread to automatic ordering.

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const adapter: ProviderAdapterV2Shape = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("active-order tests start no session"),
};
const layer = layerWithRegistry(
  { name: "active-order-reset-fork" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

const createThread = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("active-order-project"),
      title: "Active order",
      modelSelection: { instanceId, model: "test-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );

it.layer(layer)("active thread ordering reset (fork)", (it) => {
  it("accepts a null key on the wire", () => {
    const command = Schema.decodeSync(OrchestrationV2Command)({
      type: "thread.active.reorder",
      commandId: "active-order-wire",
      threadId: "active-order-wire",
      orderKey: null,
    });
    assert.deepInclude(command, { type: "thread.active.reorder", orderKey: null });
  });

  it.effect("clears the manual slot on a null reorder without touching updatedAt", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("active-order-reset");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.active.reorder",
        commandId: CommandId.make("active-order-place"),
        threadId,
        orderKey: "m",
      });
      const placed = (yield* orchestrator.getThreadProjection(threadId)).thread;
      assert.equal(placed.activeOrderKey, "m");

      yield* orchestrator.dispatch({
        type: "thread.active.reorder",
        commandId: CommandId.make("active-order-reset"),
        threadId,
        orderKey: null,
      });
      const reset = (yield* orchestrator.getThreadProjection(threadId)).thread;
      assert.isNull(reset.activeOrderKey);
      assert.isTrue(DateTime.Equivalence(reset.updatedAt, placed.updatedAt));
    }),
  );

  it.effect("rejects a null reorder on a settled thread", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("active-order-settled");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("active-order-settle"),
        threadId,
      });
      const error = yield* orchestrator
        .dispatch({
          type: "thread.active.reorder",
          commandId: CommandId.make("active-order-settled-reset"),
          threadId,
          orderKey: null,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
    }),
  );
});
