import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as LegacyImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  withCheckoutSessionCleanupFork,
  withCheckoutSessionMutationFork,
} from "./CheckoutSessionStateLease.fork.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(database),
);
const enrichment = {
  repositoryIdentity: null,
  faviconPath: null,
  repositoryIdentityResolved: true,
};
const core = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  Layer.mock(WorkspacePaths.WorkspacePaths)({ normalizeWorkspaceRoot: Effect.succeed }),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
    peek: () => Effect.succeed(enrichment),
    getAvailable: () => Effect.succeed(enrichment),
    request: () => Effect.void,
    invalidate: () => Effect.void,
  }),
);
const dependencies = Layer.merge(core, LegacyImporter.layer.pipe(Layer.provide(core)));
const testLayer = Layer.mergeAll(
  dependencies,
  ProjectService.layer.pipe(Layer.provide(dependencies)),
  ProviderEventIngestor.layer.pipe(Layer.provide(dependencies)),
);

it.effect("ordinary mutations remain concurrent; pending cleanup excludes later mutations", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const cleanupEntered = yield* Deferred.make<void>();
    const releaseCleanup = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(
      withCheckoutSessionMutationFork(
        Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
        ),
      ),
    );
    yield* Deferred.await(firstEntered);
    // This finishes while the first writer is still holding its mutation permit.
    yield* withCheckoutSessionMutationFork(Effect.void);
    const cleanup = yield* Effect.forkChild(
      withCheckoutSessionCleanupFork(
        Deferred.succeed(cleanupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCleanup)),
        ),
      ),
    );
    yield* Effect.yieldNow;
    const later = yield* Effect.forkChild(withCheckoutSessionMutationFork(Effect.void));
    yield* Effect.yieldNow;
    assert.isUndefined(later.pollUnsafe());
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Deferred.await(cleanupEntered);
    assert.isUndefined(later.pollUnsafe());
    yield* Deferred.succeed(releaseCleanup, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(cleanup);
    yield* Fiber.join(later);
  }),
);

it.layer(testLayer)("persistence lease entrypoints", (it) => {
  it.effect(
    "provider-created consumers and project root updates wait for destructive cleanup",
    () =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const sink = yield* EventSink.EventSinkV2;
        const projectId = ProjectId.make("project:lease");
        const parentId = ThreadId.make("thread:lease-parent");
        const childId = ThreadId.make("thread:lease-child");
        const now = yield* DateTime.now;
        yield* projects.create({
          projectId,
          commandId: CommandId.make("create-lease-project"),
          title: "Lease",
          workspaceRoot: "/repo",
        });
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        const parent: OrchestrationV2AppThread = {
          id: parentId,
          projectId,
          title: "Parent",
          modelSelection,
          providerInstanceId: modelSelection.instanceId,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature",
          worktreePath: "/repo-feature",
          branchPullRequest: null,
          activeOrderKey: null,
          activeProviderThreadId: null,
          createdBy: "user",
          creationSource: "web",
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:lease-parent"),
              threadId: parentId,
              occurredAt: now,
              type: "thread.created",
              payload: parent,
            },
          ],
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let cleaning = true;
        const cleanup = yield* Effect.forkChild(
          withCheckoutSessionCleanupFork(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(entered);
        const child = yield* Effect.forkChild(
          ingestor
            .ingestNormalized({
              providerSessionId: ProviderSessionId.make("provider-session:lease"),
              providerInstanceId: modelSelection.instanceId,
              threadId: parentId,
              event: {
                type: "app_thread.created",
                driver: ProviderDriverKind.make("codex"),
                appThread: {
                  ...parent,
                  id: childId,
                  lineage: {
                    parentThreadId: parentId,
                    relationshipToParent: "subagent",
                    rootThreadId: parentId,
                  },
                },
              },
            })
            .pipe(Effect.tap(() => Effect.sync(() => assert.equal(cleaning, false)))),
        );
        const root = yield* Effect.forkChild(
          projects
            .update({
              projectId,
              commandId: CommandId.make("move-lease-root"),
              workspaceRoot: "/repo-feature",
            })
            .pipe(Effect.tap(() => Effect.sync(() => assert.equal(cleaning, false)))),
        );
        // Drain runnable tasks; both production entrypoints must park before SQL mutation.
        yield* Effect.yieldNow;
        assert.isUndefined(child.pollUnsafe());
        assert.isUndefined(root.pollUnsafe());
        assert.equal(Option.getOrThrow(yield* projects.getShell(projectId)).workspaceRoot, "/repo");
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${childId}`,
          [],
        );
        cleaning = false;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(cleanup);
        yield* Fiber.join(child);
        yield* Fiber.join(root);
        assert.equal(
          Option.getOrThrow(yield* projects.getShell(projectId)).workspaceRoot,
          "/repo-feature",
        );
        assert.equal((yield* projections.getThread(childId)).worktreePath, "/repo-feature");
      }),
  );
});
