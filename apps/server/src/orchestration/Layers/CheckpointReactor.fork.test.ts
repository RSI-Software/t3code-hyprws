// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { CheckoutDirectoryWatch } from "../../git/CheckoutDirectoryWatch.fork.ts";

// The upstream harness imports and registers the cases below. Keep this file a
// valid standalone Vitest target when the runner discovers it directly.
it.skip("registers checkout watcher cases through the shared reactor harness", () => {});

interface WatcherHarness {
  readonly cwd: string;
  readonly engine: OrchestrationEngineShape;
  readonly provider: {
    readonly emit: (event: {
      readonly type: string;
      readonly eventId: EventId;
      readonly provider: ProviderDriverKind;
      readonly createdAt: string;
      readonly threadId: ThreadId;
      readonly turnId?: string;
      readonly payload?: unknown;
    }) => void;
  };
  readonly drain: () => Promise<void>;
  readonly readModel: () => Promise<{
    readonly threads: ReadonlyArray<{ readonly id: ThreadId; readonly branch: string | null }>;
  }>;
  readonly runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

interface WatcherHarnessOptions {
  readonly seedFilesystemCheckpoints: false;
  readonly threadBranch: string;
  readonly observeRealGitHead?: true;
  readonly localStatusRefName?: string;
  readonly secondThreadSharingWorktree?: true;
  readonly watchDirectory?: typeof NodeFS.watch;
}

/** Layers the upstream harness merges in for fork cases: a replacement checkout watcher. */
export const forkCheckpointHarnessLayer = (options?: {
  readonly watchDirectory?: typeof NodeFS.watch;
}) =>
  options?.watchDirectory
    ? Layer.succeed(CheckoutDirectoryWatch, options.watchDirectory)
    : Layer.empty;

const asTurnId = (value: string): TurnId => TurnId.make(value);

/** The fork's watcher cases read the real checkout HEAD instead of a fixed ref. */
export const forkRealGitHeadStatus = (
  options:
    | {
        readonly observeRealGitHead?: boolean;
        readonly gitStatusRefreshCalls?: Array<string>;
      }
    | undefined,
  runGit: (cwd: string, args: ReadonlyArray<string>) => string,
) =>
  options?.observeRealGitHead
    ? {
        refreshLocalStatus: (cwd: string) =>
          Effect.sync(() => {
            options.gitStatusRefreshCalls?.push(cwd);
            const refName =
              runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim() || null;
            return {
              isRepo: true,
              hasPrimaryRemote: false,
              isDefaultRef: refName === "main",
              refName,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            };
          }),
      }
    : {};

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

  // The fork scopes drift to the physical checkout rather than to one thread,
  // because a managed session labels the checkout, not the thread. Every idle
  // branch-bound thread on that checkout follows the new HEAD; an active turn
  // anywhere on it defers the whole reconciliation instead.
  it.each(["t3code/original-branch", "t3code/fd9cbe0e"])(
    "adopts a drifted checkout from %s for idle threads sharing the worktree",
    async (threadBranch) => {
      const { createHarness } = input;
      const harness = await createHarness({
        seedFilesystemCheckpoints: false,
        threadBranch,
        localStatusRefName: "t3code/renamed-by-agent",
        secondThreadSharingWorktree: true,
      });

      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-branch-drift-shared"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-branch-drift-shared"),
        payload: { state: "completed" },
      });

      await harness.drain();

      const snapshot = await harness.readModel();
      const sharedThreads = snapshot.threads.filter(
        (entry) => entry.id === ThreadId.make("thread-1") || entry.id === ThreadId.make("thread-2"),
      );
      assert.deepEqual(
        sharedThreads.map((entry) => entry.branch),
        ["t3code/renamed-by-agent", null],
      );
    },
  );
}
