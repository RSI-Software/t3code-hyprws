import { isExactServiceVersion } from "./serviceProtocol.ts";

/**
 * The pinned-runtime installer asks npm for `t3@<version>`, which is a registry
 * spec. The fork publishes no npm package, so a fork version never resolves
 * there and every launcher-managed update fails before it starts.
 *
 * Each fork release instead carries an `npm pack`-shaped server tarball as a
 * release asset. npm accepts a tarball URL wherever it accepts a registry spec,
 * and the tarball unpacks to the same `node_modules/t3/` tree, so the staging
 * directory, the sentinel, the preflight validation, the launcher commit
 * boundary, and the SQLite rollback all stay as upstream wrote them.
 */
const FORK_RELEASE_REPOSITORY = "RSI-Software/t3code-hyprws";

/**
 * Matches the prerelease the fork release workflow writes: `hyprws.<n>` on a
 * stable tag, `hyprws-nightly.<date>.<run>` on a nightly. The version core
 * holds no hyphen, so the first one always starts the prerelease.
 */
const FORK_PRERELEASE = /^[^-]+-hyprws(?:-nightly)?\./;

/** True for an exact fork release version, such as `0.0.38-hyprws.1`. */
export const isForkServiceVersion = (version: string): boolean =>
  isExactServiceVersion(version) && FORK_PRERELEASE.test(version);

/** The release asset name `vp pm pack` writes for a server version. */
export const forkServerTarballName = (version: string): string => `t3-${version}.tgz`;

export const forkServerTarballUrl = (version: string): string =>
  `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/download/v${version}/${forkServerTarballName(version)}`;

/** The npm install spec for a pinned runtime: a fork release asset, else the registry. */
export const pinnedRuntimeInstallSpec = (version: string): string =>
  isForkServiceVersion(version) ? forkServerTarballUrl(version) : `t3@${version}`;
