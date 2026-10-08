import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as AttachGuard from "./SettledLaneAttachGuard.fork.ts";
import { makeSettledLaneReactor } from "./SettledLaneSessions.fork.ts";
import { withCheckoutSessionMutationFork } from "./CheckoutSessionStateLease.fork.ts";
import * as Binder from "./ZmuxSessionBinder.ts";

const id = ThreadId.make("lane");
const projectId = ProjectId.make("project");
const identity = { target: "proof/feature", nativeId: "$22", serverId: "123:456", createdAt: 123 };
const shell = (overrides: Partial<OrchestrationV2AppThread> = {}) =>
  ({
    id,
    projectId,
    worktreePath: "/repo-feature",
    archivedAt: null,
    settledOverride: "settled",
    ...overrides,
  }) as OrchestrationV2AppThread;

const harness = () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const checkoutRoots = new Map<string, string>();
    const realPaths = new Map<string, string>();
    const unresolved = new Set<string>();
    let thread = shell();
    let consumers: OrchestrationV2AppThread[] = [];
    let target = identity.target;
    let beforeCleanup: Effect.Effect<void> = Effect.void;
    let beforeUnbind: Effect.Effect<void> = Effect.void;
    let releaseSucceeded = true;
    const roots = new Map([[projectId, "/repo"]]);
    const restored = yield* Queue.unbounded<string>();
    let refuse = false;
    let hasProject = true;
    const calls: string[] = [];
    const removed = yield* Queue.unbounded<Binder.ZmuxUnbindIdentity>();
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      FileSystem.layerNoop({
        realPath: (cwd) => Effect.succeed(realPaths.get(cwd) ?? path.resolve(cwd)),
      }),
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: ({ cwd }) => {
          const key = path.resolve(cwd);
          return unresolved.has(key)
            ? Effect.fail(
                new VcsUnsupportedOperationError({
                  operation: "fixture.resolve",
                  kind: "git",
                  detail: "checkout identity unavailable",
                }),
              )
            : Effect.succeed({
                repository: { rootPath: checkoutRoots.get(key) ?? key },
              } as VcsDriverRegistry.VcsDriverHandle);
        },
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread: () => Effect.sync(() => thread) }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        getShell: (owner) =>
          Effect.sync(() =>
            hasProject
              ? Option.some({
                  workspaceRoot: roots.get(owner) ?? "/repo",
                } as OrchestrationProjectShell)
              : Option.none(),
          ),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        getShellSnapshot: () =>
          Effect.sync(
            () =>
              ({
                threads: [thread, ...consumers],
              }) as unknown as OrchestrationV2ThreadShellSnapshot,
          ),
        streamDomainEvents: Stream.unwrap(
          Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.fromQueue(events))),
        ),
      }),
      Layer.mock(TerminalManager.TerminalManager)({
        releaseSettledManagedAttachments: () =>
          Effect.sync(() => {
            calls.push("release");
            return releaseSucceeded;
          }),
      }),
      Layer.mock(Binder.ZmuxSessionBinder)({
        bind: (lane) =>
          Effect.sync(() => {
            calls.push(`bind:${lane}`);
            Queue.offerUnsafe(restored, lane);
            return { status: "bound", target, outcome: "created" } as const;
          }),
        prepareUnbind: (lane) =>
          Effect.gen(function* () {
            calls.push(`prepare:${lane}`);
            yield* beforeCleanup;
            return { status: "prepared", identity: { ...identity, target } } as const;
          }),
        resolve: () =>
          Effect.succeed({
            status: "resolved",
            target: "proof/main",
            match: "workspace-main",
          } as const),
        unbind: (exact) =>
          Effect.gen(function* () {
            calls.push("unbind");
            yield* beforeUnbind;
            yield* Queue.offer(removed, exact);
            return refuse
              ? ({
                  status: "failed",
                  notice: { summary: "refused", detail: "external viewer" },
                } as const)
              : ({ status: "unbound", target: exact.target } as const);
          }),
      }),
    );
    const reactor = yield* makeSettledLaneReactor.pipe(Effect.provide(dependencies));
    return {
      reactor,
      calls,
      dependencies,
      restored: Queue.take(restored),
      subscribed: Deferred.await(subscribed),
      removed: Queue.take(removed),
      emit: (type: "thread.settled" | "thread.unsettled" | "thread.pinned") =>
        Queue.offer(events, { type, threadId: id } as OrchestrationV2DomainEvent),
      setThread: (value: Partial<OrchestrationV2AppThread>) => {
        thread = { ...thread, ...value };
      },
      share: (value: Partial<OrchestrationV2AppThread> = {}) => {
        consumers.push(shell({ id: ThreadId.make("other"), settledOverride: "active", ...value }));
      },
      setTarget: (value: string) => {
        target = value;
      },
      setBeforeCleanup: (effect: Effect.Effect<void>) => {
        beforeCleanup = effect;
      },
      setBeforeUnbind: (effect: Effect.Effect<void>) => {
        beforeUnbind = effect;
      },
      setRoot: (owner: ProjectId, root: string) => {
        roots.set(owner, root);
      },
      setCheckoutRoot: (cwd: string, root: string) => {
        checkoutRoots.set(cwd, root);
      },
      setRealPath: (cwd: string, root: string) => {
        realPaths.set(cwd, root);
      },
      forgetIdentity: (cwd: string) => {
        unresolved.add(cwd);
      },
      failRelease: () => {
        releaseSucceeded = false;
      },
      refuse: () => {
        refuse = true;
      },
      forgetProject: () => {
        hasProject = false;
      },
    };
  }).pipe(Effect.provide(NodeServices.layer));

