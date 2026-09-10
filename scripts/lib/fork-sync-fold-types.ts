// @effect-diagnostics nodeBuiltinImport:off - Fold record model stands alone.

import * as NodeCrypto from "node:crypto";

/**
 * One append-only fold segment (RSI-Software/t3code-hyprws#920): the replay of a linear trunk
 * landing sequence `from..to` onto the verified candidate `onto`. `originalCount` and
 * `originalMessages` describe exactly the landings the segment replayed, taken from the walk that
 * oriented at the segment's `from`; they are immutable once the segment is sealed. The report JSON
 * is the source of truth for them — the rendered record carries only a digest, so parsing a record
 * never recovers the messages themselves.
 */
export interface FoldSegment {
  /** First landing the segment replays (inclusive), a full SHA on the trunk. */
  readonly from: string;
  /** Last landing the segment replays (inclusive), a full SHA on the trunk. */
  readonly to: string;
  /** The verified candidate head the segment replayed onto, a full SHA. */
  readonly onto: string;
  /** Head after the replay of `from..to`, before verification. */
  readonly replayedHead?: string;
  /** Head after the segment passed its final-tree verification. */
  readonly checkedHead?: string;
  /** How many trunk landings the segment replayed. */
  readonly originalCount: number;
  /** Exact normalized messages of the replayed landings, immutable report-side. */
  readonly originalMessages: string;
  /** Standalone repair commits appended with this segment, never autosquashed into earlier proofs. */
  readonly repairCommits?: ReadonlyArray<{ readonly sha: string; readonly subject: string }>;
}

/** The fold operation a stopped or resumed walk is mid-way through, persisted before Git mutation. */
export interface ActiveFold {
  /** Zero-based index into `folds`. */
  readonly index: number;
  readonly operation: "replay" | "check";
}

/** A pending or resolved leased push of a folded candidate, for interrupted-push recovery. */
export interface FoldPublication {
  readonly expectedOld: string;
  readonly head: string;
  readonly recordDigest: string;
  readonly outcome?: string;
}

const FULL_SHA = /^[0-9a-f]{40,64}$/;

const requireNonemptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
};

/** First 16 hex characters of the SHA-256 of a fold's original messages; the record-side identity. */
export const foldMessagesDigest = (messages: string): string =>
  NodeCrypto.createHash("sha256").update(messages).digest("hex").slice(0, 16);

const withOptionalSha = (
  value: unknown,
  name: string,
  field: string,
): { readonly [K in string]?: string } => {
  if (value === undefined) return {};
  const sha = requireNonemptyString(value, `${field} ${name}`);
  if (!FULL_SHA.test(sha)) throw new Error(`invalid ${field} ${name}`);
  return { [name]: sha };
};

/** Validate the durable fold-segment shape carried in report JSON. */
export const requireFoldSegment = (value: unknown, field = "fold segment"): FoldSegment => {
  if (typeof value !== "object" || value === null) throw new Error(`invalid ${field}`);
  const segment = value as Record<string, unknown>;
  const from = requireNonemptyString(segment.from, `${field} from`);
  const to = requireNonemptyString(segment.to, `${field} to`);
  const onto = requireNonemptyString(segment.onto, `${field} onto`);
  for (const [name, sha] of [
    ["from", from],
    ["to", to],
    ["onto", onto],
  ] as const)
    if (!FULL_SHA.test(sha)) throw new Error(`invalid ${field} ${name}`);
  if (
    !Number.isSafeInteger(segment.originalCount) ||
    (segment.originalCount as number) < 0 ||
    typeof segment.originalMessages !== "string" ||
    segment.originalMessages.length === 0
  )
    throw new Error(`invalid ${field} original census`);
  const repairCommits = segment.repairCommits;
  if (
    repairCommits !== undefined &&
    (!Array.isArray(repairCommits) ||
      repairCommits.some(
        (commit) =>
          typeof commit !== "object" ||
          commit === null ||
          !FULL_SHA.test((commit as Record<string, unknown>).sha as string) ||
          typeof (commit as Record<string, unknown>).subject !== "string",
      ))
  )
    throw new Error(`invalid ${field} repair commits`);
  return {
    from,
    to,
    onto,
    ...withOptionalSha(segment.replayedHead, "replayedHead", field),
    ...withOptionalSha(segment.checkedHead, "checkedHead", field),
    originalCount: segment.originalCount as number,
    originalMessages: segment.originalMessages,
    ...(repairCommits === undefined
      ? {}
      : {
          repairCommits: (
            repairCommits as Array<Readonly<{ readonly sha: string; readonly subject: string }>>
          ).map((commit) => ({
            sha: (commit as Record<string, unknown>).sha as string,
            subject: (commit as Record<string, unknown>).subject as string,
          })),
        }),
  };
};

