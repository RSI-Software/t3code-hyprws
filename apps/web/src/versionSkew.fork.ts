// Fork-owned: the manual update-command override for fork server versions.
// The upstream `versionSkew.ts` carries only the marked hook line pointing
// here, falling through to the upstream `npx t3@<version>` text when this
// returns null.
import { isForkServiceVersion } from "@t3tools/shared/forkVersion";

const FORK_RELEASE_REPOSITORY = "RSI-Software/t3code-hyprws";

/**
 * `manualServerUpdateCommand` is only reached when the connected server
 * reports no self-update capability at all (see
 * `resolveServerSelfUpdateCapability`): a dev checkout, an `npx`-run server,
 * or an older build with nothing on this machine guaranteed to be an
 * installed, launcher-managed `t3`. `t3 update <version>` also resolves
 * releases from `pingdotgg/t3code` by default (see
 * `packages/shared/src/cliRelease.ts`), which never carries a `-hyprws` tag.
 * Neither gap is one this command can paper over, so a fork version gets the
 * release page instead of a command that may not run or may 404.
 */
export function forkManualServerUpdateCommand(targetVersion: string): string | null {
  if (!isForkServiceVersion(targetVersion)) return null;
  return `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/tag/v${targetVersion}`;
}
