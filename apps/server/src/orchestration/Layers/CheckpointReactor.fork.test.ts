// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

// The upstream harness imports and registers the cases below. Keep this file a
// valid standalone Vitest target when the runner discovers it directly.
it.skip("registers checkout watcher cases through the shared reactor harness", () => {});

interface WatcherHarness {
  readonly cwd: string;
  readonly engine: OrchestrationEngineShape;
  readonly drain: () => Promise<void>;
  readonly readModel: () => Promise<{
    readonly threads: ReadonlyArray<{ readonly id: ThreadId; readonly branch: string | null }>;
  }>;
  readonly runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

interface WatcherHarnessOptions {
  readonly seedFilesystemCheckpoints: false;
  readonly threadBranch: "main";
  readonly observeRealGitHead: true;
  readonly watchDirectory?: typeof NodeFS.watch;
}

export function registerCheckpointReactorForkTests(input: {
  readonly createHarness: (options: WatcherHarnessOptions) => Promise<WatcherHarness>;
  readonly getScope: () => Scope.Scope;
  readonly runGit: (cwd: string, args: ReadonlyArray<string>) => string;
}) {
  it("observes an idle external HEAD change without another turn", async () => {
    const harness = await input.createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "main",
      observeRealGitHead: true,
    });
    await harness.drain();
    const branchObserved = await harness.runEffect(Deferred.make<void>());
    await harness.runEffect(
      harness.engine.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.meta-updated" && event.payload.branch === "external/head-change",
        ),
        Stream.take(1),
        Stream.runForEach(() => Deferred.succeed(branchObserved, undefined)),
        Effect.forkIn(input.getScope(), { startImmediately: true }),
      ),
    );
    input.runGit(harness.cwd, ["switch", "-c", "external/head-change"]);
    await harness.runEffect(Deferred.await(branchObserved));
    const snapshot = await harness.readModel();
    assert.equal(
      snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.branch,
      "external/head-change",
    );
  });

  it("releases and reacquires the checkout watcher with thread topology", async () => {
    const harness = await input.createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "main",
      observeRealGitHead: true,
    });
    await harness.drain();
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-delete-watched-thread"),
        threadId: ThreadId.make("thread-1"),
      }),
    );
    await harness.drain();
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-recreate-watched-checkout"),
        threadId: ThreadId.make("thread-recreated"),
        projectId: ProjectId.make("project-1"),
        title: "Recreated thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "main",
        worktreePath: harness.cwd,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await harness.drain();
    const branchObserved = await harness.runEffect(Deferred.make<void>());
    await harness.runEffect(
      harness.engine.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "thread.meta-updated" && event.payload.branch === "external/reacquired",
        ),
        Stream.take(1),
        Stream.runForEach(() => Deferred.succeed(branchObserved, undefined)),
        Effect.forkIn(input.getScope(), { startImmediately: true }),
      ),
    );
    input.runGit(harness.cwd, ["switch", "-c", "external/reacquired"]);
    await harness.runEffect(Deferred.await(branchObserved));
    const snapshot = await harness.readModel();
    assert.equal(
      snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-recreated"))?.branch,
      "external/reacquired",
    );
  });

  it("retries after checkout watcher acquisition fails", async () => {
    let attempts = 0;
    const watchDirectory: typeof NodeFS.watch = ((...args: Parameters<typeof NodeFS.watch>) => {
      attempts += 1;
      if (attempts === 1) throw new Error("watch acquisition failed");
      return Reflect.apply(NodeFS.watch, NodeFS, args);
    }) as typeof NodeFS.watch;
    const harness = await input.createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "main",
      observeRealGitHead: true,
      watchDirectory,
    });
    await harness.drain();
    assert.equal(attempts, 1);
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-retry-watcher-topology"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: harness.cwd,
      }),
    );
    await harness.drain();
    assert.equal(attempts, 2);
  });
}
