// @effect-diagnostics nodeBuiltinImport:off - the watcher seam is typed as fs.watch.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ZmuxSessionBinder from "../zmux/ZmuxSessionBinder.ts";
import { CheckoutDirectoryWatch } from "./CheckoutDirectoryWatch.fork.ts";
import { CheckoutHeadFollowFork, checkoutHeadFollowLiveFork } from "./CheckoutHeadFollow.fork.ts";
import * as CheckoutMutationCoordinator from "./CheckoutMutationCoordinator.ts";

const projectId = ProjectId.make("project-1");

const VcsProcessLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsLayer = VcsDriverRegistry.layer.pipe(
  Layer.provideMerge(VcsProcessLayer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  VcsProcess.VcsProcess.pipe(
    Effect.flatMap((process) =>
      process.run({
        operation: "CheckoutHeadFollow.fork.test.git",
        command: "git",
        cwd,
        args: ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
        timeoutMs: 10_000,
      }),
    ),
  );

/** A project checkout at `root` and a `feature` worktree beside it. */
const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const tmp = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "checkout-head-follow-" }),
  );
  const root = `${tmp}/repo`;
  const feature = `${tmp}/repo-feature`;
  yield* fileSystem.makeDirectory(root);
  yield* git(root, ["init", "-b", "main"]);
  yield* fileSystem.writeFileString(`${root}/README.md`, "hello\n");
  yield* git(root, ["add", "."]);
  yield* git(root, ["commit", "-m", "init"]);
  yield* git(root, ["worktree", "add", "-b", "feature", feature]);
  return { root, feature };
});

const shell = (id: string, worktreePath: string | null, branch: string | null) =>
  ({
    id: ThreadId.make(id),
    projectId,
    branch,
    worktreePath,
    activeRunId: null,
    activityRunStatus: null,
    status: "idle",
  }) as unknown as OrchestrationV2ThreadShell;

type WatchNotice = "open" | "close" | "fail";

/**
 * In-memory threads that apply branch updates, and a directory watcher that
 * reports every acquisition and release. `failFirstWatch` makes the first
 * acquisition throw; `refuse` names threads whose update the decider refuses.
 * `lookups` counts project lookups and managed-session reconciles, `snapshots`
 * the shell snapshots read. `nextHeadEvent` waits for the watcher to see HEAD
 * move, `nextReconcile` for a managed-session reconcile, and `nextRefusal` for
 * a refused update; `accept` stops refusing a thread.
 */
