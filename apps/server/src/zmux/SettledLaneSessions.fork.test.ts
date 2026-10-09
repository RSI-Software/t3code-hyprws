import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
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
    deletedAt: null,
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
    let refuse = false;
    let hasProject = true;
    let projectDeleted = false;
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
        get: (owner, options) =>
          Effect.sync(() =>
            hasProject && (!projectDeleted || options?.includeDeleted)
              ? Option.some({
                  workspaceRoot: roots.get(owner) ?? "/repo",
                } as ProjectStore.ProjectRow)
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
      subscribed: Deferred.await(subscribed),
      removed: Queue.take(removed),
      emit: (type: "thread.settled" | "thread.deleted" | "thread.unsettled" | "thread.pinned") =>
        Queue.offer(events, { type, threadId: id } as OrchestrationV2DomainEvent),
      setThread: (value: Partial<OrchestrationV2AppThread>) => {
        thread = { ...thread, ...value };
      },
      share: (value: Partial<OrchestrationV2AppThread> = {}) => {
        consumers.push(
          shell({
            id: ThreadId.make(`other-${consumers.length}`),
            settledOverride: "active",
            ...value,
          }),
        );
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
      deleteProject: () => {
        projectDeleted = true;
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
        h.deleteProject();
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
      h.deleteProject();
      h.setTarget("proof/main");
      yield* h.reactor.reconcile(id);
      expect(h.calls).not.toContain("unbind");
    }),
  );

  it.effect.each(["before reconciliation", "during identity preparation"])(
    "removes the session when its project is deleted %s",
    (timing) =>
      Effect.gen(function* () {
        const h = yield* harness();
        h.setThread({
          settledOverride: "active",
          deletedAt: DateTime.makeUnsafe("2026-10-10T00:00:00Z"),
        });
        if (timing === "before reconciliation") h.deleteProject();
        else h.setBeforeCleanup(Effect.sync(h.deleteProject));
        yield* h.reactor.reconcile(id);
        expect(h.calls).toEqual(["release", "prepare:/repo-feature", "unbind"]);
        expect(yield* h.removed).toEqual(identity);
      }),
  );

  it.effect("shared and unrelated consumers do not veto requested teardown", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const owner = ProjectId.make("other-project");
      h.setRoot(owner, "/repo-feature");
      h.setCheckoutRoot("/repo-feature/packages/server", "/repo-feature");
      h.setRealPath("/alias-feature", "/repo-feature");
      h.forgetIdentity("/unknown-checkout");
      const consumers: Partial<OrchestrationV2AppThread>[] = [
        {},
        { projectId: owner },
        { projectId: owner, worktreePath: null },
        ...["/repo-feature/packages/server", "/alias-feature", "/unknown-checkout"].map(
          (worktreePath) => ({ worktreePath }),
        ),
        { settledOverride: "settled" },
        { archivedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z") },
      ];
      consumers.forEach(h.share);
      yield* h.reactor.reconcile(id);
      expect(yield* h.removed).toEqual(identity);
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

  it.effect("does not remove a lane re-engaged during identity preparation", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setBeforeCleanup(Effect.sync(() => h.setThread({ settledOverride: "active" })));
      yield* h.reactor.reconcile(id);
      expect(h.calls).not.toContain("unbind");
      yield* h.reactor.reconcile(id);
      expect(h.calls).not.toContain("bind:/repo-feature");
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

  it.effect("a new shared consumer does not cancel requested teardown", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setBeforeCleanup(Effect.sync(() => h.share()));
      yield* h.reactor.reconcile(id);
      expect(yield* h.removed).toEqual(identity);
    }),
  );

  it.effect("unsettling leaves the removed session gone", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.reactor.reconcile(id);
      expect(yield* h.removed).toEqual(identity);
      h.setThread({ settledOverride: "active" });
      yield* h.reactor.reconcile(id);
      expect(h.calls).not.toContain("bind:/repo-feature");
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

  it.effect.each(["thread.settled", "thread.deleted"] as const)(
    "tears down the session on %s from every transport",
    (type) =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.reactor.start();
        yield* h.subscribed;
        if (type === "thread.deleted") {
          h.setThread({
            settledOverride: "active",
            deletedAt: DateTime.makeUnsafe("2026-10-10T00:00:00Z"),
          });
        }
        yield* h.emit(type);
        expect(yield* h.removed).toEqual(identity);
      }),
  );

  it.effect("removes the session even when the local viewer does not acknowledge exit", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.failRelease();
      yield* h.reactor.reconcile(id);
      expect(yield* h.removed).toEqual(identity);
    }),
  );

  it.effect("an active thread does not recreate a session", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setThread({ settledOverride: "active" });
      yield* h.reactor.reconcile(id);
      expect(h.calls).toEqual([]);
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
      expect(h.calls).not.toContain("bind:/repo-feature");
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

  it.effect("blocks session recreation after deletion even if the thread was active", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setThread({
        settledOverride: "active",
        deletedAt: DateTime.makeUnsafe("2026-10-10T00:00:00Z"),
      });
      const guard = yield* AttachGuard.make.pipe(Effect.provide(h.dependencies));
      expect(yield* guard.isSettledThread(id)).toBe(true);
    }),
  );
});
