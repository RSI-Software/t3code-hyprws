// The per-domain stack budget: a checked-in table of ceilings that
// `fork:delta --check` enforces against the live `--inventory` numbers.
// Ceilings ratchet down only — lowering one is a normal commit, and raising one
// requires the raising commit to carry `Fork-Budget: raise <reason>`. Kept
// Effect-free so every fork gate can read it.

import { FORK_DOMAINS } from "./fork-trailers.ts";

export const FORK_BUDGET_PATH = "docs/internals/fork-budget.md";

export const FORK_BUDGET_HEADER = ["Domain", "Commits", "Added", "Deleted", "Shared"] as const;

/** The measures the check gates on; commit counts are recorded, never gated. */
export type ForkBudgetMeasure = "added" | "deleted" | "shared";

export interface ForkBudgetRow {
  readonly domain: string;
  readonly commits: number;
  readonly added: number;
  readonly deleted: number;
  readonly shared: number;
}

export interface ForkBudget {
  readonly rows: ReadonlyMap<string, ForkBudgetRow>;
  /** Rows whose domain is not a `FORK_DOMAINS` member; they enforce nothing. */
  readonly unknownDomains: ReadonlyArray<string>;
}

/** One measured number over its ceiling, worded to name the domain and both values. */
export interface ForkBudgetFinding {
  readonly domain: string;
  readonly measure: ForkBudgetMeasure;
  readonly actual: number;
  readonly ceiling: number;
  readonly baselined: boolean;
}

export const forkBudgetFindingMessage = (finding: ForkBudgetFinding): string =>
  `${finding.domain}: ${finding.measure} ${finding.actual} > ${finding.ceiling} ceiling${
    finding.baselined ? "" : " (domain has no budget row)"
  }`;

/**
 * The actionable refusal for one finding: the finding itself plus the overage
 * and the exact raise route. Never silent — a kept-both resolution that
 * legitimately grows a domain follows this route in the same operation rather
 * than hand-editing a trailer after the gate refuses.
 */
export const forkBudgetRefusalMessage = (finding: ForkBudgetFinding): string =>
  `${forkBudgetFindingMessage(finding)} (over by ${finding.actual - finding.ceiling}) — to raise it: edit ${FORK_BUDGET_PATH} to set the ${finding.domain} ${finding.measure} ceiling to at least ${finding.actual}, and carry Fork-Budget: raise <reason> on that commit`;

/** One ceiling number a commit pushed up; the raising commit owes its trailer. */
export interface ForkBudgetRaise {
  readonly domain: string;
  readonly measure: ForkBudgetMeasure;
  readonly from: number;
  readonly to: number;
}

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

const budgetCell = (value: string, domain: string, column: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`fork budget row "${domain}" has a non-integer ${column} cell: ${value}`);
  }
  return parsed;
};

export const parseForkBudget = (markdown: string): ForkBudget => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headerIndex = lines.findIndex((line) => line.trim().startsWith("|"));
  if (headerIndex === -1) throw new Error("fork budget table is missing");
  const header = splitTableRow(lines[headerIndex] ?? "");
  if (header.join("\0") !== FORK_BUDGET_HEADER.join("\0")) {
    throw new Error("fork budget table has an unexpected header");
  }
  const divider = splitTableRow(lines[headerIndex + 1] ?? "");
  if (
    divider.length !== FORK_BUDGET_HEADER.length ||
    divider.some((cell) => !/^:?-{3,}:?$/.test(cell))
  ) {
    throw new Error("fork budget table has an invalid divider");
  }
  const rows = new Map<string, ForkBudgetRow>();
  const unknownDomains: Array<string> = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = splitTableRow(line);
    if (cells.length !== FORK_BUDGET_HEADER.length) {
      throw new Error(
        `fork budget row has ${cells.length} cells, expected ${FORK_BUDGET_HEADER.length}`,
      );
    }
    const domain = cells[0] ?? "";
    if (domain.length === 0) throw new Error("fork budget row has an empty domain");
    if (rows.has(domain)) throw new Error(`fork budget table has duplicate domain: ${domain}`);
    rows.set(domain, {
      domain,
      commits: budgetCell(cells[1] ?? "", domain, "Commits"),
      added: budgetCell(cells[2] ?? "", domain, "Added"),
      deleted: budgetCell(cells[3] ?? "", domain, "Deleted"),
      shared: budgetCell(cells[4] ?? "", domain, "Shared"),
    });
    if (!(FORK_DOMAINS as ReadonlyArray<string>).includes(domain)) unknownDomains.push(domain);
  }
  return { rows, unknownDomains };
};

const gatedMeasures = (
  row: ForkBudgetRow,
): ReadonlyArray<{
  readonly measure: ForkBudgetMeasure;
  readonly actual: number;
}> => [
  { measure: "added", actual: row.added },
  { measure: "deleted", actual: row.deleted },
];

/**
 * Compares the live per-domain inventory numbers against the ceilings. Commit
 * counts and shared-file attributions ride in the table but gate nothing: a
 * commit count is not a cost, and shared attribution moves with every upstream
 * tag even when the fork does not. A domain without a row fails closed at
 * ceiling zero on every measure it scores above.
 */
