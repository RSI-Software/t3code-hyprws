export const FORK_DOMAINS = [
  "backend-attach",
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
  /**
   * The upstream tag whose walk appended this commit. Only the sync walk writes it, and it is the
   * marker that keeps a walk repair out of the replayed fork series the replay proofs compare.
   */
  readonly repair?: string;
  /**
   * The audit of a budget raise: the raising commit declares `raise <reason>` (RSI-Software/
   * t3code-hyprws#672). Lowering a ceiling is a normal commit and carries nothing.
   */
  readonly budget?: string;
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

/**
 * Squash messages routinely carry a trailer block more than once (18 of the last 400 trunk commits
 * repeat `Fork-Domain`, some five times). Repetition itself is benign — every observed duplicate
 * agrees on the value — so the parser only fails when the copies disagree: the proof checks can
 * never validate a copy they were never shown, so a stale first copy next to a corrected later one
 * would otherwise pass in silence (see 43e1a15ad3, where the whole block landed twice).
 */
class DuplicateForkTrailerError extends Error {}

/**
 * A repeated trailer whose copies disagree is a parse failure. One copy parses exactly as before;
 * several copies that all agree on the value return that value; several copies that disagree throw,
 * naming the key, the copy count, and every distinct value in message order so the stale clause is
 * visible to the author.
 */
const readTrailerValues = (body: string, key: string): Array<string | undefined> => {
  const values: Array<string | undefined> = [];
  for (const line of body.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== key.toLowerCase()) continue;
    values.push(normalizeTrailerValue(line.slice(separator + 1)));
  }
  return values;
};

const readTrailer = (body: string, key: string): string | undefined => {
  const values = readTrailerValues(body, key);
  if (values.length <= 1) return values[0];
  const distinct = [...new Set(values.map((value) => value ?? ""))];
  if (distinct.length > 1) {
    throw new DuplicateForkTrailerError(
      `duplicate ${key} trailer: ${values.length} copies disagree, distinct values in message ` +
        `order: ${distinct
          .map((value) => (value === "" ? "(empty)" : JSON.stringify(value)))
          .join(", ")}`,
    );
  }
  const only = distinct[0] ?? "";
  return only === "" ? undefined : only;
};

// A tolerant read for the one grandfathered commit below: among disagreeing copies, the later copy
// is the corrected clause, so it is the one kept.
const readLastTrailer = (body: string, key: string): string | undefined => {
  const values = readTrailerValues(body, key).filter((value) => value !== undefined);
  return values[values.length - 1];
};

/**
 * Exemption for exactly one trunk commit that cannot be amended. 8778853f80 carries `Fork-Budget`
 * twice and the copies disagree: line 107 ("the five walk-friction fixes ... 69149 ... 5489") is
 * the true clause and matches the landed ledger row; line 88 ("the four ... 68792 ... 5409") is
 * the stale leftover from an earlier revision of the same squash. The disagreement must not
 * silently pass for any other commit, so this is a one-sha exemption, never a rule.
 */
export const GRANDFATHERED_DUPLICATE_TRAILER_SHAS = new Set([
  "8778853f805664e3a1ccf6f6086753ca1695b446",
]);

export const parseForkTrailers = (
  body: string,
  options: { tolerateDuplicateTrailers?: boolean } = {},
): ForkTrailers => {
  const read = options.tolerateDuplicateTrailers === true ? readLastTrailer : readTrailer;
  const domain = read(body, "Fork-Domain");
  const tier = read(body, "Fork-Tier");
  const upstreamable = read(body, "Fork-Upstreamable");
  const wireReviewed = read(body, "Fork-Wire");
  const repair = read(body, "Fork-Repair");
  const budget = read(body, "Fork-Budget");
  return {
    ...(domain === undefined ? {} : { domain }),
    ...(tier === undefined ? {} : { tier }),
    ...(upstreamable === undefined ? {} : { upstreamable }),
    ...(wireReviewed === undefined ? {} : { wireReviewed }),
    ...(repair === undefined ? {} : { repair }),
    ...(budget === undefined ? {} : { budget }),
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
      if (GRANDFATHERED_DUPLICATE_TRAILER_SHAS.has(sha)) {
        return {
          sha,
          short,
          subject,
          ...parseForkTrailers(body, { tolerateDuplicateTrailers: true }),
        };
      }
      try {
        return { sha, short, subject, ...parseForkTrailers(body) };
      } catch (error) {
        if (error instanceof DuplicateForkTrailerError) {
          // Name the offending commit, following the shape describeReplayMessageDiff established:
          // an unattended failure must not require reading the whole series to find the culprit.
          throw new Error(`${short} ${subject}: ${error.message}`, { cause: error });
        }
        throw error;
      }
    });

export const isForkDomain = (value: string | undefined): value is ForkDomain =>
  value !== undefined && (FORK_DOMAINS as ReadonlyArray<string>).includes(value);

export const isForkUpstreamable = (value: string | undefined): value is "yes" | "no" =>
  value === "yes" || value === "no";

// A budget raise names its reason, exactly like a wire review does.
export const isForkBudgetRaise = (value: string | undefined): boolean =>
  value !== undefined && /^raise\s+\S/i.test(value);
