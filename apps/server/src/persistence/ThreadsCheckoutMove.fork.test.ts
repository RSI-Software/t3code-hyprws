import {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadCheckoutMove,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { ProjectionThreadRepository } from "./Services/ProjectionThreads.ts";
import {
  ProjectionThreadCheckoutMoveRepositoryLive,
  type ProjectionThreadCheckoutMoveRow,
} from "./ThreadsCheckoutMove.fork.ts";

const makeRow = (threadId: ThreadId, checkoutMove?: ThreadCheckoutMove) =>
  ({
    threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    } satisfies ModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    latestTurnId: null,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:01.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    titleRegenerationRequestId: null,
    titleRegenerationStartedAt: null,
    latestUserMessageAt: null,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    deletedAt: null,
    ...(checkoutMove === undefined ? {} : { checkoutMove }),
  }) as ProjectionThreadCheckoutMoveRow;

const checkoutMoveRepositoryLayer = it.layer(
  ProjectionThreadCheckoutMoveRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

describe("checkout move projection repository", () => {
  checkoutMoveRepositoryLayer("keeps the move beside the upstream row", (it) => {
    it.effect("round-trips a checkout move through upsert and reads", () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadRepository;
        const threadId = ThreadId.make("thread-move");
        const move: ThreadCheckoutMove = {
          requestId: "00000000-0000-4000-8000-0000000000aa",
          status: "committed",
          requestedPath: "/workspace/feature",
          source: {
            repositoryRoot: "/workspace",
            checkoutRoot: "/workspace/main",
            revision: "abc123",
            branch: "main",
          },
          destination: {
            repositoryRoot: "/workspace",
            checkoutRoot: "/workspace/feature",
            revision: "def456",
            branch: "feature",
          },
          expectedCheckoutRoot: "/workspace/feature",
          completedSteps: ["metadata"],
          effectiveProvider: null,
          requestedAt: "2026-06-06T00:00:02.000Z",
          updatedAt: "2026-06-06T00:00:03.000Z",
        };

        yield* repository.upsert(makeRow(threadId, move));

        const row = yield* repository.getById({ threadId });
        expect(Option.isSome(row)).toBe(true);
        expect((row.value as ProjectionThreadCheckoutMoveRow).checkoutMove).toEqual(move);
        const rows = yield* repository.listByProjectId({ projectId: ProjectId.make("project-1") });
        expect(rows).toHaveLength(1);
        expect((rows[0] as ProjectionThreadCheckoutMoveRow).checkoutMove).toEqual(move);
      }),
    );

    it.effect("clears the move when a row upserts without one", () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadRepository;
        const threadId = ThreadId.make("thread-clear");
        const sql = yield* SqlClient.SqlClient;

        yield* repository.upsert(
          makeRow(threadId, {
            requestId: "00000000-0000-4000-8000-0000000000ab",
            status: "queued",
            requestedPath: "/workspace/feature",
            source: {
              repositoryRoot: "/workspace",
              checkoutRoot: "/workspace/main",
              revision: "abc123",
              branch: "main",
            },
            destination: null,
            expectedCheckoutRoot: "/workspace/feature",
            completedSteps: [],
            effectiveProvider: null,
            requestedAt: "2026-06-06T00:00:02.000Z",
            updatedAt: "2026-06-06T00:00:02.000Z",
          }),
        );
        yield* repository.upsert(makeRow(threadId));

        const row = yield* repository.getById({ threadId });
        expect(Option.isSome(row)).toBe(true);
        expect((row.value as ProjectionThreadCheckoutMoveRow).checkoutMove).toBeNull();

        const stored =
          yield* sql`SELECT checkout_move_json FROM projection_threads WHERE thread_id = ${threadId}`.pipe(
            Effect.flatMap((rows) =>
              Effect.succeed(rows as Array<{ checkout_move_json: unknown }>),
            ),
          );
        expect(stored).toHaveLength(1);
        expect(stored[0]?.checkout_move_json).toBeNull();
      }),
    );

    it.effect("drops the move with its row on delete", () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadRepository;
        const threadId = ThreadId.make("thread-delete");

        yield* repository.upsert(makeRow(threadId));
        yield* repository.deleteById({ threadId });

        const row = yield* repository.getById({ threadId });
        expect(Option.isNone(row)).toBe(true);
      }),
    );
  });
});
