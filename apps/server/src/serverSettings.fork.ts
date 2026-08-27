import type { ProjectSettingsOverrides } from "@t3tools/contracts";
import { toWireThreadEnvModeFields } from "@t3tools/shared/threadEnvMode.fork";

/**
 * Folds a legacy project row the fork stored as "worktrunk", which upstream's fold would drop.
 * It folds as the wire pair: "worktree" in the slot released clients read, and the exact mode in
 * its `...Fork` sibling. A key already in the generic record wins, as for every upstream key.
 */
export function foldLegacyWorktrunkEnvModeFork(
  entries: Record<string, ProjectSettingsOverrides>,
  row: { readonly projectId: string; readonly defaultThreadEnvMode: string | null },
): void {
  if (row.defaultThreadEnvMode !== "worktrunk") return;
  const entry = entries[row.projectId] ?? {};
  if (Object.hasOwn(entry, "defaultThreadEnvMode")) return;
  entries[row.projectId] = { ...entry, ...toWireThreadEnvModeFields("worktrunk") };
}
