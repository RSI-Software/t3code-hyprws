// The `## Churn` section the sync report posts on the walk's 🔔 issue. Pure rendering:
// every input is the ledger the bot keeps on `refs/fork/churn`, and the previous
// section's own state marker supplies the hot-seam deltas.

import type { CensusChurn, CensusSnapshot, ChurnEntry, ChurnHotSeam } from "./fork-churn-ledger.ts";
import { censusChurn, CONFLICT_CLASSES, hotSeams } from "./fork-churn-ledger.ts";
import type { SeamRecord } from "./lib/fork-churn-seams.ts";

export const CHURN_MARKER = "<!-- hyprws-fork-churn -->";
const STATE_MARKER = /<!-- hyprws-fork-churn-state:(.*) -->/;

export interface ChurnSectionState {
  readonly walks: number;
  readonly seams: ReadonlyArray<{
    readonly path: string;
    readonly walkCount: number;
    readonly worstClass: string;
  }>;
}

const code = (value: string): string => {
  let delimiter = "`";
  while (value.includes(delimiter)) delimiter += "`";
  return `${delimiter}${value}${delimiter}`;
};
const escapeCell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");
const percentage = (part: number, total: number): string =>
  total === 0 ? "0.0%" : `${((part / total) * 100).toFixed(1)}%`;

/** Read the machine-readable state the previous section left behind, if any. */
export const parseChurnSectionState = (body: string): ChurnSectionState | null => {
  const raw = STATE_MARKER.exec(body)?.[1];
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as Partial<ChurnSectionState>;
    if (!Array.isArray(value.seams) || typeof value.walks !== "number") return null;
    return { walks: value.walks, seams: value.seams };
  } catch {
    return null;
  }
};

const stateOf = (entries: ReadonlyArray<ChurnEntry>): ChurnSectionState => ({
  walks: entries.length,
  seams: hotSeams(entries).map(({ path, walkCount, worstClass }) => ({
    path,
    walkCount,
    worstClass,
  })),
});

const seamDelta = (seam: ChurnHotSeam, previous: ChurnSectionState | null): string => {
  if (previous === null) return "—";
  const before = previous.seams.find((row) => row.path === seam.path);
  if (before === undefined) return "new";
  const parts: Array<string> = [];
  if (seam.walkCount !== before.walkCount)
    parts.push(
      `${seam.walkCount > before.walkCount ? "+" : ""}${seam.walkCount - before.walkCount} walk`,
    );
  if (seam.worstClass !== before.worstClass)
    parts.push(`${before.worstClass} → ${seam.worstClass}`);
  return parts.length === 0 ? "unchanged" : parts.join(", ");
};

const classMix = (entries: ReadonlyArray<ChurnEntry>): ReadonlyArray<string> => {
  const rows = entries.flatMap((entry) => entry.conflicts);
  if (rows.length === 0) return ["No conflict rows recorded yet."];
  return [
    "<!-- prettier-ignore -->",
    "| Class | Conflicts | Share |",
    "| --- | ---: | ---: |",
    ...CONFLICT_CLASSES.flatMap((klass) => {
      const count = rows.filter((row) => row.class === klass).length;
      return count === 0 ? [] : [`| ${klass} | ${count} | ${percentage(count, rows.length)} |`];
    }),
  ];
};

/**
 * `TODO` is the absence of provenance, not a third decider, so it is counted on its own
 * row and credited to neither side.
 */
const decidedBy = (entries: ReadonlyArray<ChurnEntry>): ReadonlyArray<string> => {
  const conflicts = entries.flatMap((entry) => entry.conflicts);
  const decisions = entries.flatMap((entry) => entry.decisions);
  return [
    "<!-- prettier-ignore -->",
    "| Decided by | Conflict rows | Fork-commit decisions |",
    "| --- | ---: | ---: |",
    ...(["agent", "human", "TODO"] as const).map(
      (who) =>
        `| ${who === "TODO" ? "TODO (no provenance)" : who} | ${conflicts.filter((row) => row.decidedBy === who).length} | ${decisions.filter((row) => row.decidedBy === who).length} |`,
    ),
  ];
};

const nightlyReviews = (entries: ReadonlyArray<ChurnEntry>): ReadonlyArray<string> => {
  const rows = entries.flatMap((entry) =>
    entry.nightlyReview === undefined ? [] : [{ tag: entry.tag, review: entry.nightlyReview }],
  );
  if (rows.length === 0) return ["None."];
  return [
    "<!-- prettier-ignore -->",
    "| Tag | Proposer | Independent reviewer | Verdict |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      ({ tag, review }) =>
        `| ${code(tag)} | agent ${code(`${review.proposer.iface}/${review.proposer.provider}/${review.proposer.model}`)} session ${code(review.proposer.session)} | agent ${code(`${review.reviewer.iface}/${review.reviewer.provider}/${review.reviewer.model}`)} session ${code(review.reviewer.session)} | ${review.status} |`,
    ),
  ];
};

const censusChurnTable = (churn: CensusChurn): ReadonlyArray<string> => {
  if (churn.hotPaths.length === 0) return ["None."];
  return [
    "Paths still present in consecutive generated censuses:",
    "",
    "<!-- prettier-ignore -->",
    "| Path | Consecutive tags | Range |",
    "| --- | ---: | --- |",
    ...churn.hotPaths.map(
      (path) =>
        `| ${escapeCell(code(path.path))} | ${path.consecutiveTags} | ${code(path.firstTag)} → ${code(path.lastTag)} |`,
    ),
  ];
};

