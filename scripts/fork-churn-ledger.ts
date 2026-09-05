// The churn ledger: one entry per unblock walk, kept on the bot-owned `refs/fork/churn`
// so no fork commit carries it (RSI-Software/t3code-hyprws#476). This module owns the
// schema, its parser, and the ref round-trip; rendering lives beside its consumers.

import {
  CHURN_LEDGER_FILE,
  CHURN_REF,
  readBotRefFile,
  writeBotRefFile,
} from "./lib/fork-bot-refs.ts";
import type {
  ConflictClass,
  DecidedBy,
  NightlyReview,
  OrientationDecisionRow,
  SilentSeam,
} from "./fork-sync-state.ts";
import { isInheritedDecidedBy, requireNightlyReview } from "./fork-sync-state.ts";
import {
  parseSequentialCensusEvidence,
  requireSequentialCensusEvidence,
  type SequentialCensusEvidence,
} from "./lib/fork-rebase-issues.ts";
import {
  assessSeams,
  requireSeamRecords,
  freezeObservation,
  seamRecord,
  type SeamRecord,
  type SeamAssessment,
  type CensusFile,
  type CensusSnapshot,
} from "./lib/fork-churn-seams.ts";
import { requireOutcomeReceipts, type OutcomeReceipt } from "./lib/fork-sync-outcomes.ts";
export type { CensusFile, CensusSnapshot } from "./lib/fork-churn-seams.ts";

export const CONFLICT_CLASSES = [
  "generated",
  "mechanical",
  "seam-moved",
  "retire-candidate",
  "human",
] as const satisfies ReadonlyArray<ConflictClass>;
export const CLASS_RANK = new Map(CONFLICT_CLASSES.map((value, index) => [value, index]));

export interface ChurnConflict {
  readonly path: string;
  readonly commit: string;
  readonly subject: string;
  readonly domain: string;
  readonly class: ConflictClass;
  readonly resolution: string;
  readonly decidedBy: DecidedBy;
}

export interface CensusHotPath {
  readonly path: string;
  readonly consecutiveTags: number;
  readonly firstTag: string;
  readonly lastTag: string;
}

export interface RegressedSeam {
  readonly path: string;
  readonly commit: string;
  readonly subject: string;
  readonly domain: string;
  readonly tag: string;
  readonly fixedAt: string;
}

export interface CensusChurn {
  readonly hotPaths: ReadonlyArray<CensusHotPath>;
  readonly regressions: ReadonlyArray<RegressedSeam>;
  readonly seams: ReadonlyArray<SeamAssessment>;
}

export interface ChurnState {
  readonly version: 3;
  readonly walks: ReadonlyArray<ChurnEntry>;
  readonly seamRecords: ReadonlyArray<SeamRecord>;
  readonly outcomes: ReadonlyArray<OutcomeReceipt>;
}

export interface ChurnEntry {
  readonly tag: string;
  readonly before: string;
  readonly after: string;
  readonly recordUrl: string;
  readonly conflicts: ReadonlyArray<ChurnConflict>;
  readonly decisions: ReadonlyArray<OrientationDecisionRow>;
  readonly censusFiles: ReadonlyArray<CensusFile>;
  /** Missing means legacy pairwise feasibility overlap, not sequential stop rows. */
  readonly censusEvidence?: SequentialCensusEvidence;
  /** Seams the walk repaired without a conflict; absent on entries written before #476. */
  readonly silentSeams?: ReadonlyArray<SilentSeam>;
  /** Distinct proposer/reviewer provenance for a humanless nightly apply (#531). */
  readonly nightlyReview?: NightlyReview;
}

export interface ChurnHotSeam {
  readonly path: string;
  readonly walkCount: number;
  readonly worstClass: ConflictClass;
  readonly conflicts: ReadonlyArray<ChurnConflict>;
}

const splitTableCells = (line: string): ReadonlyArray<string> | null => {
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

const unescapeCell = (value: string): string => {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped !== "\\" && escaped !== "|") {
      throw new Error(
        `unsupported table escape ${escaped === undefined ? "at end of cell" : `\\${escaped}`}`,
      );
    }
    result += escaped;
    index += 1;
  }
  return result;
};

const section = (markdown: string, heading: string): string =>
  markdown.split(`${heading}\n`, 2)[1]?.split("\n## ", 1)[0] ?? "";

