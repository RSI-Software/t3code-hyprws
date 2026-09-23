const SEMVER_NUMBER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE = `(?:${SEMVER_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
/** Exact `major.minor.patch` SemVer only: never a dist-tag or a range. Both
    the server and the web client pass this the exact version string off the
    wire, and matching loosely could send an upstream client at a fork-only
    asset or a fork client at the npm registry. */
const EXACT_SEMVER = new RegExp(
  `^${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-${SEMVER_PRERELEASE}(?:\\.${SEMVER_PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

/**
 * Matches the prerelease the fork release workflow writes: `hyprws.<n>` on a
 * stable tag, `hyprws-nightly.<date>.<run>` on a nightly. The version core
 * holds no hyphen, so the first one always starts the prerelease.
 */
const FORK_PRERELEASE = /^[^-]+-hyprws(?:-nightly)?\./;

/**
 * True for an exact fork release version, such as `0.0.38-hyprws.1`. Shared
 * so both the server (asset URLs, the pinned-runtime installer) and the web
 * client (the manual update command) agree on one predicate.
 */
export function isForkServiceVersion(version: string): boolean {
  return EXACT_SEMVER.test(version) && FORK_PRERELEASE.test(version);
}