describe("settled checkout sessions", () => {
  it.effect("releases the managed attachment before exact-identity session removal", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.reactor.reconcile(id);
      expect(h.calls).toEqual(["release", "prepare:/repo-feature", "unbind"]);
      expect(yield* h.removed).toEqual(identity);
    }),
  );

  it.effect.each([null, "/repo", "/repo/../repo"])(
    "preserves the base checkout at %s",
    (worktreePath) =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.setThread({ worktreePath });
        yield* h.reactor.reconcile(id);
        h.setThread({ settledOverride: "active" });
        yield* h.reactor.reconcile(id);
        expect(h.calls).toEqual([]);
      }),
  );

  it.effect("preserves a malformed main-session binding", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setTarget("proof/main");
      yield* h.reactor.reconcile(id);
      expect(h.calls).not.toContain("unbind");
    }),
  );

  it.effect.each([projectId, ProjectId.make("another-project")])(
    "preserves active shared consumers in %s",
    (owner) =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.share({ projectId: owner });
        yield* h.reactor.reconcile(id);
        expect(h.calls).toEqual(["release"]);
      }),
  );

  it.effect.each(["/repo-feature/packages/server", "/alias-feature"])(
    "preserves an active consumer reached through %s",
    (cwd) =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.setCheckoutRoot(cwd, cwd === "/alias-feature" ? cwd : "/repo-feature");
        h.setRealPath("/alias-feature", "/repo-feature");
        h.share({ worktreePath: cwd });
        yield* h.reactor.reconcile(id);
        expect(h.calls).toEqual(["release"]);
      }),
  );

  it.effect.each(["/repo-feature/packages/server", "/alias-feature"])(
    "preserves another project's active root reached through %s",
    (cwd) =>
      Effect.gen(function* () {
        const h = yield* harness();
        const owner = ProjectId.make("alias-root-consumer");
        h.setCheckoutRoot(cwd, cwd === "/alias-feature" ? cwd : "/repo-feature");
        h.setRealPath("/alias-feature", "/repo-feature");
        h.setRoot(owner, cwd);
        h.share({ projectId: owner, worktreePath: null });
        yield* h.reactor.reconcile(id);
        expect(h.calls).toEqual(["release"]);
      }),
  );

  it.effect("preserves uncertain active-consumer identity", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.share({ worktreePath: "/unknown-checkout" });
      h.forgetIdentity("/unknown-checkout");
      yield* h.reactor.reconcile(id);
      expect(h.calls).toEqual(["release"]);
    }),
  );

  it.effect("re-resolves a project alias changed during identity preparation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setRoot(projectId, "/alias-root");
      h.setRealPath("/alias-root", "/repo");
      h.setBeforeCleanup(Effect.sync(() => h.setRealPath("/alias-root", "/repo-feature")));
      yield* h.reactor.reconcile(id);
      expect(h.calls).not.toContain("unbind");
    }),
  );

  it.effect.each([
    { settledOverride: "settled" as const },
    { archivedAt: "2026-01-01" as unknown as OrchestrationV2AppThread["archivedAt"] },
  ])("ignores parked consumers %j", (other) =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.share(other);
      yield* h.reactor.reconcile(id);
      expect(h.calls).toContain("unbind");
    }),
  );

  it.effect("does not remove a lane re-engaged during identity preparation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setBeforeCleanup(Effect.sync(() => h.setThread({ settledOverride: "active" })));
      yield* h.reactor.reconcile(id);
      expect(h.calls).not.toContain("unbind");
      yield* h.reactor.reconcile(id);
      expect(h.calls.at(-1)).toBe("bind:/repo-feature");
    }),
  );

  it.effect.each([false, true])(
    "protects a newly owning root before exclusivity (missing=%s)",
    (missing) =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.setBeforeCleanup(
          Effect.sync(() => {
            if (missing) h.forgetProject();
            else h.setRoot(projectId, "/repo-feature");
          }),
        );
        yield* h.reactor.reconcile(id);
        expect(h.calls).not.toContain("unbind");
      }),
  );

  it.effect("rechecks shared consumers immediately before cleanup", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setBeforeCleanup(Effect.sync(() => h.share()));
      yield* h.reactor.reconcile(id);
      expect(h.calls).not.toContain("unbind");
    }),
  );

  it.effect("restores an unsettled checkout through the binder, not terminal ensure", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setThread({ settledOverride: "active" });
      yield* h.reactor.reconcile(id);
      expect(h.calls).toEqual(["bind:/repo-feature"]);
    }),
  );

  it.effect("preserves unknown ownership and survives a cleanup refusal", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.refuse();
      yield* h.reactor.reconcile(id);
      expect(h.calls.filter((call) => call === "unbind")).toHaveLength(1);
      h.forgetProject();
      yield* h.reactor.reconcile(id);
      expect(h.calls.filter((call) => call === "unbind")).toHaveLength(1);
    }),
  );

  it.effect("starts a live subscription for settlement from every transport", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.reactor.start();
      yield* h.subscribed;
      yield* h.emit("thread.settled");
      expect(yield* h.removed).toEqual(identity);
    }),
  );

  it.effect("preserves a lane used as another active project's root", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const owner = ProjectId.make("root-consumer");
      h.setRoot(owner, "/repo-feature");
      h.share({ projectId: owner, worktreePath: null });
      yield* h.reactor.reconcile(id);
      expect(h.calls).toEqual(["release"]);
    }),
  );

  it.effect("does not remove a session whose local viewer has not exited", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.failRelease();
      yield* h.reactor.reconcile(id);
      expect(h.calls).toEqual(["release"]);
    }),
  );

  it.effect("pin promotion restores without opening a terminal", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.reactor.start();
      yield* h.subscribed;
      h.setThread({ settledOverride: "active" });
      yield* h.emit("thread.pinned");
      expect(yield* h.restored).toBe("/repo-feature");
    }),
  );

  it.effect("excludes re-engagement commits through the final destructive interval", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const cleaning = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const mutationStarted = yield* Deferred.make<void>();
      const mutationDone = yield* Deferred.make<void>();
      h.setBeforeUnbind(
        Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      );
      yield* h.reactor.reconcile(id).pipe(Effect.forkScoped);
      yield* Deferred.await(cleaning);
      yield* Deferred.succeed(mutationStarted, undefined).pipe(
        Effect.andThen(
          withCheckoutSessionMutationFork(
            Effect.sync(() => h.setThread({ settledOverride: "active" })),
          ),
        ),
        Effect.andThen(Deferred.succeed(mutationDone, undefined)),
        Effect.forkScoped,
      );
      yield* Deferred.await(mutationStarted);
      expect(yield* Deferred.isDone(mutationDone)).toBe(false);
      yield* Deferred.succeed(finish, undefined);
      yield* Deferred.await(mutationDone);
      expect(yield* h.removed).toEqual(identity);
      yield* h.reactor.reconcile(id);
      expect(yield* h.restored).toBe("/repo-feature");
    }),
  );

  it.effect("blocks managed session recreation while settled and permits it after unsettle", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const guard = yield* AttachGuard.make.pipe(Effect.provide(h.dependencies));
      expect(yield* guard.isSettledThread(id)).toBe(true);
      h.setThread({ settledOverride: "active" });
      expect(yield* guard.isSettledThread(id)).toBe(false);
    }),
  );
});
