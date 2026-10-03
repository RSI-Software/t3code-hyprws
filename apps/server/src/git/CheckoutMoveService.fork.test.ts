import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  GitCommandError,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderSessionId,
  RunId,
  type ThreadCheckoutMove,
  ThreadCheckoutMoveError,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as TurnStart from "../orchestration-v2/ProviderTurnStartService.ts";
import { providerTurnStartCheckoutGateFork } from "../orchestration-v2/ProviderTurnStartCheckoutGate.fork.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckoutMutationCoordinator from "./CheckoutMutationCoordinator.ts";
import { resolveCheckoutPhysicalIdentity } from "./checkoutMoveIdentity.fork.ts";
import * as GitWorkflow from "./GitWorkflowService.ts";
import {
  CheckoutMoveServiceFork,
  checkoutMoveServiceLayerFork,
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

/** Effects a test runs around the Git worktree operations, to order concurrent recoveries. */
interface GitHooks {
  readonly beforePrune?: Effect.Effect<void>;
  readonly afterCreate?: Effect.Effect<void>;
}

/** The two worktree operations recovery uses, run as plain Git. */
const makeGitWorkflowLayer = (hooks: GitHooks = {}) =>
  Layer.effect(
    GitWorkflow.GitWorkflowService,
    Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const run = (cwd: string, args: ReadonlyArray<string>) =>
        git(cwd, args).pipe(
          Effect.provideService(VcsProcess.VcsProcess, process),
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: "test",
                command: `git ${args.join(" ")}`,
                cwd,
                detail: String(cause),
              }),
          ),
        );
      return {
        pruneWorktrees: ({ cwd }: { readonly cwd: string }) =>
          (hooks.beforePrune ?? Effect.void).pipe(
            Effect.andThen(run(cwd, ["worktree", "prune"])),
            Effect.asVoid,
          ),
        createWorktree: (input: {
          readonly cwd: string;
          readonly refName: string;
          readonly path: string | null;
        }) =>
          run(input.cwd, ["worktree", "add", input.path!, input.refName]).pipe(
            Effect.tap(() => hooks.afterCreate ?? Effect.void),
            Effect.as({ worktree: { path: input.path!, refName: input.refName } }),
          ),
      } as unknown as GitWorkflow.GitWorkflowService["Service"];
    }),
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
const makeHarness = (
  root: string,
  others: ReadonlyArray<OrchestrationV2ThreadShell> = [],
  options: {
    /** Lists the thread under the archive instead of the active list. */
    readonly archived?: boolean;
    /** The decider's answer to a write: a refusal message, or undefined to apply it. */
    readonly refuse?: (command: OrchestrationV2Command) => string | undefined;
    /** Holds the domain-event tail's subscription until `releaseLiveTail`. */
    readonly holdLiveTail?: boolean;
    readonly gitHooks?: GitHooks;
  } = {},
) =>
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
    const settled = yield* Deferred.make<ThreadCheckoutMove>();
    const shellReads = yield* Queue.unbounded<void>();

    // A sequenced event store: a cursor replays what was stored after it,
    // then follows the live tail, as the server's event sink does.
    const stored: OrchestrationV2StoredEvent[] = [];
    const live = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const latestSequence = Effect.sync(() => stored.length);
    const streamAfter = (afterSequence: number) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(live);
          const highWater = stored.length;
          return Stream.concat(
            Stream.fromIterable(stored.slice(afterSequence, highWater)),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.sequence > highWater),
            ),
          );
        }),
      );
    const eventSink = {
      latestSequence: () => latestSequence,
      stream: (input?: { readonly afterSequence?: number }) =>
        streamAfter(input?.afterSequence ?? 0),
    } as unknown as EventSink.EventSinkV2["Service"];
    const liveTail = yield* Deferred.make<void>();
    if (options.holdLiveTail !== true) yield* Deferred.succeed(liveTail, undefined);

    const threads = {
      getThreadShell: () => Queue.offer(shellReads, undefined).pipe(Effect.map(() => thread)),
      getShellSnapshot: (input?: { readonly location?: "active" | "archive" }) =>
        Effect.succeed({
          threads:
            (input?.location === "archive") === (options.archived === true)
              ? [thread, ...others]
              : others,
        }),
      // The upstream live tail starts at the store's head when first pulled.
      streamDomainEvents: Stream.unwrap(
        Deferred.await(liveTail).pipe(
          Effect.andThen(latestSequence),
          Effect.map((latest) => streamAfter(latest).pipe(Stream.map(({ event }) => event))),
        ),
      ),
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
          const refusal = options.refuse?.(command);
          if (refusal !== undefined) {
            return yield* new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: refusal,
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

    const services = Layer.mergeAll(
      Layer.succeed(ThreadManagement.ThreadManagementService, threads),
      Layer.succeed(ProjectStore.ProjectStoreV2, projects),
      Layer.succeed(EventSink.EventSinkV2, eventSink),
      CheckoutMutationCoordinator.layer,
      makeGitWorkflowLayer(options.gitHooks),
    );
    return {
      layer: checkoutMoveServiceLayerFork.pipe(Layer.provide(services)),
      services,
      dispatched,
      settled,
      thread: () => thread,
      seedMove: (checkoutMove: ThreadCheckoutMove) => {
        thread = { ...thread, checkoutMove } as OrchestrationV2ThreadShell;
      },
      strand: (worktreePath: string, branch: string) => {
        thread = { ...thread, worktreePath, branch } as OrchestrationV2ThreadShell;
      },
      setBusy: (busy: boolean) => {
        thread = {
          ...thread,
          activeRunId: busy ? "run-1" : null,
          status: busy ? "running" : "idle",
        } as OrchestrationV2ThreadShell;
      },
      shellReads,
      releaseLiveTail: Deferred.succeed(liveTail, undefined),
      finishRun: Effect.suspend(() => {
        const event = {
          sequence: stored.length + 1,
          commandId: null,
          event: {
            type: "run.updated",
            threadId,
            payload: { status: "completed" },
          } as unknown as OrchestrationV2DomainEvent,
        };
        stored.push(event);
        return PubSub.publish(live, event);
      }),
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

  it.effect("requeues a move whose commit lost the race to a starting run", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      // A queued or scheduled run starts after the idle check: the decider
      // refuses the commit while that run is live.
      let raced = false;
      const harness: Effect.Success<ReturnType<typeof makeHarness>> = yield* makeHarness(root, [], {
        refuse: (command) => {
          if (command.type !== "thread.metadata.update") return undefined;
          if (command.checkoutMove?.status !== "committed" || raced) return undefined;
          raced = true;
          harness.setBusy(true);
          return "A run started on this thread before its checkout move committed.";
        },
      });
      yield* Effect.gen(function* () {
        const moves = yield* CheckoutMoveServiceFork;
        yield* moves.request({ threadId, requestedPath: feature, expectedCheckoutRoot: root });
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

  it.effect("records a failed move when it cannot leave the queue", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [], {
        refuse: (command) =>
          command.type === "thread.metadata.update" && command.checkoutMove?.status === "preparing"
            ? "projection write failed"
            : undefined,
      });
      harness.setBusy(true);
      yield* Effect.gen(function* () {
        const moves = yield* CheckoutMoveServiceFork;
        yield* moves.request({ threadId, requestedPath: feature, expectedCheckoutRoot: root });
        harness.setBusy(false);
        yield* harness.finishRun;
        const settled = yield* Deferred.await(harness.settled);
        expect(settled.status).toBe("failed");
        expect(harness.thread().worktreePath).toBeNull();
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("resumes a lost move when its request is replayed", () =>
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
        yield* moves.request(input);
        yield* moves.drain;
        // The run settles without a completion the service observed.
        harness.setBusy(false);
        expect((yield* moves.request(input)).status).toBe("queued");
        const settled = yield* Deferred.await(harness.settled);
        expect(settled.status).toBe("committed");
        expect(harness.thread().worktreePath).toBe(feature);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("resumes an archived thread's in-flight move after a restart", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [], { archived: true });
      const source = yield* resolveCheckoutPhysicalIdentity(root);
      const destination = yield* resolveCheckoutPhysicalIdentity(feature);
      harness.seedMove({
        requestId: CommandId.make("move-1"),
        source,
        sourceThreadBranch: "main",
        sourceThreadWorktreePath: null,
        requestedPath: feature,
        destination,
        expectedCheckoutRoot: root,
        status: "queued",
        completedSteps: [],
        effectiveProvider: null,
        requestedAt: "2026-10-04T00:00:00.000Z",
        updatedAt: "2026-10-04T00:00:00.000Z",
      } as unknown as ThreadCheckoutMove);
      yield* Effect.gen(function* () {
        yield* CheckoutMoveServiceFork;
        const settled = yield* Deferred.await(harness.settled);
        expect(settled.status).toBe("committed");
        expect(harness.thread().worktreePath).toBe(feature);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("commits a restart-resumed move whose run settles before the listener subscribes", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root, [], { holdLiveTail: true });
      harness.seedMove({
        requestId: CommandId.make("move-1"),
        source: yield* resolveCheckoutPhysicalIdentity(root),
        sourceThreadBranch: "main",
        sourceThreadWorktreePath: null,
        requestedPath: feature,
        destination: yield* resolveCheckoutPhysicalIdentity(feature),
        expectedCheckoutRoot: root,
        status: "queued",
        completedSteps: [],
        effectiveProvider: null,
        requestedAt: "2026-10-04T00:00:00.000Z",
        updatedAt: "2026-10-04T00:00:00.000Z",
      } as unknown as ThreadCheckoutMove);
      harness.setBusy(true);
      yield* Effect.gen(function* () {
        yield* CheckoutMoveServiceFork;
        // The restart scan's processing read the busy thread and its re-check.
        yield* Queue.take(harness.shellReads);
        yield* Queue.take(harness.shellReads);
        expect(harness.thread().checkoutMove?.status).toBe("queued");
        // The run settles before a live-tail subscription would have started.
        harness.setBusy(false);
        yield* harness.finishRun;
        yield* harness.releaseLiveTail;
        const settled = yield* Deferred.await(harness.settled);
        expect(settled.status).toBe("committed");
        expect(harness.thread().worktreePath).toBe(feature);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  it.effect("admits one of two concurrent move requests for a thread", () =>
    Effect.gen(function* () {
      const { root, feature } = yield* makeRepository;
      const harness = yield* makeHarness(root);
      harness.setBusy(true);
      yield* Effect.gen(function* () {
        const moves = yield* CheckoutMoveServiceFork;
        const results = yield* Effect.all(
          [feature, feature].map((requestedPath) =>
            moves
              .request({ threadId, requestedPath, expectedCheckoutRoot: root })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        expect(harness.dispatched).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(VcsLayer), Effect.scoped),
  );

  describe("removed-worktree recovery", () => {
    /** Strands the thread on `feature`, then removes that worktree and, unless kept, its branch. */
    const strandOnRemovedWorktree = (
      harness: { readonly strand: (path: string, branch: string) => void },
      root: string,
      feature: string,
      keepBranch = false,
    ) =>
      Effect.gen(function* () {
        harness.strand(feature, "feature");
        yield* git(root, ["worktree", "remove", "--force", feature]);
        if (!keepBranch) yield* git(root, ["branch", "-D", "feature"]);
      });

    it.effect("moves a thread whose worktree and branch are gone to the project root", () =>
      Effect.gen(function* () {
        const { root, feature } = yield* makeRepository;
        const harness = yield* makeHarness(root);
        yield* strandOnRemovedWorktree(harness, root, feature);
        yield* Effect.gen(function* () {
          const moves = yield* CheckoutMoveServiceFork;
          const recovered = yield* moves.recoverRemovedWorktree(harness.thread());
          expect(recovered.worktreePath).toBeNull();
          expect(recovered.branch).toBe("main");
          expect(recovered.checkoutMove).toMatchObject({
            reason: "worktree-recovery",
            status: "committed",
            sourceThreadBranch: "feature",
            sourceThreadWorktreePath: feature,
            destination: { checkoutRoot: root, branch: "main" },
          });
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.provide(VcsLayer), Effect.scoped),
    );

    it.effect("recreates a removed worktree whose branch survives", () =>
      Effect.gen(function* () {
        const { root, feature } = yield* makeRepository;
        const harness = yield* makeHarness(root);
        yield* strandOnRemovedWorktree(harness, root, feature, true);
        yield* Effect.gen(function* () {
          const moves = yield* CheckoutMoveServiceFork;
          const kept = yield* moves.recoverRemovedWorktree(harness.thread());
          expect(kept.worktreePath).toBe(feature);
          expect(harness.dispatched).toEqual([]);
          expect(yield* git(feature, ["branch", "--show-current"])).toBe("feature");
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.provide(VcsLayer), Effect.scoped),
    );

    it.effect("keeps the thread on a worktree a concurrent recovery recreated", () =>
      Effect.gen(function* () {
        const { root, feature } = yield* makeRepository;
        // Both recoveries see the worktree missing; the second prunes only
        // after the first recreated it, so its own create fails.
        const secondPruned = yield* Deferred.make<void>();
        const firstCreated = yield* Deferred.make<void>();
        let prunes = 0;
        const harness = yield* makeHarness(root, [], {
          gitHooks: {
            beforePrune: Effect.suspend(() =>
              ++prunes === 1
                ? Deferred.await(secondPruned)
                : Deferred.succeed(secondPruned, undefined).pipe(
                    Effect.andThen(Deferred.await(firstCreated)),
                  ),
            ),
            afterCreate: Deferred.succeed(firstCreated, undefined).pipe(Effect.asVoid),
          },
        });
        yield* strandOnRemovedWorktree(harness, root, feature, true);
        yield* Effect.gen(function* () {
          const moves = yield* CheckoutMoveServiceFork;
          const stranded = harness.thread();
          const results = yield* Effect.all(
            [moves.recoverRemovedWorktree(stranded), moves.recoverRemovedWorktree(stranded)],
            { concurrency: 2 },
          );
          expect(prunes).toBe(2);
          expect(results.map((thread) => thread.worktreePath)).toEqual([feature, feature]);
          expect(harness.dispatched).toEqual([]);
          expect(harness.thread().worktreePath).toBe(feature);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.provide(VcsLayer), Effect.scoped),
    );

    it.effect("moves to the project root when the worktree cannot be recreated", () =>
      Effect.gen(function* () {
        const { root, feature } = yield* makeRepository;
        const harness = yield* makeHarness(root);
        // The branch survives but is checked out at the root, so Git refuses
        // a second worktree for it.
        yield* strandOnRemovedWorktree(harness, root, feature, true);
        yield* git(root, ["switch", "feature"]);
        yield* Effect.gen(function* () {
          const moves = yield* CheckoutMoveServiceFork;
          const recovered = yield* moves.recoverRemovedWorktree(harness.thread());
          expect(recovered.worktreePath).toBeNull();
          expect(recovered.branch).toBe("feature");
          expect(recovered.checkoutMove).toMatchObject({
            reason: "worktree-recovery",
            status: "committed",
            sourceThreadWorktreePath: feature,
            destination: { checkoutRoot: root, branch: "feature" },
          });
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.provide(VcsLayer), Effect.scoped),
    );

    it.effect("records a failed recovery while another thread runs in the project root", () =>
      Effect.gen(function* () {
        const { root, feature } = yield* makeRepository;
        const owner = {
          id: ThreadId.make("thread-2"),
          projectId,
          worktreePath: null,
          activeRunId: "run-2",
          activityRunStatus: "running",
          status: "running",
        } as unknown as OrchestrationV2ThreadShell;
        const harness = yield* makeHarness(root, [owner]);
        yield* strandOnRemovedWorktree(harness, root, feature);
        yield* Effect.gen(function* () {
          const moves = yield* CheckoutMoveServiceFork;
          const blocked = yield* moves.recoverRemovedWorktree(harness.thread());
          expect(blocked.worktreePath).toBe(feature);
          expect(blocked.checkoutMove).toMatchObject({
            reason: "worktree-recovery",
            status: "failed",
            detail: "checkout is active on thread thread-2",
          });

          // The owner settles; the resend's recovery commits.
          (owner as { activeRunId: unknown }).activeRunId = null;
          (owner as { activityRunStatus: unknown }).activityRunStatus = null;
          (owner as { status: unknown }).status = "idle";
          const recovered = yield* moves.recoverRemovedWorktree(harness.thread());
          expect(recovered.worktreePath).toBeNull();
          expect(recovered.checkoutMove?.status).toBe("committed");
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.provide(VcsLayer), Effect.scoped),
    );

    it.effect("recovers while another stranded thread is running", () =>
      Effect.gen(function* () {
        const { root, feature } = yield* makeRepository;
        const other = {
          id: ThreadId.make("thread-2"),
          projectId,
          worktreePath: `${root}-other-gone`,
          activeRunId: "run-2",
          activityRunStatus: "running",
          status: "running",
        } as unknown as OrchestrationV2ThreadShell;
        const harness = yield* makeHarness(root, [other]);
        yield* strandOnRemovedWorktree(harness, root, feature);
        yield* Effect.gen(function* () {
          const moves = yield* CheckoutMoveServiceFork;
          const recovered = yield* moves.recoverRemovedWorktree(harness.thread());
          expect(recovered.worktreePath).toBeNull();
          expect(recovered.checkoutMove?.status).toBe("committed");
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.provide(VcsLayer), Effect.scoped),
    );

    describe("turn-start checkout gate", () => {
      const runId = RunId.make("run-1");
      const providerSessionId = ProviderSessionId.make("session-1");

      /**
       * The gate over a fake upstream turn start that records the worktree the
       * session would open in. The move service shares the gate's services, as
       * the client path and every other turn do on the server.
       */
      /** `sessionCwd` is the cwd of the thread's live provider session, if any. */
      const makeGate = (
        harness: Effect.Success<ReturnType<typeof makeHarness>>,
        sessionCwd?: string,
      ) => {
        const started: Array<string | null> = [];
        const detached: ProviderSessionId[] = [];
        const inner = Layer.succeed(TurnStart.ProviderTurnStartServiceV2, {
          start: () => Effect.sync(() => void started.push(harness.thread().worktreePath)),
        });
        const projection = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getThread: () => Effect.sync(harness.thread),
          getThreadRecords: () =>
            Effect.succeed({
              runs: [{ id: runId, status: "starting" }],
              providerSessions: [{ id: providerSessionId, status: "ready" }],
              providerThreads: [{ providerSessionId }],
            }),
        } as unknown as ProjectionStore.ProjectionStoreV2["Service"]);
        const sessions = Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, {
          get: () =>
            Effect.succeed(
              sessionCwd === undefined
                ? Option.none()
                : Option.some({
                    providerSession: {
                      cwd: sessionCwd,
                      capabilities: {
                        sessions: { supportsMultipleProviderThreadsPerSession: false },
                      },
                    },
                  }),
            ),
          detach: (input: { readonly providerSessionId: ProviderSessionId }) =>
            Effect.sync(() => void detached.push(input.providerSessionId)),
        } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]);
        const layer = Layer.mergeAll(
          providerTurnStartCheckoutGateFork.pipe(
            Layer.provide(Layer.mergeAll(inner, projection, sessions)),
          ),
          checkoutMoveServiceLayerFork,
        ).pipe(Layer.provideMerge(harness.services));
        return { layer, started, detached };
      };

      it.effect("recovers a turn no client started before its session opens", () =>
        Effect.gen(function* () {
          const { root, feature } = yield* makeRepository;
          const harness = yield* makeHarness(root);
          yield* strandOnRemovedWorktree(harness, root, feature);
          // A queued, MCP, scheduled or continuation run is already starting.
          harness.setBusy(true);
          const gate = makeGate(harness, feature);
          yield* Effect.gen(function* () {
            yield* (yield* TurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
            expect(gate.started).toEqual([null]);
            expect(gate.detached).toEqual([providerSessionId]);
            expect(harness.dispatched).toHaveLength(1);
            expect(harness.dispatched[0]).toMatchObject({
              commandId: `server:worktree-checkout-recovery:${runId}`,
              checkoutMove: { reason: "worktree-recovery", status: "committed" },
            });
          }).pipe(Effect.provide(gate.layer));
        }).pipe(Effect.provide(VcsLayer), Effect.scoped),
      );

      it.effect("does not recover a client turn twice", () =>
        Effect.gen(function* () {
          const { root, feature } = yield* makeRepository;
          const harness = yield* makeHarness(root);
          yield* strandOnRemovedWorktree(harness, root, feature);
          // The decider's queued detach closed the idle thread's session.
          const gate = makeGate(harness);
          yield* Effect.gen(function* () {
            // The client path recovers before it dispatches the turn.
            const moves = yield* CheckoutMoveServiceFork;
            expect((yield* moves.recoverRemovedWorktree(harness.thread())).worktreePath).toBeNull();
            harness.setBusy(true);
            yield* (yield* TurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
            expect(gate.started).toEqual([null]);
            expect(gate.detached).toEqual([]);
            expect(harness.dispatched).toHaveLength(1);
          }).pipe(Effect.provide(gate.layer));
        }).pipe(Effect.provide(VcsLayer), Effect.scoped),
      );

      it.live("holds a turn start until a branch change releases the checkout lease", () =>
        Effect.gen(function* () {
          const { root } = yield* makeRepository;
          const harness = yield* makeHarness(root);
          harness.setBusy(true);
          const gate = makeGate(harness);
          yield* Effect.gen(function* () {
            const coordinator = yield* CheckoutMutationCoordinator.CheckoutMutationCoordinator;
            const held = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            yield* coordinator
              .withLease(
                root,
                Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
              )
              .pipe(Effect.forkScoped);
            yield* Deferred.await(held);
            const turn = yield* (yield* TurnStart.ProviderTurnStartServiceV2)
              .start({ threadId, runId })
              .pipe(Effect.forkScoped);
            // The start must still be waiting while the lease is held.
            expect(
              Option.isNone(yield* Fiber.await(turn).pipe(Effect.timeoutOption("300 millis"))),
            ).toBe(true);
            expect(gate.started).toEqual([]);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(turn);
            expect(gate.started).toEqual([null]);
          }).pipe(Effect.provide(gate.layer));
        }).pipe(Effect.provide(VcsLayer), Effect.scoped),
      );
    });
  });
});
