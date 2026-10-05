// @effect-diagnostics nodeBuiltinImport:off - Inspect migration metadata without starting persistence.
import * as NodeSqlite from "node:sqlite";

import { migrationManifest } from "../persistence/Migrations.ts";

/** Absence means unknown, never permission to skip a backup. */
export function serviceMigrationPreflightFork(databasePath: string) {
  try {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare("SELECT MAX(migration_id) AS migration_id FROM effect_sql_migrations")
        .get();
      const applied = row?.migration_id === null ? 0 : row?.migration_id;
      const latest = Math.max(...migrationManifest.map(([id]) => id));
      if (
        typeof applied !== "number" ||
        !Number.isSafeInteger(applied) ||
        applied < 0 ||
        applied > latest
      ) {
        return {};
      }
      // ForkSchema only adds nullable columns and independent tables. Older
      // binaries ignore these on rollback, so they do not require a snapshot.
      return { pendingMigrationsFork: applied < latest };
    } finally {
      database.close();
    }
  } catch {
    return {};
  }
}