export const parseCensusFiles = (body: string): ReadonlyArray<CensusFile> => {
  const evidence = parseSequentialCensusEvidence(body);
  if (evidence !== null)
    return evidence.rows.map((row) => ({
      path: row.path,
      hunks: null,
      commit: row.commit,
      subject: row.subject,
      domain: row.domain ?? "?",
    }));
  const rows: Array<CensusFile> = [];
  const overlap =
    section(body, "## Feasibility overlap") || section(body, "## Sequential rebase census");
  for (const line of overlap.split("\n")) {
    const cells = splitTableCells(line);
    if (cells === null || cells[0] === "File") continue;
    if (cells.every((cell) => /^-+:?$/.test(cell))) continue;
    if (cells.length !== 4) {
      throw new Error(`invalid census row: expected 4 columns, found ${cells.length}`);
    }
    const path = /^`([^`]*)`$/.exec(cells[0] ?? "");
    if (path === null) throw new Error("invalid census File cell: expected a backticked path");
    const hunks = Number(cells[1]);
    if (!Number.isSafeInteger(hunks) || hunks < 0)
      throw new Error(`invalid census Hunks cell: ${cells[1] ?? ""}`);
    const commit = /^`([0-9a-f]{7,12}) (.+)`$/.exec(cells[2] ?? "");
    if (commit === null) throw new Error("invalid census Fork commit cell: expected `sha subject`");
    rows.push({
      path: unescapeCell(path[1] ?? ""),
      hunks,
      commit: commit[1] ?? "",
      subject: unescapeCell(commit[2] ?? ""),
      domain: cells[3] ?? "",
    });
  }
  if (rows.length === 0) throw new Error("sequential rebase census has no file rows");
  return rows;
};

/** Read the target tag named by the generated sequential rebase census. */
export const parseCensusTag = (body: string): string => {
  const evidence = parseSequentialCensusEvidence(body);
  if (evidence !== null) return evidence.targetTag;
  const tag =
    /A throwaway rebase rehearsal to `([^`]+)` found /.exec(
      section(body, "## Sequential rebase census"),
    )?.[1] ?? /Newest upstream tag beyond the clean window: `([^`]+)`/.exec(body)?.[1];
  if (tag === undefined) throw new Error("sequential rebase census has no target tag");
  return tag;
};

export const parseSilentSeams = (record: string): ReadonlyArray<SilentSeam> =>
  [...section(record, "## Silent seams").matchAll(/^- `(.+?)` \[(behaviour|type)\]: (.*)$/gm)].map(
    (match) => ({
      path: unescapeCell(match[1] ?? ""),
      summary: unescapeCell(match[3] ?? ""),
      touchesBehaviour: match[2] === "behaviour",
    }),
  );

const isConflictClass = (value: unknown): value is ConflictClass =>
  typeof value === "string" && (CONFLICT_CLASSES as ReadonlyArray<string>).includes(value);

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
};

/** A ledger row written before provenance was recorded carries none, and none is not a human. */
const requireDecidedBy = (value: unknown, field: string): DecidedBy => {
  if (value === undefined || value === "TODO") return "TODO";
  if (value === "human" || value === "agent") return value;
  if (typeof value === "string" && isInheritedDecidedBy(value)) return value as DecidedBy;
  throw new Error(`invalid ${field}`);
};

/**
 * Human verdicts for retire-candidate subjects that a walk recorded, keyed on the stable
 * commit subject plus domain. Carries forward from `refs/fork/churn`; prefer that
 * bot-owned surface over a new store (`refs/fork/churn` precedent). A verdict is
 * re-asked only when the target-tree evidence for that subject changes.
 */
export const humanVerdictsBySubject = (
  entries: ReadonlyArray<ChurnEntry>,
): ReadonlyMap<
  string,
  {
    readonly subject: string;
    readonly domain: string;
    readonly verdict: string;
    readonly sourceTag: string;
  }
> => {
  const bySubject = new Map<
    string,
    {
      readonly subject: string;
      readonly domain: string;
      readonly verdict: string;
      readonly sourceTag: string;
    }
  >();
  for (const entry of entries) {
    for (const row of entry.decisions) {
      if (row.decidedBy !== "human") continue;
      // Inherited cells are a render form, not a provenance to propagate.
      if (isInheritedDecidedBy(String(row.decidedBy))) continue;
      if (!["keep", "retire", "partial"].includes(row.verdict)) continue;
      // Last writer wins so the most recent walk's human answer is the carry.
      bySubject.set(row.subject, {
        subject: row.subject,
        domain: row.domain,
        verdict: row.verdict,
        sourceTag: entry.tag,
      });
    }
  }
  return bySubject;
};

const parseWalks = (value: unknown): ReadonlyArray<ChurnEntry> => {
  if (!Array.isArray(value)) throw new Error("fork churn ledger must be an array");
  const entries = value.map((item, entryIndex) => {
    if (typeof item !== "object" || item === null) throw new Error(`invalid entry ${entryIndex}`);
    const entry = item as Record<string, unknown>;
    if (
      !Array.isArray(entry.conflicts) ||
      !Array.isArray(entry.decisions) ||
      !Array.isArray(entry.censusFiles)
    )
      throw new Error(`invalid collections in entry ${entryIndex}`);
    const conflicts = entry.conflicts.map((item, conflictIndex) => {
      if (typeof item !== "object" || item === null)
        throw new Error(`invalid conflict ${conflictIndex} in entry ${entryIndex}`);
      const row = item as Record<string, unknown>;
      if (!isConflictClass(row.class))
        throw new Error(`invalid conflict class in entry ${entryIndex}`);
      return {
        path: requireString(row.path, "conflict path"),
        commit: requireString(row.commit, "conflict commit"),
        subject: requireString(row.subject, "conflict subject"),
        domain: requireString(row.domain, "conflict domain"),
        class: row.class,
        resolution: requireString(row.resolution, "conflict resolution"),
        decidedBy: requireDecidedBy(row.decidedBy, `conflict decidedBy in entry ${entryIndex}`),
      };
    });
    const decisions = entry.decisions.map((item, decisionIndex) => {
      if (typeof item !== "object" || item === null)
        throw new Error(`invalid decision ${decisionIndex} in entry ${entryIndex}`);
      const row = item as Record<string, unknown>;
      const verdict = row.verdict;
      if (!["keep", "retire", "partial"].includes(String(verdict)))
        throw new Error(`invalid decision verdict in entry ${entryIndex}`);
      return {
        subject: requireString(row.subject, "decision subject"),
        domain: requireString(row.domain, "decision domain"),
        verdict: verdict as OrientationDecisionRow["verdict"],
        decidedBy: requireDecidedBy(row.decidedBy, `decision decidedBy in entry ${entryIndex}`),
      };
    });
    const censusFiles = entry.censusFiles.map((item, censusIndex) => {
      if (typeof item !== "object" || item === null)
        throw new Error(`invalid census file ${censusIndex} in entry ${entryIndex}`);
      const row = item as Record<string, unknown>;
      if (row.hunks !== null && (!Number.isSafeInteger(row.hunks) || Number(row.hunks) < 0))
        throw new Error(`invalid census hunks in entry ${entryIndex}`);
      return {
        path: requireString(row.path, "census path"),
        hunks: row.hunks === null ? null : Number(row.hunks),
        commit: requireString(row.commit, "census commit"),
        ...(row.subject === undefined
          ? {}
          : { subject: requireString(row.subject, "census subject") }),
        domain: requireString(row.domain, "census domain"),
      };
    });
    const silentSeams =
      entry.silentSeams === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(entry.silentSeams))
              throw new Error(`invalid silentSeams in entry ${entryIndex}`);
            return entry.silentSeams.map((item) => {
              const row = (item ?? {}) as Record<string, unknown>;
              if (typeof row.touchesBehaviour !== "boolean")
                throw new Error(`invalid silent seam touchesBehaviour in entry ${entryIndex}`);
              return {
                path: requireString(row.path, "silent seam path"),
                summary: requireString(row.summary, "silent seam summary"),
                touchesBehaviour: row.touchesBehaviour,
              };
            });
          })();
    const nightlyReview =
      entry.nightlyReview === undefined
        ? undefined
        : requireNightlyReview(entry.nightlyReview, `nightlyReview in entry ${entryIndex}`);
    return {
      tag: requireString(entry.tag, "tag"),
      before: requireString(entry.before, "before"),
      after: requireString(entry.after, "after"),
      recordUrl: requireString(entry.recordUrl, "recordUrl"),
      conflicts,
      decisions,
      censusFiles,
      ...(entry.censusEvidence === undefined
        ? {}
        : {
            censusEvidence: requireSequentialCensusEvidence(entry.censusEvidence),
          }),
      ...(silentSeams === undefined ? {} : { silentSeams }),
      ...(nightlyReview === undefined ? {} : { nightlyReview }),
    } satisfies ChurnEntry;
  });
  const tags = new Set<string>();
  for (const entry of entries) {
    if (tags.has(entry.tag)) throw new Error(`duplicate tag: ${entry.tag}`);
    tags.add(entry.tag);
  }
  return entries;
};

export const parseChurnState = (raw: string): ChurnState => {
  const value: unknown = JSON.parse(raw);
  if (Array.isArray(value))
    return { version: 3, walks: parseWalks(value), seamRecords: [], outcomes: [] };
  if (typeof value !== "object" || value === null) throw new Error("invalid churn ledger envelope");
  const state = value as Record<string, unknown>;
  if (
    (state.version !== 2 && state.version !== 3) ||
    Object.keys(state).some(
      (key) =>
        !["version", "walks", "seamRecords", ...(state.version === 3 ? ["outcomes"] : [])].includes(
          key,
        ),
    )
  )
    throw new Error("unsupported churn ledger envelope");
  return {
    version: 3,
    walks: parseWalks(state.walks),
    seamRecords: requireSeamRecords(state.seamRecords),
    outcomes: state.version === 2 ? [] : requireOutcomeReceipts(state.outcomes),
  };
};

/** Compatibility projection for consumers of walk decisions. */
export const parseLedger = (raw: string): ReadonlyArray<ChurnEntry> => parseChurnState(raw).walks;

export const serializeLedger = (entries: ReadonlyArray<ChurnEntry>): string =>
  `${JSON.stringify(entries, null, 2)}\n`;

/**
 * Upgrade legacy census rows to the stable logical commit identity used by churn.
 * Parsing keeps `subject` optional for the existing ledger shape, but every sanctioned
 * write calls this first so one successful write removes the old Git-object dependency.
 */
export const enrichCensusSubjects = (
  entries: ReadonlyArray<ChurnEntry>,
  subjectOf: (commit: string) => string,
): ReadonlyArray<ChurnEntry> => {
  const subjects = new Map<string, string>();
  for (const entry of entries) {
    for (const file of entry.censusFiles) {
      if (file.subject !== undefined) subjects.set(file.commit, file.subject);
    }
  }

  const unresolved: Array<string> = [];
  const missing = new Set(
    entries.flatMap((entry) =>
      entry.censusFiles.flatMap((file) =>
        file.subject === undefined && !subjects.has(file.commit) ? [file.commit] : [],
      ),
    ),
  );
  for (const commit of missing) {
    try {
      const subject = subjectOf(commit);
      if (subject.length === 0) unresolved.push(commit);
      else subjects.set(commit, subject);
    } catch {
      unresolved.push(commit);
    }
  }
  if (unresolved.length > 0)
    throw new Error(`unresolved census commits: ${unresolved.toSorted().join(", ")}`);

  return entries.map((entry) => {
    let changed = false;
    const censusFiles = entry.censusFiles.map((file) => {
      if (file.subject !== undefined) return file;
      changed = true;
      return { ...file, subject: subjects.get(file.commit)! };
    });
    return changed ? { ...entry, censusFiles } : entry;
  });
};

/**
 * The ledger as the bot-owned ref holds it. A missing ref is not an empty ledger:
 * it means the ref was never seeded, and every caller needs to say so rather than
 * silently report zero walks.
 */
export const readChurnState = (root: string, ref = CHURN_REF): ChurnState => {
  const raw = readBotRefFile(root, ref, CHURN_LEDGER_FILE);
  if (raw === null)
    throw new Error(
      `${ref} does not carry ${CHURN_LEDGER_FILE}; seed it once (docs/operations/fork-sync.md#churn-ledger)`,
    );
  return parseChurnState(raw);
};

