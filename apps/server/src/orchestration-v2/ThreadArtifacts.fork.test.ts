import { assert, it } from "@effect/vitest";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import type { ThreadArtifactCommandFork } from "./ThreadArtifacts.fork.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter: ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("artifact link tests start no session"),
};
const layer = layerWithRegistry(
  { name: "thread-artifacts-fork" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

const start = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const at = (seconds: number) => DateTime.formatIso(DateTime.add(start, { seconds }));
const threadId = ThreadId.make("thread-artifacts");
const path = "/home/dev/notes/tracker.html";

let commandCounter = 0;
const commandId = () => CommandId.make(`cmd-artifacts-${(commandCounter += 1)}`);

const link = (title: string, source: "manual" | "agent", linkPath = path) =>
  ({
    type: "thread.artifact.link",
    commandId: commandId(),
    threadId,
    path: linkPath,
    title,
    source,
  }) satisfies ThreadArtifactCommandFork;

const observe = (updatedAt: string, missing: boolean) =>
  ({
    type: "thread.artifact.observe",
    commandId: commandId(),
    threadId,
    path,
    updatedAt,
    missing,
  }) satisfies ThreadArtifactCommandFork;

const unlink = { type: "thread.artifact.unlink", threadId, path } as const;

it.layer(layer)("thread artifact links on Orchestrator V2", (it) => {
  it.effect("link, relink, observe and unlink agree on the thread and its shell", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(start));
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const artifacts = orchestrator
        .getThreadProjection(threadId)
        .pipe(Effect.map(({ thread }) => thread.artifacts));
      const shellArtifacts = orchestrator
        .getThreadShell(threadId)
        .pipe(Effect.map((shell) => shell?.artifacts));
      const sequence = orchestrator.getThreadEventSequence(threadId);
      // A no-op is accepted but writes no event.
      const unchanged = (command: ThreadArtifactCommandFork) =>
        Effect.gen(function* () {
          const before = yield* sequence;
          yield* orchestrator.dispatch(command);
          assert.strictEqual(yield* sequence, before);
        });

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: commandId(),
        threadId,
        projectId: ProjectId.make("project-artifacts"),
        title: "Artifacts",
        modelSelection: { instanceId, model: "test-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      // Paths are stored normalized; a relative path is refused and writes nothing.
      yield* TestClock.adjust("10 seconds");
      yield* orchestrator.dispatch(link("Tracker", "agent", "/home/dev/./notes//tracker.html"));
      const linked = [
        {
          path,
          title: "Tracker",
          source: "agent" as const,
          linkedAt: at(10),
          updatedAt: at(10),
          missing: false,
        },
      ];
      assert.deepStrictEqual(yield* artifacts, linked);
      assert.deepStrictEqual(yield* shellArtifacts, linked);
      const before = yield* sequence;
      for (const refused of ["notes/tracker.html", "//host/share/tracker.html"]) {
        const error = yield* orchestrator
          .dispatch(link("Notes", "manual", refused))
          .pipe(Effect.flip);
        assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
      }
      assert.strictEqual(yield* sequence, before);

      // A Windows drive path is a host path too, normalized the Windows way.
      yield* orchestrator.dispatch(link("Plan", "agent", "C:/notes/./plan.md"));
      assert.strictEqual((yield* artifacts)?.[1]?.path, "C:\\notes\\plan.md");
      yield* orchestrator.dispatch({
        ...unlink,
        commandId: commandId(),
        path: "C:\\notes\\plan.md",
      });

      // The watcher records a change and a disappearance; a repeat observation is a no-op.
      yield* orchestrator.dispatch(observe(at(15), true));
      assert.deepInclude((yield* artifacts)?.[0], { updatedAt: at(15), missing: true });
      yield* unchanged(observe(at(15), true));

      // A relink keeps linkedAt, takes the new title and source, and clears missing.
      yield* TestClock.adjust("10 seconds");
      yield* orchestrator.dispatch(link("Release tracker", "manual"));
      const relinked = [
        { ...linked[0]!, title: "Release tracker", source: "manual" as const, updatedAt: at(20) },
      ];
      assert.deepStrictEqual(yield* artifacts, relinked);

      // Unlinking drops the key; a second unlink and a late observation change nothing.
      yield* orchestrator.dispatch({ ...unlink, commandId: commandId() });
      assert.isUndefined(yield* artifacts);
      assert.isUndefined(yield* shellArtifacts);
      yield* unchanged({ ...unlink, commandId: commandId() });
      yield* unchanged(observe(at(30), false));
    }),
  );
});
