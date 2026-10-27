// Pairing storage for `t3 pair`. Pair only mints a token for an already-running server, which
// owns its schema, so it must not migrate or analyze that database: that can time out an attach
// and leave the server on a schema newer than its code. A missing database gets full setup.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const runningServerDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem.exists(dbPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return SqlitePersistence.layerConfig;
    }
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA busy_timeout = 5000;`;
        yield* sql`PRAGMA foreign_keys = ON;`;
      }),
    ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })));
  }),
);

/** `EnvironmentAuth` for pair, whose `layerRuntime` opens the running server's database as is. */
export const PairEnvironmentAuth = {
  EnvironmentAuth: EnvironmentAuth.EnvironmentAuth,
  layerRuntime: EnvironmentAuth.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(ServerSecretStore.layer, runningServerDatabase)),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
  ),
};
