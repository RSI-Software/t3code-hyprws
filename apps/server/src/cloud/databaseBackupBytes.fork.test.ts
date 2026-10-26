import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { databaseBackupBytesFork } from "./databaseBackupBytes.fork.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

it.layer(NodeServices.layer)("database backup size", (it) => {
  it.effect("is reported unless the preflight rules out pending migrations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dbPath = path.join(yield* fs.makeTempDirectoryScoped(), "state.sqlite");
      yield* fs.writeFileString(dbPath, "1234");
      yield* fs.writeFileString(`${dbPath}-wal`, "56");
      const ready = {
        status: "ready",
        version: "1.1.0",
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      } as const;
      const bytes = (pendingMigrationsFork?: boolean) =>
        databaseBackupBytesFork(fs, dbPath, {
          ...ready,
          ...(pendingMigrationsFork === undefined ? {} : { pendingMigrationsFork }),
        }).pipe(Effect.map((result) => result.databaseBackupBytesFork));
      expect(yield* bytes(true)).toBe(6);
      expect(yield* bytes(undefined)).toBe(6);
      expect(yield* bytes(false)).toBeUndefined();
    }),
  );
});