/**
 * One fold row as the record renders it: everything a human needs, with `originalMessages`
 * reduced to a digest. Parsing never reconstructs the messages; `restoreFoldSegments` merges
 * these rows against report-side segments to keep `originalMessages` and `originalCount` intact.
 */
export interface FoldChainRow {
  readonly from: string;
  readonly to: string;
  readonly onto: string;
  readonly replayedHead?: string;
  readonly checkedHead?: string;
  readonly originalCount: number;
  readonly messagesDigest: string;
  readonly repairCommits: ReadonlyArray<{ readonly sha: string; readonly subject: string }>;
}

/** The header state a folded record carries: immutable source T, incorporated frontier B, final head. */
export interface FoldRecordHeader {
  readonly originalSource: string;
  readonly incorporatedSource: string;
  readonly baseCheckedHead?: string;
  readonly finalHead?: string;
}

const BACKTICKED_SHA = /^`(?:origin\/hyprws@)?([0-9a-f]{40,64})`$/;

const headerSha = (line: string | undefined, field: string): string => {
  const match = BACKTICKED_SHA.exec(line ?? "");
  if (match === null) throw new Error(`invalid fold header ${field}`);
  return match[1] ?? "";
};

const optionalHeaderSha = (line: string | undefined, field: string): string | undefined => {
  if (line === undefined || !line.startsWith(`- ${field}: `)) return undefined;
  return headerSha(line.slice(`- ${field}: `.length), field);
};

/** Parse the folded header state (original source, incorporated source, base checked head, final head). */
export const parseFoldRecordHeader = (record: string): FoldRecordHeader | undefined => {
  const header = record.split("## Header\n", 2)[1]?.split("\n## ", 1)[0] ?? "";
  const original = /^- Source: `origin\/hyprws@([0-9a-f]{40,64})`$/m.exec(header)?.[1];
  if (original === undefined) return undefined;
  const incorporatedLine = header
    .split("\n")
    .find((value) => value.startsWith("- Source incorporated: "));
  if (incorporatedLine === undefined) return undefined;
  const headerLines = header.split("\n");
  const baseCheckedHead = optionalHeaderSha(
    headerLines.find((value) => value.startsWith("- Base checked head: ")),
    "Base checked head",
  );
  const finalHead = optionalHeaderSha(
    headerLines.find((value) => value.startsWith("- Final head: ")),
    "Final head",
  );
  return {
    originalSource: original,
    incorporatedSource: headerSha(
      incorporatedLine.slice("- Source incorporated: ".length),
      "incorporated source",
    ),
    ...(baseCheckedHead === undefined ? {} : { baseCheckedHead }),
    ...(finalHead === undefined ? {} : { finalHead }),
  };
};

/** Render the fold header rows: original source T, incorporated frontier B, base and final heads. */
export const renderFoldHeader = (report: {
  readonly source?: { readonly sha: string; readonly expectedOld: string };
  readonly baseCheckedHead?: string;
  readonly rebasedHead?: string;
  readonly folds: ReadonlyArray<FoldSegment>;
}): ReadonlyArray<string> => {
  if (report.folds.length === 0) return [];
  return [
    `- Source: \`origin/hyprws@${report.source?.sha ?? "absent"}\``,
    `- Source incorporated: \`origin/hyprws@${report.source?.expectedOld ?? "absent"}\``,
    ...(report.baseCheckedHead === undefined
      ? []
      : [`- Base checked head: \`${report.baseCheckedHead}\``]),
    ...(report.rebasedHead === undefined ? [] : [`- Final head: \`${report.rebasedHead}\``]),
  ];
};

const escapeCell = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");

/** Same escaping contract as the record's shared table-cell splitter, kept local to avoid a cycle. */
const splitCells = (line: string): ReadonlyArray<string> | null => {
  if (!line.startsWith("|") || !line.endsWith("|")) return null;
  const cells: Array<string> = [];
  let cell = "";
  let backslashes = 0;
  for (const character of line.slice(1, -1)) {
    if (character === "|" && backslashes % 2 === 0) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
    backslashes = character === "\\" ? backslashes + 1 : 0;
  }
  cells.push(cell.trim());
  return cells;
};

