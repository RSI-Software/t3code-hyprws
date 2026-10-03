// @effect-diagnostics nodeBuiltinImport:off - Decision records render before an Effect runtime exists.

// One durable record per decision a walk makes (RSI-Software/t3code-hyprws#662):
// what was decided, how it was resolved, and who decided it. Conflict decisions
// are keyed by seam key, so the next walk can resolve the same seam from the
// record instead of asking again.

export type DecisionKind = "conflict" | "retire" | "stop";

export type DecisionDecider = "machine" | "rerere" | "human";

export interface WalkDecision {
  readonly kind: DecisionKind;
  /** A seam key for conflicts, the retire question's exact subject, or the stop's subject. */
  readonly subject: string;
  readonly path?: string;
  /** How the seam or question was resolved: ours, theirs, keep-both, manual, retired, kept, … */
  readonly outcome: string;
  readonly decidedBy: DecisionDecider;
  /** The walk target the decision belongs to. */
  readonly tag: string;
  readonly recordedAt: string;
  /** The earlier walk whose recorded decision a rerere replay resolved from. */
  readonly from?: string;
}

const KINDS: ReadonlyArray<DecisionKind> = ["conflict", "retire", "stop"];
const DECIDERS: ReadonlyArray<DecisionDecider> = ["machine", "rerere", "human"];
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** Validate one decision as the ledger stores it; unknown shapes are refused, not guessed. */
export const requireWalkDecision = (value: unknown, field: string): WalkDecision => {
  if (typeof value !== "object" || value === null) throw new Error(`invalid ${field}`);
  const row = value as Record<string, unknown>;
  if (typeof row.kind !== "string" || !KINDS.includes(row.kind as DecisionKind))
    throw new Error(`invalid ${field} kind`);
  if (typeof row.subject !== "string" || row.subject.length === 0)
    throw new Error(`invalid ${field} subject`);
  if (typeof row.outcome !== "string" || row.outcome.length === 0)
    throw new Error(`invalid ${field} outcome`);
  if (typeof row.decidedBy !== "string" || !DECIDERS.includes(row.decidedBy as DecisionDecider))
    throw new Error(`invalid ${field} decidedBy`);
  if (typeof row.tag !== "string" || row.tag.length === 0) throw new Error(`invalid ${field} tag`);
  if (typeof row.recordedAt !== "string" || !ISO_STAMP.test(row.recordedAt))
    throw new Error(`invalid ${field} recordedAt`);
  if (row.path !== undefined && (typeof row.path !== "string" || row.path.length === 0))
    throw new Error(`invalid ${field} path`);
  if (row.from !== undefined && (typeof row.from !== "string" || row.from.length === 0))
    throw new Error(`invalid ${field} from`);
  return {
    kind: row.kind as DecisionKind,
    subject: row.subject,
    outcome: row.outcome,
    decidedBy: row.decidedBy as DecisionDecider,
    tag: row.tag,
    recordedAt: row.recordedAt,
    ...(row.path === undefined ? {} : { path: row.path }),
    ...(row.from === undefined ? {} : { from: row.from }),
  };
};

export const requireWalkDecisions = (
  value: unknown,
  field: string,
): ReadonlyArray<WalkDecision> => {
  if (!Array.isArray(value)) throw new Error(`invalid ${field}`);
  return value.map((item, index) => requireWalkDecision(item, `${field}[${index}]`));
};

/**
 * Identity without the timestamp, so a resumed walk re-deriving the same decision replaces its
 * earlier copy instead of appending a second record for one decision.
 */
export const walkDecisionIdentity = (decision: WalkDecision): string =>
  JSON.stringify([
    decision.kind,
    decision.subject,
    decision.path ?? null,
    decision.outcome,
    decision.decidedBy,
    decision.tag,
    decision.from ?? null,
  ]);

/** Append one decision, replacing an earlier record of the same decision rather than duplicating. */
export const appendDecision = (
  decisions: ReadonlyArray<WalkDecision>,
  decision: WalkDecision,
): ReadonlyArray<WalkDecision> => {
  const identity = walkDecisionIdentity(decision);
  return [...decisions.filter((row) => walkDecisionIdentity(row) !== identity), decision];
};

const section = (record: string, heading: string): string =>
  record.split(`${heading}\n`, 2)[1]?.split("\n## ", 1)[0] ?? "";

const escapeCell = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");

const unescapeCell = (value: string): string => {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped !== "\\" && escaped !== "|") return result;
    result += escaped;
    index += 1;
  }
  return result;
};

/** One rendered decision row: `- \`subject\` (kind, outcome, decider, stamp, from) at \`path\``. */
export const decisionLine = (decision: WalkDecision): string =>
  [
    `- \`${escapeCell(decision.subject)}\``,
    `(${decision.kind}, ${decision.outcome}, ${decision.decidedBy}, ${decision.recordedAt}${
      decision.from === undefined ? "" : `, from ${decision.from}`
    })`,
    ...(decision.path === undefined ? [] : [`at \`${escapeCell(decision.path)}\``]),
  ].join(" ");

const DECISION_ROW =
  /^- `(.+)` \((\w+), ([^,]+), (machine|rerere|human), ([^,)]+)(?:, from ([^)]+))?\)(?: at `(.*)`)?$/;

/** Read the walk's decision records back from a rendered record; the walk tag comes from the header. */
export const parseDecisionRecords = (record: string): ReadonlyArray<WalkDecision> => {
  const tag = /^- Target: `([^@`]+)@/m.exec(record)?.[1] ?? "unknown";
  const rows: Array<WalkDecision> = [];
  for (const line of section(record, "## Decisions").split("\n")) {
    const match = DECISION_ROW.exec(line);
    if (match === null) continue;
    const kind = match[2] as DecisionKind;
    const stamp = (match[5] ?? "").trim();
    if (!KINDS.includes(kind) || !ISO_STAMP.test(stamp)) continue;
    rows.push({
      kind,
      subject: unescapeCell(match[1] ?? ""),
      outcome: (match[3] ?? "").trim(),
      decidedBy: (match[4] ?? "") as DecisionDecider,
      tag,
      recordedAt: stamp,
      ...((match[6] ?? "").trim().length === 0 ? {} : { from: (match[6] ?? "").trim() }),
      ...(match[7] === undefined ? {} : { path: unescapeCell(match[7]) }),
    });
  }
  return rows;
};
