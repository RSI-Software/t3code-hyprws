import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { pullRequestWatchWakePrefix } from "./pullRequestWatch.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

// Fork: a pull request watch wake queued behind a busy turn is cancelled when its watch ends,
// so the agent is not woken about a pull request it stopped watching or that merged meanwhile.

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const adapter: ProviderAdapterV2Shape = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("watch wake tests start no session"),
};
const layer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "pull-request-watch-wakes-fork" },
  ProviderAdapterRegistry.makeLayer([adapter]),
  { runEffectWorker: false },
);

const threadId = ThreadId.make("pr-watch-wakes");
const repository = { host: "github.com", repository: "rsi-software/t3code-hyprws" };

it.layer(layer)("pull request watch wakes (fork)", (it) => {
  it.effect("cancels the queued wakes of a watch that ends, and keeps its last wake", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("pr-watch-wakes-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-wakes-project"),
        title: "Watch wakes",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const number of [7, 8, 9]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-wakes-start-${number}`),
          threadId,
          ...repository,
          number,
          watching: true,
          link: {
            url: `https://github.com/rsi-software/t3code-hyprws/pull/${number}`,
            source: "agent",
          },
        });
      }
      // The agent is busy, so every wake below queues behind this turn.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("pr-watch-wakes-busy"),
        threadId,
        messageId: MessageId.make("pr-watch-wakes-busy"),
        text: "Busy",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });

      const linkOf = (number: number) =>
        Effect.map(orchestrator.getThreadShell(threadId), (thread) =>
          thread?.pullRequests?.find((link) => link.number === number),
        );
      const sync = (number: number, ending: boolean, wake: string | null) =>
        Effect.gen(function* () {
          const link = yield* linkOf(number);
          if (link?.watch === undefined) return yield* Effect.die(`#${number} is not watched`);
          yield* orchestrator.dispatch({
            type: "thread.pull-request-watch.sync",
            commandId: CommandId.make(`pr-watch-wakes-sync-${number}-${wake ?? "end"}`),
            threadId,
            ...repository,
            number,
            startedAt: link.watch.startedAt,
            watch: ending ? null : { ...link.watch, wakes: link.watch.wakes + 1 },
            ...(wake === null
              ? {}
              : {
                  wake: {
                    messageId: MessageId.make(`${pullRequestWatchWakePrefix(link)}${wake}`),
                    text: `Update on #${number}`,
                    notification: {
                      source: { kind: "monitor" },
                      outcome: "updated",
                      summary: `#${number}: checks passed`,
                    },
                  },
                }),
          });
        });
      const queued = Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
        projection.runs
          .filter((run) => run.status === "queued")
          .map((run) => run.userMessageId.split(":").at(-1))
          .toSorted(),
      );

      yield* sync(7, false, "checks-7");
      yield* sync(8, false, "checks-8");
      yield* sync(9, false, "checks-9");
      assert.deepEqual(yield* queued, ["checks-7", "checks-8", "checks-9"]);

      // #7 merged: the watch ends with no wake of its own.
      yield* sync(7, true, null);
      assert.deepEqual(yield* queued, ["checks-8", "checks-9"]);

      // The agent stops watching #8.
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-wakes-stop-8"),
        threadId,
        ...repository,
        number: 8,
        watching: false,
      });
      assert.deepEqual(yield* queued, ["checks-9"]);

      // #9 gives up with a last wake: that one stays, the stale one before it goes.
      yield* sync(9, true, "stopped-9");
      assert.deepEqual(yield* queued, ["stopped-9"]);
    }),
  );
});