export const budgetFindings = (
  domains: ReadonlyArray<{
    readonly domain: string;
    readonly commits: number;
    readonly added: number;
    readonly deleted: number;
    readonly overlaps: number;
  }>,
  budget: ForkBudget,
): ReadonlyArray<ForkBudgetFinding> =>
  domains.flatMap((row) => {
    const ceiling = budget.rows.get(row.domain);
    return gatedMeasures({
      domain: row.domain,
      commits: row.commits,
      added: row.added,
      deleted: row.deleted,
      shared: row.overlaps,
    })
      .filter((measure) => measure.actual > (ceiling?.[measure.measure] ?? 0))
      .map((measure) => ({
        domain: row.domain,
        measure: measure.measure,
        actual: measure.actual,
        ceiling: ceiling?.[measure.measure] ?? 0,
        baselined: ceiling !== undefined,
      }));
  });

/**
 * The ceiling numbers one commit pushed up, comparing the file it wrote against
 * the file it replaced. Only gated measures count: recording a larger commit
 * count or a different shared attribution is not a budget increase. A missing
 * previous version is the initial seed — there is no prior baseline to raise
 * from, so it is not a raise either.
 */
export const budgetRaises = (
  previous: string | undefined,
  current: string,
): ReadonlyArray<ForkBudgetRaise> => {
  if (previous === undefined) return [];
  const before = parseForkBudget(previous);
  const after = parseForkBudget(current);
  const raises: Array<ForkBudgetRaise> = [];
  for (const row of after.rows.values()) {
    const was = before.rows.get(row.domain);
    for (const { measure, actual } of gatedMeasures(row)) {
      const from = was?.[measure] ?? 0;
      if (actual > from) raises.push({ domain: row.domain, measure, from, to: actual });
    }
  }
  return raises;
};

const escapeCell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");

/**
 * Renders the whole budget file from the live inventory. The audit trail of a
 * raise is the raising commit's own `Fork-Budget: raise <reason>` trailer, not
 * anything stamped into this table; the initial seed carries no trailer.
 */
export const renderForkBudget = (input: {
  readonly rows: ReadonlyArray<{
    readonly domain: string;
    readonly commits: number;
    readonly added: number;
    readonly deleted: number;
    readonly overlaps: number;
  }>;
}): string =>
  [
    "# Fork budget",
    "",
    "Per-domain ceilings for the fork stack, measured by `vp run fork:delta --inventory`.",
    "`vp run fork:delta --check` fails when a domain's added or deleted lines exceed its ceiling.",
    "Commit counts and shared-file attributions are recorded, not gated: a commit count is not a",
    "cost, and shared attribution moves with every upstream tag even when the fork does not.",
    "Ceilings ratchet down only: lowering one is a normal commit, and raising one requires the",
    "raising commit to carry `Fork-Budget: raise <reason>`. The initial seed carries no trailer —",
    "there is no prior baseline to raise from. A domain without a row has every ceiling at zero,",
    "so a new domain fails the check until a commit adds its row.",
    "",
    "| Domain | Commits | Added | Deleted | Shared |",
    "| --- | --- | --- | --- | --- |",
    ...input.rows.map(
      (row) =>
        `| ${escapeCell(row.domain)} | ${row.commits} | ${row.added} | ${row.deleted} | ${row.overlaps} |`,
    ),
    "",
  ].join("\n");

/** The live per-domain numbers a raise seeds a brand-new row from. */
export interface ForkBudgetMeasured {
  readonly domain: string;
  readonly commits: number;
  readonly added: number;
  readonly deleted: number;
  readonly overlaps: number;
}

const ADDED_CELL = 2;
const DELETED_CELL = 3;

/**
 * Raises exactly the ceilings the given findings name, to the numbers those findings measured, and
 * leaves every other cell and every line outside the table untouched. A raise is never a
 * re-render: rendering the whole file from the live inventory would also ratchet untouched domains
 * down to today's numbers, spending headroom the fork still owns without anyone deciding to. A
 * finding for a domain with no row appends one — a missing row is a ceiling of zero, not an absent
 * domain — seeded from the live numbers for the recorded-only cells.
 */
export const raiseForkBudget = (
  markdown: string,
  findings: ReadonlyArray<ForkBudgetFinding>,
  measured: ReadonlyArray<ForkBudgetMeasured>,
): string => {
  parseForkBudget(markdown);
  const wanted = new Map<string, Map<ForkBudgetMeasure, number>>();
  for (const finding of findings) {
    const byMeasure = wanted.get(finding.domain) ?? new Map<ForkBudgetMeasure, number>();
    byMeasure.set(finding.measure, finding.actual);
    wanted.set(finding.domain, byMeasure);
  }
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headerIndex = lines.findIndex((line) => line.trim().startsWith("|"));
  const raised = new Set<string>();
  let lastRow = headerIndex + 1;
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim().startsWith("|")) continue;
    lastRow = index;
    const cells = [...splitTableRow(line)];
    const domain = cells[0] ?? "";
    const byMeasure = wanted.get(domain);
    if (byMeasure === undefined) continue;
    const added = byMeasure.get("added");
    const deleted = byMeasure.get("deleted");
    if (added !== undefined) cells[ADDED_CELL] = String(added);
    if (deleted !== undefined) cells[DELETED_CELL] = String(deleted);
    lines[index] = `| ${cells.map(escapeCell).join(" | ")} |`;
    raised.add(domain);
  }
  const appended = [...wanted.keys()]
    .filter((domain) => !raised.has(domain))
    .map((domain) => {
      const row = measured.find((candidate) => candidate.domain === domain);
      const byMeasure = wanted.get(domain);
      return `| ${escapeCell(domain)} | ${row?.commits ?? 0} | ${byMeasure?.get("added") ?? row?.added ?? 0} | ${byMeasure?.get("deleted") ?? row?.deleted ?? 0} | ${row?.overlaps ?? 0} |`;
    });
  return [...lines.slice(0, lastRow + 1), ...appended, ...lines.slice(lastRow + 1)].join("\n");
};
