import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ThreadCheckoutMove,
  ThreadCheckoutMoveError,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckoutMutationCoordinator from "./CheckoutMutationCoordinator.ts";
import {
  CheckoutMoveServiceFork,
  checkoutMoveServiceLiveFork,
} from "./CheckoutMoveService.fork.ts";

const threadId = ThreadId.make("thread-1");
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
        operation: "CheckoutMoveService.fork.test.git",
        command: "git",
        cwd,
        args: ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
        timeoutMs: 10_000,
      }),
    ),
    Effect.map((result) => result.stdout.trim()),
  );

/** A project checkout at `root` and a `feature` worktree beside it. */
const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const tmp = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "checkout-move-" }),
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

/**
 * An in-memory thread that applies checkout-move metadata updates with the
 * same `expectedWorktreePath` check the decider makes.
 */
const makeHarness = (root: string, others: ReadonlyArray<OrchestrationV2ThreadShell> = []) =>
  Effect.gen(function* () {
    let thread = {
      id: threadId,
      projectId,
      branch: "main",
      worktreePath: null,
      activeRunId: null,
      activityRunStatus: null,
      status: "idle",
    } as unknown as OrchestrationV2ThreadShell;
    const dispatched: OrchestrationV2Command[] = [];
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const settled = yield* Deferred.make<ThreadCheckoutMove>();

    const threads = {
      getThreadShell: () => Effect.succeed(thread),
      getShellSnapshot: () => Effect.succeed({ threads: [thread, ...others] }),
      streamDomainEvents: Stream.fromQueue(events),
      dispatch: (command: OrchestrationV2Command) =>
        Effect.gen(function* () {
          if (command.type !== "thread.metadata.update") return yield* Effect.die("unexpected");
          if (
            command.expectedWorktreePath !== undefined &&
            command.expectedWorktreePath !== thread.worktreePath
          ) {
            return yield* new Orchestrator.OrchestratorCommandRejectedError({
              commandId: command.commandId,
              commandType: command.type,
            });
          }
          dispatched.push(command);
          thread = {
            ...thread,
            ...(command.checkoutMove === undefined ? {} : { checkoutMove: command.checkoutMove }),
            ...(command.branch === undefined ? {} : { branch: command.branch }),
            ...(command.worktreePath === undefined ? {} : { worktreePath: command.worktreePath }),
          };
          const status = command.checkoutMove?.status;
          if (status === "committed" || status === "failed") {
            yield* Deferred.succeed(settled, command.checkoutMove!);
          }
          return { sequence: dispatched.length, storedEvents: [] };
        }),
    } as unknown as ThreadManagement.ThreadManagementService["Service"];
    const projects = {
      getShell: () => Effect.succeedSome({ id: projectId, workspaceRoot: root }),
    } as unknown as ProjectStore.ProjectStoreV2["Service"];

    const layer = checkoutMoveServiceLiveFork.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ThreadManagement.ThreadManagementService, threads),
          Layer.succeed(ProjectStore.ProjectStoreV2, projects),
          CheckoutMutationCoordinator.layer,
        ),
      ),
    );
    return {
      layer,
      dispatched,
      settled,
      thread: () => thread,
      setBusy: (busy: boolean) => {
        thread = {
          ...thread,
          activeRunId: busy ? "run-1" : null,
          status: busy ? "running" : "idle",
        } as OrchestrationV2ThreadShell;
      },
      finishRun: Queue.offer(events, {
        type: "run.updated",
        threadId,
        payload: { status: "completed" },
      } as unknown as OrchestrationV2DomainEvent),
    };
  });

const errorDetail = (error: unknown) =>
  Schema.is(ThreadCheckoutMoveError)(error) ? error.detail : String(error);

