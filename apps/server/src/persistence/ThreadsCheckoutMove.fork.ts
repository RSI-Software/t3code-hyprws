import { ThreadCheckoutMove, ThreadId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "./Errors.ts";
import { ProjectionThreadRepositoryLive } from "./Layers/ProjectionThreads.ts";
import {
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "./Services/ProjectionThreads.ts";

/**
 * Projection row extended with the fork-owned checkout-move column. The column
 * itself is created by the idempotent `ForkSchema.ts` pass; this decorator is
 * the only reader and writer, so upstream `ProjectionThreads.ts` keeps its
 * upstream SQL and schema untouched.
 */
export interface ProjectionThreadCheckoutMoveRow extends Schema.Schema.Type<
  typeof ProjectionThread
> {
  readonly checkoutMove?: ThreadCheckoutMove | null;
}

const SetThreadCheckoutMoveInput = Schema.Struct({
  threadId: ThreadId,
  checkoutMoveJson: Schema.NullOr(Schema.String),
});

const CheckoutMoveRow = Schema.Struct({
  checkoutMove: Schema.NullOr(Schema.fromJsonString(ThreadCheckoutMove)),
});
const CheckoutMoveThreadRow = Schema.Struct({
  threadId: ThreadId,
  checkoutMove: Schema.NullOr(Schema.fromJsonString(ThreadCheckoutMove)),
});
const encodeCheckoutMove = Schema.encodeSync(Schema.fromJsonString(ThreadCheckoutMove));

const makeCheckoutMoveRepository = Effect.gen(function* () {
  const upstream = yield* ProjectionThreadRepository;
  const sql = yield* SqlClient.SqlClient;

  // The upstream upsert always leaves the row present, so a plain UPDATE hits
  // exactly the row it wrote. The IS NOT guard keeps a same-value write from
  // touching the row, so update-count observers see one write per upsert,
  // exactly as the pre-reshape single-statement upsert produced.
  const setCheckoutMoveRow = SqlSchema.void({
    Request: SetThreadCheckoutMoveInput,
    execute: ({ threadId, checkoutMoveJson }) => sql`
      UPDATE projection_threads
      SET checkout_move_json = ${checkoutMoveJson}
      WHERE thread_id = ${threadId}
        AND checkout_move_json IS NOT ${checkoutMoveJson}
    `,
  });

  const getCheckoutMoveRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: CheckoutMoveRow,
    execute: ({ threadId }) => sql`
      SELECT checkout_move_json AS "checkoutMove"
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `,
  });

  const listCheckoutMoveRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: CheckoutMoveThreadRow,
    execute: ({ projectId }) => sql`
      SELECT
        thread_id AS "threadId",
        checkout_move_json AS "checkoutMove"
      FROM projection_threads
      WHERE project_id = ${projectId}
    `,
  });

  const setCheckoutMove = (input: typeof SetThreadCheckoutMoveInput.Type) =>
    setCheckoutMoveRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.checkoutMove:set")),
    );

  const upsert = (thread: ProjectionThreadCheckoutMoveRow) => {
    const { checkoutMove, ...base } = thread;
    return Effect.gen(function* () {
      yield* upstream.upsert(base);
      yield* setCheckoutMove({
        threadId: base.threadId,
        checkoutMoveJson: checkoutMove ? encodeCheckoutMove(checkoutMove) : null,
      });
    });
  };

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    Effect.gen(function* () {
      const row = yield* upstream.getById(input);
      if (Option.isNone(row)) return row;
      const move = yield* getCheckoutMoveRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.checkoutMove:get")),
      );
      return Option.map(row, (value): ProjectionThreadCheckoutMoveRow => ({
        ...value,
        checkoutMove: Option.isSome(move) ? move.value.checkoutMove : null,
      }));
    });

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* upstream.listByProjectId(input);
      if (rows.length === 0) return rows;
      const moves = yield* listCheckoutMoveRows(input).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.checkoutMove:list")),
      );
      const byThreadId = new Map(moves.map((move) => [move.threadId, move.checkoutMove]));
      return rows.map((value): ProjectionThreadCheckoutMoveRow => ({
        ...value,
        checkoutMove: byThreadId.get(value.threadId) ?? null,
      }));
    });

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById: upstream.deleteById,
  } satisfies ProjectionThreadRepositoryShape;
});

/**
 * Fork decorator over the upstream thread projection repository. Providing
 * this layer instead of `ProjectionThreadRepositoryLive` keeps the checkout
 * move beside the upstream row without touching upstream persistence code.
 */
export const ProjectionThreadCheckoutMoveRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeCheckoutMoveRepository,
).pipe(Layer.provide(ProjectionThreadRepositoryLive));