export const readChurnLedger = (root: string, ref = CHURN_REF): ReadonlyArray<ChurnEntry> =>
  readChurnState(root, ref).walks;

export const writeChurnState = (
  root: string,
  state: ChurnState,
  message: string,
  ref = CHURN_REF,
): string => {
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  parseChurnState(serialized);
  return writeBotRefFile(root, ref, CHURN_LEDGER_FILE, serialized, message);
};

export const writeChurnLedger = (
  root: string,
  entries: ReadonlyArray<ChurnEntry>,
  message: string,
  ref = CHURN_REF,
): string => {
  const existing = readBotRefFile(root, ref, CHURN_LEDGER_FILE);
  const state =
    existing === null
      ? { version: 3 as const, walks: [], seamRecords: [], outcomes: [] }
      : parseChurnState(existing);
  return writeChurnState(root, { ...state, walks: entries }, message, ref);
};

const conflictRowsByPath = (
  entries: ReadonlyArray<ChurnEntry>,
): ReadonlyMap<string, ReadonlyArray<{ readonly tag: string; readonly row: ChurnConflict }>> => {
  const paths = new Map<string, Array<{ readonly tag: string; readonly row: ChurnConflict }>>();
  for (const entry of entries) {
    for (const row of entry.conflicts) {
      const values = paths.get(row.path) ?? [];
      values.push({ tag: entry.tag, row });
      paths.set(row.path, values);
    }
  }
  return paths;
};

