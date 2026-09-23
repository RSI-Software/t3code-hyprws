// Fork-owned: the manual update-command override for fork server versions.
// The upstream `versionSkew.ts` carries only the marked hook line pointing
// here, falling through to the upstream `npx t3@<version>` text when this
// returns null.
import { isForkServiceVersion } from "@t3tools/shared/forkVersion";

/**
 * Reached only when the server reports no self-update capability. A fork server has no npm
 * package for `npx t3@<version>`, so a fork version gets `t3 update <version>`, which installs
 * the fork release through the `t3` the fork installer put on the host.
 */
export function forkManualServerUpdateCommand(targetVersion: string): string | null {
  if (!isForkServiceVersion(targetVersion)) return null;
  return `t3 update ${targetVersion}`;
}