const makeHarness = (
  root: string,
  initial: ReadonlyArray<OrchestrationV2ThreadShell>,
  options: { readonly failFirstWatch?: boolean; readonly refuse?: ReadonlyArray<string> } = {},
) =>
  Effect.gen(function* () {
    const threads = new Map(initial.map((thread) => [thread.id, thread]));
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const dispatched = yield* Queue.unbounded<OrchestrationV2Command>();
    const watches = yield* Queue.unbounded<WatchNotice>();
    const headEvents = yield* Queue.unbounded<void>();
    const reconciles = yield* Queue.unbounded<string>();
    const refusals = yield* Queue.unbounded<void>();
    const refusing = new Set(options.refuse);
    const reads = { snapshots: 0 };
    let watchAttempts = 0;
    const lookups = { projects: 0, reconciles: 0 };
    const reconciled: Array<string> = [];
    const resolved: Array<string> = [];
    const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const countingRegistry = {
      ...registry,
      resolve: (input) => {
        resolved.push(input.cwd);
        return registry.resolve(input);
      },
    } satisfies VcsDriverRegistry.VcsDriverRegistry["Service"];

    const watchDirectory = ((...args: Parameters<typeof NodeFS.watch>) => {
      watchAttempts += 1;
      if (options.failFirstWatch === true && watchAttempts === 1) {
        Queue.offerUnsafe(watches, "fail");
        throw new Error("watch acquisition failed");
      }
      const [directory, listener] = args as [string, NodeFS.WatchListener<string>];
      const watcher = NodeFS.watch(directory, (event, filename) => {
        listener(event, filename);
        if (filename === "HEAD") Queue.offerUnsafe(headEvents, undefined);
      });
      Queue.offerUnsafe(watches, "open");
      watcher.on("close", () => Queue.offerUnsafe(watches, "close"));
      return watcher;
    }) as typeof NodeFS.watch;

    const threadService = {
      getThreadShell: (id: ThreadId) => Effect.succeed(threads.get(id) ?? null),
      getShellSnapshot: () =>
        Effect.sync(() => {
          reads.snapshots += 1;
          return { threads: [...threads.values()] };
        }),
      streamDomainEvents: Stream.fromQueue(events),
      dispatch: (command: OrchestrationV2Command) =>
        Effect.gen(function* () {
          if (command.type !== "thread.metadata.update") return yield* Effect.die("unexpected");
          const thread = threads.get(command.threadId)!;
          if (refusing.has(thread.id)) {
            yield* Queue.offer(refusals, undefined);
            return yield* Effect.fail("refused");
          }
          threads.set(thread.id, { ...thread, branch: command.branch ?? thread.branch });
          yield* Queue.offer(dispatched, command);
          return { sequence: 1, storedEvents: [] };
        }),
    } as unknown as ThreadManagement.ThreadManagementService["Service"];
    const projects = {
      getShell: () =>
        Effect.sync(() => {
          lookups.projects += 1;
        }).pipe(Effect.andThen(Effect.succeedSome({ id: projectId, workspaceRoot: root }))),
    } as unknown as ProjectStore.ProjectStoreV2["Service"];
    const vcsStatus = {
      refreshLocalStatus: () => Effect.succeed({}),
    } as unknown as VcsStatusBroadcaster.VcsStatusBroadcaster["Service"];

    const emit = (type: OrchestrationV2DomainEvent["type"], thread: OrchestrationV2ThreadShell) =>
      Queue.offer(events, {
        type,
        threadId: thread.id,
        payload: type === "run.updated" ? { status: "completed" } : thread,
      } as unknown as OrchestrationV2DomainEvent);

    const layer = checkoutHeadFollowLiveFork.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ThreadManagement.ThreadManagementService, threadService),
          Layer.succeed(ProjectStore.ProjectStoreV2, projects),
          Layer.succeed(VcsStatusBroadcaster.VcsStatusBroadcaster, vcsStatus),
          Layer.succeed(CheckoutDirectoryWatch, watchDirectory),
          Layer.succeed(VcsDriverRegistry.VcsDriverRegistry, countingRegistry),
          CheckoutMutationCoordinator.layer,
          Layer.mock(ZmuxSessionBinder.ZmuxSessionBinder)({
            reconcileExisting: (cwd: string) =>
              Effect.sync(() => {
                lookups.reconciles += 1;
                reconciled.push(cwd);
                Queue.offerUnsafe(reconciles, cwd);
                return { status: "not-found" as const };
              }),
          }),
        ),
      ),
    );
    return {
      layer,
      branchOf: (id: string) => threads.get(ThreadId.make(id))?.branch,
      lookups,
      reads,
      nextHeadEvent: Queue.take(headEvents),
      nextReconcile: Queue.take(reconciles),
      nextRefusal: Queue.take(refusals),
      accept: (id: string) => refusing.delete(id),
      reconciled,
      resolved,
      dispatched,
      nextWatch: Queue.take(watches),
      setBusy: (id: string) => {
        const thread = threads.get(ThreadId.make(id))!;
        threads.set(thread.id, {
          ...thread,
          activeRunId: "run-1",
          status: "running",
        } as OrchestrationV2ThreadShell);
      },
      finishRun: (id: string) => emit("run.updated", threads.get(ThreadId.make(id))!),
      remove: (id: string) => {
        const thread = threads.get(ThreadId.make(id))!;
        threads.delete(thread.id);
        return emit("thread.deleted", thread);
      },
      add: (thread: OrchestrationV2ThreadShell) => {
        threads.set(thread.id, thread);
        return emit("thread.created", thread);
      },
    };
  });

