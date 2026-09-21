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
