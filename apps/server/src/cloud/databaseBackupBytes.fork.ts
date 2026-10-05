import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type { ServicePreflightResult } from "./servicePreflight.ts";

/**
 * Size of the copy the service launcher makes before a migrating trial, so
 * clients can name that wait instead of showing a bare restart. Mirrors the
 * launcher's skip rule: only a preflight reporting no pending migrations skips it.
 */
export const databaseBackupBytesFork = Effect.fn("cloud.server_self_update.backup_bytes_fork")(
  function* (fs: FileSystem.FileSystem, dbPath: string, preflight?: ServicePreflightResult) {
    if (preflight?.status === "ready" && preflight.pendingMigrationsFork === false) return {};
    let bytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      const info = yield* fs.stat(`${dbPath}${suffix}`).pipe(Effect.option);
      if (Option.isSome(info)) bytes += Number(info.value.size);
    }
    return bytes > 0 ? { databaseBackupBytesFork: bytes } : {};
  },
);