describe("CheckoutHeadFollowFork", () => {
  it.effect.each(["t3code/original-branch", "t3code/fd9cbe0e"])(
    "moves idle threads sharing the checkout from %s to the branch a run ended on",
    (threadBranch) =>
      Effect.gen(function* () {
        const { root, feature } = yield* makeRepository;
        const harness = yield* makeHarness(root, [
          shell("thread-1", feature, threadBranch),
          shell("thread-2", feature, null),
          shell("thread-3", null, "main"),
        ]);
        yield* Effect.gen(function* () {
          expect(yield* harness.nextWatch).toBe("open");
          expect(yield* harness.nextWatch).toBe("open");
          yield* git(feature, ["switch", "-c", "t3code/renamed-by-agent"]);
          yield* harness.finishRun("thread-1");
          const update = yield* Queue.take(harness.dispatched);
          expect(update).toMatchObject({
            threadId: "thread-1",
            branch: "t3code/renamed-by-agent",
            expectedWorktreePath: feature,
            expectedBranch: threadBranch,
          });
          yield* (yield* CheckoutHeadFollowFork).drain;
          expect(harness.branchOf("thread-2")).toBeNull();
          expect(harness.branchOf("thread-3")).toBe("main");
          expect(yield* Queue.size(harness.dispatched)).toBe(0);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("defers while any thread runs on the checkout", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [
        shell("thread-1", feature, "feature"),
        shell("thread-2", feature, "feature"),
      ]);
      harness.setBusy("thread-2");
      yield* Effect.gen(function* () {
        const follower = yield* CheckoutHeadFollowFork;
        yield* git(feature, ["switch", "-c", "elsewhere"]);
        yield* follower.follow(feature);
        expect(yield* Queue.size(harness.dispatched)).toBe(0);
        expect(harness.branchOf("thread-1")).toBe("feature");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.live("follows an idle HEAD change made outside T3", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [shell("thread-1", feature, "feature")]);
      yield* Effect.gen(function* () {
        expect(yield* harness.nextWatch).toBe("open");
        yield* git(feature, ["switch", "-c", "external/head-change"]);
        const update = yield* Queue.take(harness.dispatched);
        expect(update).toMatchObject({ threadId: "thread-1", branch: "external/head-change" });
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.live("releases and reacquires the checkout watcher with thread topology", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [shell("thread-1", feature, "feature")]);
      yield* Effect.gen(function* () {
        expect(yield* harness.nextWatch).toBe("open");
        yield* harness.remove("thread-1");
        expect(yield* harness.nextWatch).toBe("close");
        yield* harness.add(shell("thread-recreated", feature, "feature"));
        expect(yield* harness.nextWatch).toBe("open");
        yield* git(feature, ["switch", "-c", "external/reacquired"]);
        const update = yield* Queue.take(harness.dispatched);
        expect(update).toMatchObject({
          threadId: "thread-recreated",
          branch: "external/reacquired",
        });
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("retries after checkout watcher acquisition fails", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [shell("thread-1", feature, "feature")], {
        failFirstWatch: true,
      });
      yield* Effect.gen(function* () {
        expect(yield* harness.nextWatch).toBe("fail");
        yield* harness.add(shell("thread-2", feature, "feature"));
        expect(yield* harness.nextWatch).toBe("open");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("resolves only drifted threads and threads inside the followed checkout", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [
        shell("thread-1", feature, "feature"),
        shell("thread-2", null, "main"),
        shell("thread-3", null, "main"),
      ]);
      yield* Effect.gen(function* () {
        const follower = yield* CheckoutHeadFollowFork;
        expect(yield* harness.nextWatch).toBe("open");
        expect(yield* harness.nextWatch).toBe("open");
        yield* follower.drain;
        harness.lookups.projects = 0;

        // Only thread-1 differs from `main`, and it runs in another checkout;
        // the idle root threads still reconcile their managed session.
        yield* follower.follow(root);
        expect(harness.lookups).toEqual({ projects: 1, reconciles: 1 });
        expect(yield* Queue.size(harness.dispatched)).toBe(0);

        // Both root threads drift; their shared project resolves once.
        yield* git(root, ["switch", "-c", "elsewhere"]);
        yield* follower.follow(root);
        expect(harness.lookups).toEqual({ projects: 2, reconciles: 2 });
        expect(harness.branchOf("thread-2")).toBe("elsewhere");
        expect(harness.branchOf("thread-3")).toBe("elsewhere");
        expect(harness.branchOf("thread-1")).toBe("feature");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("reconciles a stale managed session when no thread drifted", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [
        shell("thread-1", feature, "feature"),
        shell("thread-2", null, null),
      ]);
      yield* Effect.gen(function* () {
        const follower = yield* CheckoutHeadFollowFork;
        expect(yield* harness.nextWatch).toBe("open");
        expect(yield* harness.nextWatch).toBe("open");
        yield* follower.drain;
        harness.resolved.length = 0;
        // A run ends on the feature worktree without moving HEAD; it reconciles
        // that checkout's session without resolving the idle root thread.
        yield* follower.follow(feature);
        expect(harness.resolved).not.toContain(root);
        expect(harness.reconciled).toEqual([feature]);
        expect(yield* Queue.size(harness.dispatched)).toBe(0);
        expect(harness.branchOf("thread-1")).toBe("feature");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("skips a run's follow while its watched checkout's HEAD has not moved", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [shell("thread-1", feature, "feature")]);
      yield* Effect.gen(function* () {
        const follower = yield* CheckoutHeadFollowFork;
        expect(yield* harness.nextWatch).toBe("open");
        // HEAD may have moved before the watcher opened, so the first run's end follows.
        yield* harness.finishRun("thread-1");
        expect(yield* harness.nextReconcile).toBe(feature);
        harness.reads.snapshots = 0;

        // Runs end in order: the first, on a settled HEAD, reads nothing.
        yield* harness.finishRun("thread-1");
        yield* git(feature, ["switch", "-c", "moved-by-run"]);
        yield* harness.nextHeadEvent;
        yield* harness.finishRun("thread-1");
        expect(yield* Queue.take(harness.dispatched)).toMatchObject({
          threadId: "thread-1",
          branch: "moved-by-run",
        });
        yield* follower.drain;
        expect(harness.reads.snapshots).toBe(1);
        expect(harness.reconciled).toEqual([feature, feature]);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("resolves only the threads a topology change moved", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [shell("thread-1", feature, "feature")]);
      yield* Effect.gen(function* () {
        expect(yield* harness.nextWatch).toBe("open");
        harness.resolved.length = 0;
        yield* harness.add(shell("thread-2", null, "main"));
        expect(yield* harness.nextWatch).toBe("open");
        expect(harness.resolved).toContain(root);
        expect(harness.resolved).not.toContain(feature);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("retries a refused branch follow at the next run's end", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [shell("thread-1", feature, "feature")], {
        refuse: ["thread-1"],
      });
      yield* Effect.gen(function* () {
        const follower = yield* CheckoutHeadFollowFork;
        expect(yield* harness.nextWatch).toBe("open");
        yield* git(feature, ["switch", "-c", "moved-by-run"]);
        yield* harness.nextHeadEvent;
        yield* harness.finishRun("thread-1");
        yield* harness.nextRefusal;
        harness.accept("thread-1");

        yield* harness.finishRun("thread-1");
        // The event stream handles the run's end before the topology change
        // the new watcher signals.
        yield* harness.add(shell("thread-2", null, "main"));
        expect(yield* harness.nextWatch).toBe("open");
        yield* follower.drain;
        expect(harness.branchOf("thread-1")).toBe("moved-by-run");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("follows the other threads when one update is refused", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(
        root,
        [shell("thread-1", feature, "feature"), shell("thread-2", feature, "feature")],
        { refuse: ["thread-1"] },
      );
      yield* Effect.gen(function* () {
        yield* git(feature, ["switch", "-c", "elsewhere"]);
        yield* (yield* CheckoutHeadFollowFork).follow(feature);
        expect(harness.branchOf("thread-1")).toBe("feature");
        expect(harness.branchOf("thread-2")).toBe("elsewhere");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );
});
