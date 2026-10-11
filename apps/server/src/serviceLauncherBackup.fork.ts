// @effect-diagnostics nodeBuiltinImport:off - Keep the launcher independent of Effect and target persistence.
import * as NodeChildProcess from "node:child_process";

import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  type PendingServiceUpdate,
} from "./cloud/serviceProtocol.ts";

/** Check the target against the quiescent DB, including on launcher recovery. */
export async function backupDatabaseForMigrationsFork(
  baseDir: string,
  pending: PendingServiceUpdate,
  executable: string,
  backup: (baseDir: string, pending: PendingServiceUpdate) => Promise<void>,
): Promise<void> {
  // Never hand the preflight a launcher context: a runtime that reads one as a
  // pending trial may write to pending.dbPath, the live database.
  const { [SERVICE_LAUNCHER_CONTEXT_ENV]: _context, ...env } = process.env;
  const skipBackup = await new Promise<boolean>((resolve) => {
    NodeChildProcess.execFile(
      executable,
      [
        "__service-preflight",
        "--database-path",
        pending.dbPath,
        "--launcher-protocol",
        String(SERVICE_LAUNCHER_PROTOCOL),
      ],
      { env, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error !== null) return resolve(false);
        try {
          const result: unknown = JSON.parse(stdout.trim());
          resolve(
            typeof result === "object" &&
              result !== null &&
              "status" in result &&
              result.status === "ready" &&
              "version" in result &&
              result.version === pending.targetVersion &&
              "launcherProtocol" in result &&
              result.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
              "pendingMigrationsFork" in result &&
              result.pendingMigrationsFork === false,
          );
        } catch {
          resolve(false);
        }
      },
    );
  }).catch(() => false);
  // An existing snapshot is preserved by backupDatabaseOnce even when a trial
  // already migrated the database before a launcher restart.
  if (!skipBackup) await backup(baseDir, pending);
}
