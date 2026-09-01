// @effect-diagnostics globalDate:off - Calendar validation must reject normalized impossible dates.

export const FORK_REPOSITORY = "RSI-Software/t3code-hyprws";
export const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
export const HYPRWS_BRANCH = "hyprws";
export const HYPRWS_REF = `refs/heads/${HYPRWS_BRANCH}`;
export const ORIGIN_HYPRWS_REF = `refs/remotes/origin/${HYPRWS_BRANCH}`;
export const UPSTREAM_LANE = "upstream/main";

export interface VersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface UpstreamReleaseTag extends VersionParts {
  readonly tag: string;
  readonly channel: "stable" | "nightly";
  readonly date?: string;
  readonly runNumber?: number;
}

export interface StableForkTag extends VersionParts {
  readonly tag: string;
  readonly revision: number;
}

export interface NightlyForkTag extends VersionParts {
  readonly tag: string;
  readonly date: string;
  readonly runNumber: number;
}

const validDate = (value: string): boolean => {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

const versionParts = (match: RegExpExecArray): VersionParts | null => {
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return [major, minor, patch].every(Number.isSafeInteger) ? { major, minor, patch } : null;
};

export const parseUpstreamReleaseTag = (tag: string): UpstreamReleaseTag | null => {
  const stable = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (stable !== null) {
    const version = versionParts(stable);
    return version === null ? null : { tag, channel: "stable", ...version };
  }
  const nightly = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/.exec(tag);
  if (nightly === null || !validDate(nightly[4] ?? "")) return null;
  const version = versionParts(nightly);
  const runNumber = Number(nightly[5]);
  return version === null || !Number.isSafeInteger(runNumber) || runNumber < 1
    ? null
    : { tag, channel: "nightly", date: nightly[4] ?? "", runNumber, ...version };
};

export const parseStableForkTag = (tag: string): StableForkTag | null => {
  const match = /^v(\d+)\.(\d+)\.(\d+)-hyprws\.(\d+)$/.exec(tag);
  if (match === null) return null;
  const version = versionParts(match);
  const revision = Number(match[4]);
  return version === null || !Number.isSafeInteger(revision) || revision < 1
    ? null
    : { tag, revision, ...version };
};

export const parseNightlyForkTag = (tag: string): NightlyForkTag | null => {
  const match = /^v(\d+)\.(\d+)\.(\d+)-hyprws-nightly\.(\d{8})\.(\d+)$/.exec(tag);
  if (match === null || !validDate(match[4] ?? "")) return null;
  const version = versionParts(match);
  const runNumber = Number(match[5]);
  return version === null || !Number.isSafeInteger(runNumber) || runNumber < 1
    ? null
    : { tag, date: match[4] ?? "", runNumber, ...version };
};

export const isStableUpstreamTag = (tag: string): boolean =>
  parseUpstreamReleaseTag(tag)?.channel === "stable";

export const isNightlyUpstreamTag = (tag: string): boolean =>
  parseUpstreamReleaseTag(tag)?.channel === "nightly";

export const forkTargetVersion = (tag: string): string | null => {
  const parsed = parseUpstreamReleaseTag(tag);
  return parsed === null ? null : `v${parsed.major}.${parsed.minor}.${parsed.patch}-hyprws`;
};

export interface PositionedReleaseTag {
  readonly tag: string;
  readonly sha: string;
  readonly position: number;
  readonly stable: boolean;
}

export interface TagPolicyGit {
  run(args: ReadonlyArray<string>): string;
}

const lines = (value: string): ReadonlyArray<string> =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export const selectNewestReleaseTag = <T extends PositionedReleaseTag>(
  tags: ReadonlyArray<T>,
): T | null =>
  tags.toSorted((left, right) => {
    if (left.position !== right.position) return right.position - left.position;
    if (left.stable !== right.stable) return left.stable ? -1 : 1;
    return right.tag.localeCompare(left.tag, undefined, { numeric: true });
  })[0] ?? null;

export const positionUpstreamReleaseTags = (
  git: TagPolicyGit,
  firstParentShas: ReadonlyArray<string>,
): ReadonlyArray<PositionedReleaseTag> => {
  const positions = new Map(firstParentShas.map((sha, index) => [sha, index]));
  return lines(
    git.run([
      "for-each-ref",
      "--format=%(refname:strip=2)%09%(objectname)%09%(*objectname)",
      "refs/tags/v*",
    ]),
  ).flatMap((record) => {
    const [tag = "", objectSha = "", peeledSha = ""] = record.split("\t");
    const parsed = parseUpstreamReleaseTag(tag);
    const sha = peeledSha || objectSha;
    const position = positions.get(sha);
    return parsed === null || position === undefined
      ? []
      : [{ tag, sha, position, stable: parsed.channel === "stable" }];
  });
};
