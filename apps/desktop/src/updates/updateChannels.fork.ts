import type { DesktopUpdateChannel } from "@t3tools/contracts";

/**
 * electron-updater's GitHub provider matches a release to the updater channel
 * by the release tag's first semver prerelease identifier, and derives the
 * update-file name from that same identifier. Fork nightlies are tagged
 * `vX.Y.Z-hyprws-nightly.YYYYMMDD.N` and publish `hyprws-nightly-linux.yml`,
 * so the user-facing `nightly` channel must reach the updater as the fork's
 * tag identifier instead. See RSI-Software/t3code-hyprws#762 and
 * `scripts/build-desktop-artifact.ts`, which publishes the matching
 * electron-builder channel.
 */
export const FORK_NIGHTLY_UPDATE_CHANNEL = "hyprws-nightly";

export function resolveForkUpdaterChannel(channel: DesktopUpdateChannel): string {
  return channel === "nightly" ? FORK_NIGHTLY_UPDATE_CHANNEL : channel;
}