describe("CheckoutMoveServiceFork", () => {
  it.effect("moves an idle thread into a worktree and undoes the move", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root);
      yield* Effect.gen(function* () {
        const moves = yield* CheckoutMoveServiceFork;
        const moved = yield* moves.request({
          threadId,
          requestedPath: feature,
          expectedCheckoutRoot: root,
        });
        expect(moved.status).toBe("preparing");
        yield* moves.drain;
        const committed = harness.thread();
        expect(committed.worktreePath).toBe(feature);
        expect(committed.branch).toBe("feature");
        expect(committed.checkoutMove).toMatchObject({
          requestId: moved.requestId,
          status: "committed",
          completedSteps: ["metadata"],
          effectiveProvider: null,
        });

        yield* moves.request({
          threadId,
          requestedPath: root,
          expectedCheckoutRoot: feature,
          reverseOfRequestId: moved.requestId,
        });
        yield* moves.drain;
        expect(harness.thread().worktreePath).toBeNull();
        expect(harness.thread().branch).toBe("main");
        expect(harness.thread().checkoutMove?.reverseOfRequestId).toBe(moved.requestId);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("replays a request id idempotently and refuses its reuse", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root);
      harness.setBusy(true);
      yield* Effect.gen(function* () {
        const moves = yield* CheckoutMoveServiceFork;
        const input = {
          threadId,
          requestedPath: feature,
          expectedCheckoutRoot: root,
          requestId: CommandId.make("move-1"),
        };
        expect((yield* moves.request(input)).status).toBe("queued");
        expect((yield* moves.request(input)).status).toBe("queued");
        expect(harness.dispatched).toHaveLength(1);
        const reused = yield* moves
          .request({ ...input, requestedPath: root })
          .pipe(Effect.flip, Effect.map(errorDetail));
        expect(reused).toBe("Checkout move request identity was reused with different input");
        const second = yield* moves
          .request({ ...input, requestId: CommandId.make("move-2") })
          .pipe(Effect.flip, Effect.map(errorDetail));
        expect(second).toBe("A checkout move is already in progress for this thread");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("refuses a request whose expected checkout is stale", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root);
      yield* Effect.gen(function* () {
        const moves = yield* CheckoutMoveServiceFork;
        const detail = yield* moves
          .request({ threadId, requestedPath: root, expectedCheckoutRoot: feature })
          .pipe(Effect.flip, Effect.map(errorDetail));
        expect(detail).toBe("Checkout move context changed; refresh and retry");
        expect(harness.dispatched).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("queues a move during a run and commits it when the run settles", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root);
      harness.setBusy(true);
      yield* Effect.gen(function* () {
        const moves = yield* CheckoutMoveServiceFork;
        const queued = yield* moves.request({
          threadId,
          requestedPath: feature,
          expectedCheckoutRoot: root,
        });
        expect(queued.status).toBe("queued");
        yield* moves.drain;
        expect(harness.thread().worktreePath).toBeNull();
        expect(harness.thread().checkoutMove?.status).toBe("queued");

        harness.setBusy(false);
        yield* harness.finishRun;
        const settled = yield* Deferred.await(harness.settled);
        expect(settled.status).toBe("committed");
        expect(harness.thread().worktreePath).toBe(feature);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("records a failed move when the destination changed while it waited", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root);
      harness.setBusy(true);
      yield* Effect.gen(function* () {
        const moves = yield* CheckoutMoveServiceFork;
        yield* moves.request({ threadId, requestedPath: feature, expectedCheckoutRoot: root });
        yield* git(feature, ["commit", "--allow-empty", "-m", "moved on"]);
        harness.setBusy(false);
        yield* harness.finishRun;
        const settled = yield* Deferred.await(harness.settled);
        expect(settled.status).toBe("failed");
        expect(settled.detail).toBe("checkout identity changed before transition");
        expect(harness.thread().worktreePath).toBeNull();
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("refuses an undo once the moved-to checkout has changed", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root);
      yield* Effect.gen(function* () {
        const moves = yield* CheckoutMoveServiceFork;
        const moved = yield* moves.request({
          threadId,
          requestedPath: feature,
          expectedCheckoutRoot: root,
        });
        yield* moves.drain;
        yield* git(feature, ["commit", "--allow-empty", "-m", "moved on"]);
        const detail = yield* moves
          .request({
            threadId,
            requestedPath: root,
            expectedCheckoutRoot: feature,
            reverseOfRequestId: moved.requestId,
          })
          .pipe(Effect.flip, Effect.map(errorDetail));
        expect(detail).toBe("The reverse move no longer matches the effective checkout");
        expect(harness.thread().worktreePath).toBe(feature);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("fails a move while another busy thread runs in the destination", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const other = {
        id: ThreadId.make("thread-2"),
        projectId,
        worktreePath: feature,
        activeRunId: "run-2",
        activityRunStatus: "running",
        status: "running",
      } as unknown as OrchestrationV2ThreadShell;
      const harness = yield* makeHarness(root, [other]);
      yield* Effect.gen(function* () {
        const moves = yield* CheckoutMoveServiceFork;
        yield* moves.request({ threadId, requestedPath: feature, expectedCheckoutRoot: root });
        const settled = yield* Deferred.await(harness.settled);
        expect(settled.status).toBe("failed");
        expect(settled.detail).toBe("checkout is active on thread thread-2");
        expect(harness.thread().worktreePath).toBeNull();
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );
});
