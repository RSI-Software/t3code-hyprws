export const FORK_DOMAINS = [
  "browser-bookmarks",
  "custom-agents",
  "distribution",
  "fork-meta",
  "github-issues",
  "markdown-editing",
  "project-windows",
  "thread-ordering",
  "upstream-fixes",
  "workspace-files",
  "worktrunk-hooks",
  "zmux-estate",
] as const;

export type ForkDomain = (typeof FORK_DOMAINS)[number];

export const normalizeTrailerValue = (value: string): string | undefined =>
  value
    .trim()
    .replace(/^\s+|\s+$/g, "")
    .replace(/^\n+|\n+$/g, "") || undefined;

export interface ForkTrailers {
  readonly domain?: string;
  readonly tier?: string;
  readonly upstreamable?: string;
  readonly wireReviewed?: string;
}

export interface ParsedForkCommit extends ForkTrailers {
  readonly sha: string;
  readonly short: string;
  readonly subject: string;
}

export const FORK_LOG_RECORD_SEPARATOR = "\u001e";
export const FORK_LOG_FIELD_SEPARATOR = "\u001f";

export const forkLogArguments = (base: string, head: string) =>
  [
    "log",
    "--reverse",
    `--format=%H${FORK_LOG_FIELD_SEPARATOR}%h${FORK_LOG_FIELD_SEPARATOR}%s${FORK_LOG_FIELD_SEPARATOR}%b${FORK_LOG_RECORD_SEPARATOR}`,
    `${base}..${head}`,
  ] as const;

const readTrailer = (body: string, key: string): string | undefined => {
  for (const line of body.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== key.toLowerCase()) continue;
    return normalizeTrailerValue(line.slice(separator + 1));
  }
  return undefined;
};

export const parseForkTrailers = (body: string): ForkTrailers => {
  const domain = readTrailer(body, "Fork-Domain");
  const tier = readTrailer(body, "Fork-Tier");
  const upstreamable = readTrailer(body, "Fork-Upstreamable");
  const wireReviewed = readTrailer(body, "Fork-Wire");
  return {
    ...(domain === undefined ? {} : { domain }),
    ...(tier === undefined ? {} : { tier }),
    ...(upstreamable === undefined ? {} : { upstreamable }),
    ...(wireReviewed === undefined ? {} : { wireReviewed }),
  };
};

export const parseForkLog = (raw: string): ReadonlyArray<ParsedForkCommit> =>
  raw
    .split(FORK_LOG_RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = "", short = "", subject = "", body = ""] =
        record.split(FORK_LOG_FIELD_SEPARATOR);
      return { sha, short, subject, ...parseForkTrailers(body) };
    });

export const isForkDomain = (value: string | undefined): value is ForkDomain =>
  value !== undefined && (FORK_DOMAINS as ReadonlyArray<string>).includes(value);

export const isForkUpstreamable = (value: string | undefined): value is "yes" | "no" =>
  value === "yes" || value === "no";
