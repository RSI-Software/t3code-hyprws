// Fork-owned: the manual update-command override for fork server versions.
// The upstream `versionSkew.ts` carries only the marked hook line pointing
// here, falling through to the upstream `npx t3@<version>` text when this
// returns null.
import { isForkServiceVersion } from "@t3tools/shared/forkVersion";

/**
 * `manualServerUpdateCommand` is only reached when the connected server
 * reports no self-update capability (see `resolveServerSelfUpdateCapability`).
 * A fork server has no npm package for `npx t3@<version>` to fetch, so a fork
 * version gets `t3 update <version>`, which installs the fork release on the
 * host through the `t3` the fork installer put there.
 */
export function forkManualServerUpdateCommand(targetVersion: string): string | null {
  if (!isForkServiceVersion(targetVersion)) return null;
  return `t3 update ${targetVersion}`;
}
