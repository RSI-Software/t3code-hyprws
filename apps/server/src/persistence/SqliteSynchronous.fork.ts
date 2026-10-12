import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * In WAL mode, `NORMAL` syncs at checkpoints instead of on every commit.
 * Commits run on the main thread, so a per-commit fsync on a slow disk stalls
 * the whole server. A power loss can drop the last commits; the database stays
 * consistent.
 */
export const relaxWalSyncFork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA synchronous = NORMAL;`;
});