const unescapeCell = (value: string): string => value.replaceAll(/\\([\\|])/g, "$1");

/** Render the `## Folds` provenance section from report-side segments. */
export const renderFoldSection = (folds: ReadonlyArray<FoldSegment>): string => {
  if (folds.length === 0) return "";
  const rows = folds.map((fold, index) => {
    const repairs = fold.repairCommits ?? [];
    return [
      `| ${index + 1} | \`${fold.from}\` | \`${fold.to}\` | \`${fold.onto}\` | ${fold.replayedHead === undefined ? "—" : `\`${fold.replayedHead}\``} | ${fold.checkedHead === undefined ? "—" : `\`${fold.checkedHead}\``} | ${fold.originalCount} | \`${foldMessagesDigest(fold.originalMessages)}\` | ${repairs.length === 0 ? "None." : repairs.map((commit) => `\`${commit.sha.slice(0, 12)}\` ${escapeCell(commit.subject)}`).join("; ")} |`,
    ].join("");
  });
  return [
    "## Folds",
    "",
    "Original source, incorporated frontier, and message digests come from the JSON report; this section is provenance, not a message store.",
    "",
    "| # | From | To | Onto | Replayed head | Checked head | Commits | Messages digest | Repair commits |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
};

/** Parse the `## Folds` section into chain rows, or undefined when the record carries none. */
export const parseFoldSection = (record: string): ReadonlyArray<FoldChainRow> | undefined => {
  const section = record.split("## Folds\n", 2)[1]?.split("\n## ", 1)[0] ?? "";
  if (section === "") return undefined;
  const rows: Array<FoldChainRow> = [];
  for (const line of section.split("\n")) {
    const cells = splitCells(line);
    if (cells === null) continue;
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    if (cells[0] === "#") continue;
    if (cells.length !== 9)
      throw new Error(`invalid fold row: expected 9 columns, found ${cells.length}`);
    const sha = (value: string | undefined, field: string): string => {
      const match = /^`([0-9a-f]{40,64})`$/.exec(value ?? "");
      if (match === null) throw new Error(`invalid fold ${field} cell`);
      return match[1] ?? "";
    };
    const digest = /^`([0-9a-f]{16})`$/.exec(cells[7] ?? "");
    if (digest === null) throw new Error("invalid fold messages digest cell");
    const repairs =
      cells[8] === "None."
        ? []
        : (cells[8] ?? "").split("; ").map((part) => {
            const match = /^`([0-9a-f]{12})` (.*)$/.exec(part);
            if (match === null) throw new Error("invalid fold repair commit cell");
            return { short: match[1] ?? "", subject: unescapeCell(match[2] ?? "") };
          });
    rows.push({
      from: sha(cells[1], "from"),
      to: sha(cells[2], "to"),
      onto: sha(cells[3], "onto"),
      ...(cells[4] === "—" ? {} : { replayedHead: sha(cells[4], "replayed head") }),
      ...(cells[5] === "—" ? {} : { checkedHead: sha(cells[5], "checked head") }),
      originalCount: Number(cells[6]),
      messagesDigest: digest[1] ?? "",
      repairCommits: repairs.map((repair) => ({ sha: repair.short, subject: repair.subject })),
    });
  }
  return rows;
};

/**
 * Merge parsed fold rows back onto report-side segments, the preserveRecordDecisions pattern: the
 * report keeps `originalMessages` and full repair-commit SHAs; the record only has to agree. Throws
 * when the chain the record shows no longer matches the report.
 */
export const restoreFoldSegments = (
  segments: ReadonlyArray<FoldSegment>,
  rows: ReadonlyArray<FoldChainRow>,
): ReadonlyArray<FoldSegment> => {
  if (segments.length !== rows.length) throw new Error("fold chain does not match the report");
  return segments.map((segment, index) => {
    const row = rows[index]!;
    const digest = foldMessagesDigest(segment.originalMessages);
    if (
      row.from !== segment.from ||
      row.to !== segment.to ||
      row.onto !== segment.onto ||
      row.originalCount !== segment.originalCount ||
      row.messagesDigest !== digest
    )
      throw new Error(`fold chain row ${index + 1} does not match the report`);
    return segment;
  });
};
