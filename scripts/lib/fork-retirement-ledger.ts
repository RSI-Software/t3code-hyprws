// @effect-diagnostics nodeBuiltinImport:off - Standalone fork gates read this required file before Effect.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const FORK_RETIREMENT_LEDGER_PATH = "scripts/fork-retirement-ledger.json";

export type RetirementDecision = "retire" | "keep" | "partial" | "none";

export interface RetiredCommit {
  readonly subject: string;
  readonly domain: string;
  readonly upstreamReplacement: string;
  readonly retiredAt: string;
}

export interface KeptCommit {
  readonly subject: string;
  readonly domain: string;
  readonly reason: string;
  readonly reviewedAt: string;
}

export interface ForkRetirementLedger {
  readonly retired: ReadonlyMap<string, RetiredCommit>;
  readonly kept: ReadonlyMap<string, KeptCommit>;
}

export interface RecordedRetirementDecision {
  readonly decision: RetirementDecision;
  readonly reason?: string;
}

export const EMPTY_RETIREMENT_LEDGER: ForkRetirementLedger = {
  retired: new Map(),
  kept: new Map(),
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const rowsOf = (ledger: Record<string, unknown>, field: string): ReadonlyArray<unknown> => {
  const rows = ledger[field];
  if (!Array.isArray(rows)) {
    throw new Error(`${FORK_RETIREMENT_LEDGER_PATH} is missing the ${field} array`);
  }
  return rows;
};

/**
 * Rows are keyed by subject, so a duplicate would silently shadow a decision rather than record a
 * second one. Both duplicate and empty subjects are refused rather than dropped.
 */
const keyedRows = <T extends { readonly subject: string }>(
  field: string,
  rows: ReadonlyArray<T>,
): ReadonlyMap<string, T> => {
  const entries = new Map<string, T>();
  for (const row of rows) {
    if (row.subject.length === 0) {
      throw new Error(`${FORK_RETIREMENT_LEDGER_PATH} ${field} contains an empty fork subject`);
    }
    const key = normalizeSubjectKey(row.subject);
    if (entries.has(key)) {
      throw new Error(
        `${FORK_RETIREMENT_LEDGER_PATH} ${field} contains duplicate fork subject: ${row.subject}`,
      );
    }
    entries.set(key, row);
  }
  return entries;
};

export const parseForkRetirementLedger = (source: string): ForkRetirementLedger => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`${FORK_RETIREMENT_LEDGER_PATH} is not valid JSON`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${FORK_RETIREMENT_LEDGER_PATH} is not a ledger object`);
  }
  const ledger = parsed as Record<string, unknown>;
  const retired = rowsOf(ledger, "retired").map((row): RetiredCommit => {
    const cells = (row ?? {}) as Record<string, unknown>;
    return {
      subject: text(cells["subject"]),
      domain: text(cells["domain"]),
      upstreamReplacement: text(cells["upstreamReplacement"]),
      retiredAt: text(cells["retiredAt"]),
    };
  });
  const kept = rowsOf(ledger, "kept").map((row): KeptCommit => {
    const cells = (row ?? {}) as Record<string, unknown>;
    return {
      subject: text(cells["subject"]),
      domain: text(cells["domain"]),
      reason: text(cells["reason"]),
      reviewedAt: text(cells["reviewedAt"]),
    };
  });
  return {
    retired: keyedRows("retired", retired),
    kept: keyedRows("kept", kept),
  };
};

export const readForkRetirementLedger = (root: string): ForkRetirementLedger =>
  parseForkRetirementLedger(
    NodeFS.readFileSync(NodePath.join(root, FORK_RETIREMENT_LEDGER_PATH), "utf8"),
  );

/**
 * A subject is keyed by its bare text: one pair of surrounding backticks is
 * stripped, so a row the ledger writes as a code span resolves to the same
 * commit subject a bare row does. Inner or unpaired backticks are left alone —
 * they are part of the subject, not its wrapping.
 */
export const normalizeSubjectKey = (subject: string): string => {
  const match = /^`([^`]+)`$/.exec(subject.trim());
  return match?.[1] ?? subject;
};

export const retirementDecision = (
  ledger: ForkRetirementLedger,
  subject: string,
): RecordedRetirementDecision => {
  const key = normalizeSubjectKey(subject);
  const retired = ledger.retired.get(key);
  const kept = ledger.kept.get(key);
  if (retired !== undefined && kept !== undefined) {
    return { decision: "partial", ...(kept.reason.length === 0 ? {} : { reason: kept.reason }) };
  }
  if (retired !== undefined) return { decision: "retire" };
  if (kept !== undefined) {
    return { decision: "keep", ...(kept.reason.length === 0 ? {} : { reason: kept.reason }) };
  }
  return { decision: "none" };
};