export { conflictRowsByPath };

const censusSnapshots = (
  entries: ReadonlyArray<ChurnEntry>,
  current: CensusSnapshot | null,
): ReadonlyArray<CensusSnapshot> => {
  const snapshots = entries.map((entry) => ({
    tag: entry.tag,
    fixedAt: entry.after,
    files: entry.censusFiles,
    ...(entry.censusEvidence === undefined ? {} : { censusEvidence: entry.censusEvidence }),
  }));
  if (current === null) return snapshots;
  if (
    snapshots.at(-1) !== undefined &&
    seamRecord(freezeObservation(snapshots.at(-1)!)).id ===
      seamRecord(freezeObservation(current)).id
  )
    return snapshots;
  return [...snapshots, current];
};

/**
 * Join the generated census sequence to the durable walk ledger.
 *
 * Consecutive paths describe observations only. Named repairs and comparable verification
 * belong to the seam records; absence never supplies a fix commit.
 */
export const censusChurn = (
  entries: ReadonlyArray<ChurnEntry>,
  current: CensusSnapshot | null = null,
  records: ReadonlyArray<SeamRecord> = [],
): CensusChurn => {
  const snapshots = censusSnapshots(entries, current);
  const pathRuns = new Map<
    string,
    { readonly count: number; readonly firstTag: string; readonly lastTag: string }
  >();
  const seams = assessSeams(snapshots, records);
  const regressions = seams
    .filter((seam) => seam.status === "regressed" && seam.repairSha !== null)
    .map((seam) => ({
      path: seam.path,
      commit: seam.commit,
      subject: seam.subject,
      domain: seam.domain,
      tag: seam.tag,
      fixedAt: seam.repairSha!,
    }));
  let previousMethod: string | null = null;

  for (const snapshot of snapshots) {
    const method = snapshot.censusEvidence?.method ?? "legacy-pairwise-feasibility";
    // A method change or partial observation says nothing about a seam disappearing.
    if (method !== previousMethod || snapshot.censusEvidence?.complete === false) {
      pathRuns.clear();
    }
    previousMethod = method;
    if (snapshot.censusEvidence?.complete === false) continue;
    const paths = new Set(snapshot.files.map((file) => file.path));
    for (const path of paths) {
      const previous = pathRuns.get(path);
      pathRuns.set(path, {
        count: (previous?.count ?? 0) + (previous?.lastTag === snapshot.tag ? 0 : 1),
        firstTag: previous?.firstTag ?? snapshot.tag,
        lastTag: snapshot.tag,
      });
    }
    for (const path of pathRuns.keys()) {
      if (!paths.has(path)) pathRuns.delete(path);
    }
  }

  return {
    hotPaths: [...pathRuns]
      .flatMap(([path, run]) =>
        run.count < 2
          ? []
          : [
              {
                path,
                consecutiveTags: run.count,
                firstTag: run.firstTag,
                lastTag: run.lastTag,
              },
            ],
      )
      .toSorted(
        (left, right) =>
          right.consecutiveTags - left.consecutiveTags || left.path.localeCompare(right.path),
      ),
    regressions,
    seams,
  };
};

export const hotSeams = (entries: ReadonlyArray<ChurnEntry>): ReadonlyArray<ChurnHotSeam> =>
  [...conflictRowsByPath(entries)]
    .map(([path, values]) => {
      const conflicts = values.map(({ row }) => row);
      return {
        path,
        walkCount: new Set(values.map(({ tag }) => tag)).size,
        worstClass: conflicts.reduce<ConflictClass>(
          (worst, row) => (CLASS_RANK.get(row.class)! > CLASS_RANK.get(worst)! ? row.class : worst),
          "generated",
        ),
        conflicts,
      };
    })
    .filter(
      (seam) =>
        seam.walkCount >= 2 ||
        seam.conflicts.some((row) => row.class === "human" || row.class === "retire-candidate"),
    )
    .toSorted(
      (left, right) =>
        right.walkCount - left.walkCount ||
        CLASS_RANK.get(right.worstClass)! - CLASS_RANK.get(left.worstClass)! ||
        left.path.localeCompare(right.path),
    );
