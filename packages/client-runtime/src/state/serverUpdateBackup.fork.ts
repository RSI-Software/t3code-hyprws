import type { ServerUpdateState } from "./server.ts";

/** Names the pre-migration backup that dominates a large database's restart wait. */
export function serverUpdateRestartLabelFork(state: ServerUpdateState, fallback: string): string {
  if (
    state.status !== "running" ||
    state.stage !== "resuming" ||
    state.databaseBackupBytesFork === undefined
  )
    return fallback;
  const bytes = state.databaseBackupBytesFork;
  const size =
    bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `Backing up database (${size}) and restarting…`;
}
