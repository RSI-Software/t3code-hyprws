import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { forkCliReleaseChannelOf } from "@t3tools/shared/forkVersion";

/**
 * electron-updater matches releases and update-file names by the tag's first
 * prerelease identifier. Fork nightlies are `vX.Y.Z-hyprws-nightly.*` and publish
 * `hyprws-nightly-linux.yml` (see `scripts/build-desktop-artifact.ts`), so the
 * `nightly` channel must reach the updater as `hyprws-nightly`.
 */
export const FORK_NIGHTLY_UPDATE_CHANNEL = "hyprws-nightly";

export function resolveForkUpdaterChannel(channel: DesktopUpdateChannel): string {
  return channel === "nightly" ? FORK_NIGHTLY_UPDATE_CHANNEL : channel;
}

/**
 * True for a fork nightly (`X.Y.Z-hyprws-nightly.YYYYMMDD.N`). Upstream only
 * matches a bare `-nightly.`, so a fork nightly would otherwise read as `latest`
 * and reject every nightly offered. A fork stable (`-hyprws.N`) stays `latest`.
 */
export function isForkNightlyDesktopVersion(version: string): boolean {
  return forkCliReleaseChannelOf(version) === "nightly";
}
