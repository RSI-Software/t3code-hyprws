import { isForkNightlyDesktopVersion } from "./updateChannels.fork.ts"; // fork-hook: distribution/nightly-version-import

// Preview builds share nightly branding but ship without an update feed.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  if (isForkNightlyDesktopVersion(version)) {
    return true;
  } // fork-hook: distribution/nightly-version-branding
  return PRERELEASE_VERSION_PATTERN.test(version);
}
