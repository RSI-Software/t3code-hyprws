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

/**
 * The repository fork releases publish to. `cliRelease.ts` reads it through a
 * marked hook, so `t3 update`, the pinned runtime, and the SSH runner resolve
 * the release index and archive downloads here instead of upstream's
 * repository. `T3CODE_RELEASE_BASE_URL` still overrides the download origin.
 */
export const FORK_RELEASE_REPOSITORY = "RSI-Software/t3code-hyprws";

/** The nightly tag the fork release workflow writes: `hyprws-nightly.<date>.<run>`. */
const FORK_NIGHTLY_VERSION = /^[^-+]+-hyprws-nightly\.\d{8}\.\d+$/;

/**
 * `"nightly"` for a fork nightly version, otherwise `undefined` so upstream's
 * channel rule decides. Upstream reads a train from the first prerelease
 * identifier, which a fork nightly spells `hyprws-nightly`; a fork stable
 * (`hyprws.<n>`) already falls through to upstream's `"stable"`.
 */
export function forkCliReleaseChannelOf(version: string): "nightly" | undefined {
  return FORK_NIGHTLY_VERSION.test(version) ? "nightly" : undefined;
}

/**
 * True when the version-skew check should compare two versions in full rather
 * than by `major.minor.patch`: both are fork releases on the same channel.
 * Fork stables share a core across `hyprws.<n>` builds and fork nightlies
 * never carry upstream's `nightly` identifier, so upstream's core-only rule
 * would read `0.0.43-hyprws.3` against `0.0.43-hyprws.2` as equal. A fork
 * stable against a fork nightly keeps upstream's core comparison.
 */
export function forkComparesFullVersions(clientVersion: string, serverVersion: string): boolean {
  return (
    isForkServiceVersion(clientVersion) &&
    isForkServiceVersion(serverVersion) &&
    forkCliReleaseChannelOf(clientVersion) === forkCliReleaseChannelOf(serverVersion)
  );
}
