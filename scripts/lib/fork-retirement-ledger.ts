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

const splitTableRow = (line: string): ReadonlyArray<string> => {
  const cells: Array<string> = [];
  let cell = "";
  let escaped = false;
  for (const character of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
};

const sectionLines = (markdown: string, heading: string): ReadonlyArray<string> => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`fork retirement ledger is missing ## ${heading}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end);
};

const parseTable = (
  markdown: string,
  heading: string,
  expectedHeader: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const lines = sectionLines(markdown, heading);
  const headerIndex = lines.findIndex((line) => line.trim().startsWith("|"));
  if (headerIndex === -1) throw new Error(`## ${heading} has no ledger table`);
  const header = splitTableRow(lines[headerIndex] ?? "");
  if (header.join("\0") !== expectedHeader.join("\0")) {
    throw new Error(`## ${heading} has an unexpected ledger header`);
  }
  const divider = splitTableRow(lines[headerIndex + 1] ?? "");
  if (divider.length !== header.length || divider.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
    throw new Error(`## ${heading} has an invalid ledger divider`);
  }
  return lines
    .slice(headerIndex + 2)
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => splitTableRow(line));
};

const keyedRows = <T extends { readonly subject: string }>(
  heading: string,
  rows: ReadonlyArray<T>,
): ReadonlyMap<string, T> => {
  const entries = new Map<string, T>();
  for (const row of rows) {
    if (row.subject.length === 0) throw new Error(`## ${heading} contains an empty fork subject`);
    if (entries.has(row.subject)) {
      throw new Error(`## ${heading} contains duplicate fork subject: ${row.subject}`);
    }
    entries.set(row.subject, row);
  }
  return entries;
};

export const parseForkRetirementLedger = (markdown: string): ForkRetirementLedger => {
  const retired = parseTable(markdown, "Retired", [
    "Fork commit",
    "Domain",
    "Upstream replacement",
    "Retired at",
  ]).map(([subject = "", domain = "", upstreamReplacement = "", retiredAt = ""]) => ({
    subject,
    domain,
    upstreamReplacement,
    retiredAt,
  }));
  const kept = parseTable(markdown, "Kept", ["Fork commit", "Domain", "Reason", "Reviewed at"]).map(
    ([subject = "", domain = "", reason = "", reviewedAt = ""]) => ({
      subject,
      domain,
      reason,
      reviewedAt,
    }),
  );
  return {
    retired: keyedRows("Retired", retired),
    kept: keyedRows("Kept", kept),
  };
};

export const retirementDecision = (
  ledger: ForkRetirementLedger,
  subject: string,
): RecordedRetirementDecision => {
  const retired = ledger.retired.get(subject);
  const kept = ledger.kept.get(subject);
  if (retired !== undefined && kept !== undefined) {
    return { decision: "partial", ...(kept.reason.length === 0 ? {} : { reason: kept.reason }) };
  }
  if (retired !== undefined) return { decision: "retire" };
  if (kept !== undefined) {
    return { decision: "keep", ...(kept.reason.length === 0 ? {} : { reason: kept.reason }) };
  }
  return { decision: "none" };
};