export const regressedSeamLines = (churn: CensusChurn): ReadonlyArray<string> =>
  churn.regressions.map(
    (seam) =>
      `regressed seam: ${code(seam.path)} / ${code(seam.subject)} (${seam.domain}) was fixed at ${code(seam.fixedAt)} and reappeared on ${code(seam.tag)} as ${code(seam.commit)}`,
  );

export const blockingSeamLines = (churn: CensusChurn): ReadonlyArray<string> =>
  churn.seams
    .filter((seam) => seam.blocking)
    .map(
      (seam) =>
        `${seam.status}: ${code(seam.path)} / ${code(seam.subject)} (${seam.domain}): ${seam.reason}`,
    );

const seamTable = (churn: CensusChurn): ReadonlyArray<string> =>
  churn.seams.length === 0
    ? ["No observed seams."]
    : [
        "Absence leaves a seam unresolved. Guard results are maintainer attestations; recording them does not run a check.",
        "",
        "| Seam | State | Blocking | Guard / reason |",
        "| --- | --- | --- | --- |",
        ...churn.seams.map(
          (seam) =>
            `| ${escapeCell(code(seam.id.slice(0, 12)))} ${escapeCell(code(seam.path))} / ${escapeCell(code(seam.subject))} | ${seam.status} | ${seam.blocking ? "yes" : "no"} | ${escapeCell(seam.guard ?? seam.reason)} |`,
        ),
      ];

const regressionTable = (churn: CensusChurn): ReadonlyArray<string> => {
  const lines = regressedSeamLines(churn);
  return lines.length === 0 ? ["None."] : lines.map((line) => `- ${line}`);
};

const silentSeams = (entries: ReadonlyArray<ChurnEntry>): ReadonlyArray<string> => {
  const rows = entries.flatMap((entry) =>
    (entry.silentSeams ?? []).map((seam) => ({ tag: entry.tag, seam })),
  );
  if (rows.length === 0) return ["None."];
  return rows.map(
    ({ tag, seam }) =>
      `- ${code(seam.path)} [${seam.touchesBehaviour ? "behaviour" : "type"}] on ${code(tag)}: ${seam.summary}`,
  );
};

const hotSeamTable = (
  entries: ReadonlyArray<ChurnEntry>,
  previous: ChurnSectionState | null,
): ReadonlyArray<string> => {
  const seams = hotSeams(entries);
  const dropped =
    previous === null
      ? []
      : previous.seams
          .filter((row) => !seams.some((seam) => seam.path === row.path))
          .map((row) => row.path);
  if (seams.length === 0) return ["None."];
  return [
    "<!-- prettier-ignore -->",
    "| Path | Walks | Worst class | Since last report |",
    "| --- | ---: | --- | --- |",
    ...seams.map(
      (seam) =>
        `| ${escapeCell(code(seam.path))} | ${seam.walkCount} | ${seam.worstClass} | ${escapeCell(seamDelta(seam, previous))} |`,
    ),
    ...(dropped.length === 0
      ? []
      : ["", `Dropped since the last report: ${dropped.map(code).join(", ")}.`]),
  ];
};

/**
 * Render the churn section. `previousBody` is the previous section comment, which
 * carries the state the deltas are measured against.
 */
export const renderChurnSection = (
  entries: ReadonlyArray<ChurnEntry>,
  previousBody: string | null = null,
  currentCensus: CensusSnapshot | null = null,
  records: ReadonlyArray<SeamRecord> = [],
): string => {
  const previous = previousBody === null ? null : parseChurnSectionState(previousBody);
  const census = censusChurn(entries, currentCensus, records);
  const range =
    entries.length === 0
      ? "no walks yet"
      : `${entries.length} walk${entries.length === 1 ? "" : "s"} through ${code(entries.at(-1)?.tag ?? "")}`;
  return [
    CHURN_MARKER,
    "## Churn",
    "",
    `Ledger: ${code("refs/fork/churn")} (${code("fork-churn.json")}), ${range}. No fork commit carries it.`,
    "",
    "### Conflict class mix",
    "",
    ...classMix(entries),
    "",
    "### Decided by",
    "",
    ...decidedBy(entries),
    "",
    "### Nightly independent review",
    "",
    ...nightlyReviews(entries),
    "",
    "### Census churn",
    "",
    "Measurement: rows without census provenance are legacy pairwise feasibility overlap. Sequential provisional replay uses its own evidence; method changes and partial observations break comparison continuity.",
    "",
    ...censusChurnTable(census),
    "",
    "### Seam state",
    "",
    ...seamTable(census),
    "",
    "### Regressed seams",
    "",
    ...regressionTable(census),
    "",
    "### Silent seams",
    "",
    ...silentSeams(entries),
    "",
    "### Resolved-conflict hot seams",
    "",
    ...hotSeamTable(entries, previous),
    "",
    `<!-- hyprws-fork-churn-state:${JSON.stringify(stateOf(entries))} -->`,
  ].join("\n");
};
