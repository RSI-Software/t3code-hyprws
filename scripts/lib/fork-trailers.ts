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
}

export interface ParsedForkCommit extends ForkTrailers {
  readonly sha: string;
  readonly short: string;
  /**
   * Strict-ISO author date (`%aI`), read straight off the commit's `author` header. A rewrite
   * (`scripts/lib/fork-rewrite-build.ts` `rebuildCommit`) only ever replaces the `tree` and
   * `parent` headers and copies `author`/`committer`/message verbatim, so this survives a fold
   * unchanged even though `sha` does not. See `GRANDFATHERED_WALK_REPAIR_KEYS` in fork-delta.ts.
   */
  readonly authorDate: string;
  readonly subject: string;
}

export const FORK_LOG_RECORD_SEPARATOR = "\u001e";
export const FORK_LOG_FIELD_SEPARATOR = "\u001f";

export const forkLogArguments = (base: string, head: string) =>
  [
    "log",
    "--reverse",
    `--format=%H${FORK_LOG_FIELD_SEPARATOR}%h${FORK_LOG_FIELD_SEPARATOR}%aI${FORK_LOG_FIELD_SEPARATOR}%s${FORK_LOG_FIELD_SEPARATOR}%b${FORK_LOG_RECORD_SEPARATOR}`,
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
 * The commit's trailer block, read from the body's final paragraph only.
 *
 * A "tail material" line is one of — each entry is here because a real trunk commit has that
 * shape at the end of its message, in or after the trailer block:
 *
 * - blank line (message padding);
 * - a whole-line HTML comment (the landing tool's `<!-- gh-bot:attest ... -->` / stack marker);
 * - `Co-authored-by:` (GitHub UI squashes append the co-author after the real trailer block);
 * - `(cherry picked from commit <sha>)` (git appends it after the block on cherry-pick -x;
 *   see c324f9bab0, where it sits inside the block directly after the co-author line);
 * - a `---`-or-more separator (see 8778853f80);
 * - a `Closes|Fixes|Resolves|Refs ... #<n>` reference line (see 47852a62a9).
 *
 * Trailing paragraphs made up entirely of tail material are dropped; the last remaining paragraph
 * is the trailer block iff every line is `Key: value` or tail material and at least one line is
 * `Key: value` (tail noise inside the block is tolerated but never parsed). Prose paragraphs are
 * never walked across, so a prose sentence above the block that mentions `Fork-Tier:` (see
 * 1c2f9d5628) stays out; a body whose final paragraph is not trailer-shaped has no trailers.
 */
const TAIL_LINE = [
  /^\s*$/,
  /^<!--[\s\S]*-->$/,
  /^Co-authored-by:\s*\S/i,
  /^\(cherry picked from commit [0-9a-f]{7,40}\)$/,
  /^-{3,}$/,
  /^(?:Closes|Fixes|Resolves|Refs)\b[^:]*#\d+\s*$/i,
] as const;

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s*\S/;

const isTailLine = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) ||
    TAIL_LINE.some((pattern) => pattern.test(trimmed))
  );
};

export const trailerBlock = (body: string): string => {
  const paragraphs: Array<Array<string>> = [[]];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().length === 0 && (paragraphs.at(-1)?.length ?? 0) > 0) {
      paragraphs.push([]);
      continue;
    }
    if (line.trim().length === 0) continue;
    paragraphs.at(-1)?.push(line);
  }
  while (paragraphs.length > 0 && (paragraphs.at(-1) ?? []).every(isTailLine)) {
    paragraphs.pop();
  }
  const paragraph = paragraphs.at(-1) ?? [];
  if (!paragraph.some((line) => TRAILER_LINE.test(line))) return "";
  if (!paragraph.every((line) => TRAILER_LINE.test(line) || isTailLine(line))) return "";
  return paragraph.filter((line) => TRAILER_LINE.test(line)).join("\n");
};

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

export const parseForkTrailers = (body: string): ForkTrailers => {
  const block = trailerBlock(body);
  const read = (key: string) => readTrailer(block, key);
  const domain = read("Fork-Domain");
  const tier = read("Fork-Tier");
  const upstreamable = read("Fork-Upstreamable");
  const wireReviewed = read("Fork-Wire");
  const repair = read("Fork-Repair");
  return {
    ...(domain === undefined ? {} : { domain }),
    ...(tier === undefined ? {} : { tier }),
    ...(upstreamable === undefined ? {} : { upstreamable }),
    ...(wireReviewed === undefined ? {} : { wireReviewed }),
    ...(repair === undefined ? {} : { repair }),
  };
};

export const parseForkLog = (raw: string): ReadonlyArray<ParsedForkCommit> =>
  raw
    .split(FORK_LOG_RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = "", short = "", authorDate = "", subject = "", body = ""] =
        record.split(FORK_LOG_FIELD_SEPARATOR);
      try {
        return { sha, short, authorDate, subject, ...parseForkTrailers(body) };
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
