// @effect-diagnostics nodeBuiltinImport:off - Sync records are standalone operator state.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { UsageError } from "./lib/fork-cli.ts";
import {
  requireCommandSuccess,
  type CwdCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";
import { FORK_REPOSITORY } from "./lib/fork-policy.ts";

export const REPOSITORY = FORK_REPOSITORY;
export const BLOCK_LABEL = "rebase-blocked";
const FULL_SHA = /^[0-9a-f]{40,64}$/;
export const COMMENT_CONFIG = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.commentChar",
  GIT_CONFIG_VALUE_0: "auto",
} as const;

export type SyncStage = "listed" | "oriented" | "conflicts" | "replayed" | "checked" | "applied";
export type SyncKind = "unblock" | "rewrite";

export interface RewriteProof {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
  readonly detail?: string;
}

export interface RewriteBinding {
  readonly from: string;
  readonly fromSha: string;
  readonly fromShort: string;
  readonly originSha: string;
  readonly originShort: string;
  readonly base: string;
  readonly baseToOriginCount: number;
  readonly baseToFromCount: number;
  readonly allowExtra: number;
  readonly allowPaths: ReadonlyArray<string>;
  readonly originDigest: string;
  readonly fromFirstNDigest: string;
  readonly diffEmpty: boolean;
  readonly proofs: ReadonlyArray<RewriteProof>;
}
export type ConflictClass =
  | "generated"
  | "mechanical"
  | "seam-moved"
  | "retire-candidate"
  | "human";

export interface ConflictRow {
  readonly commit: string;
  readonly subject: string;
  readonly domain: string;
  readonly path: string;
  readonly class: ConflictClass | "TODO";
  readonly resolution: string;
  readonly agentSafe: string;
  readonly decidedBy: "human" | "agent";
}

export type OrientationVerdict = "candidate" | "keep" | "retire" | "partial";
export type BotMode = "off" | "candidate" | "on";

export interface BotRun {
  readonly status: string;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly url: string;
}

export interface BotSnapshot {
  readonly mode: BotMode;
  readonly lastRun: BotRun | null;
  readonly nextFire: string;
}

export interface OrientationDecisionRow {
  readonly subject: string;
  readonly domain: string;
  readonly verdict: OrientationVerdict;
  readonly decidedBy: "human" | "agent";
  readonly action?: "keep (mechanical seam)";
}

export interface SilentSeam {
  readonly path: string;
  readonly summary: string;
  readonly touchesBehaviour: boolean;
}

export interface SyncReport {
  readonly schemaVersion: 1;
  readonly stage: SyncStage;
  readonly kind?: SyncKind;
  readonly repositoryRoot: string;
  readonly reportPath: string;
  readonly recordPath: string;
  readonly issue: { readonly number: number; readonly blockingSha: string; readonly title: string };
  readonly candidates: ReadonlyArray<{ readonly tag: string; readonly sha: string }>;
  readonly bot?: BotSnapshot;
  readonly target?: { readonly tag: string; readonly sha: string };
  readonly source?: {
    readonly sha: string;
    readonly sharedBase: string;
    readonly expectedOld: string;
  };
  readonly rewrite?: RewriteBinding;
  readonly lane?: { readonly branch: string; readonly worktree: string };
  readonly originalMessages?: string;
  readonly originalCount?: number;
  readonly conflicts: ReadonlyArray<ConflictRow>;
  readonly orientation?: string;
  readonly orientationDecisions?: ReadonlyArray<OrientationDecisionRow>;
  readonly touchedPaths?: ReadonlyArray<string>;
  readonly silentSeams?: ReadonlyArray<SilentSeam>;
  readonly behaviourSeamStopPresented?: boolean;
  readonly verification: ReadonlyArray<{ readonly command: string; readonly result: string }>;
  readonly rebasedHead?: string;
  readonly stackSize?: number;
  readonly installedHead?: string;
  readonly ciHead?: string;
  readonly recordCommentUrl?: string;
  readonly reconciliation?: {
    readonly state: "dispatched" | "ambiguous";
    readonly runUrl?: string;
    readonly baselineRunId?: number;
  };
}

export const SYNC_HELP = `Usage: vp run fork:sync <verb> [options]

Unblock verbs:
  unblock-auto [--target <tag@sha>] [--report <external-json>] [--resume]
  unblock-list [--output <external-json>]
  unblock-orient --report <json> --target <release-tag>
  unblock-rehearse --report <json>
  unblock-check --report <json> [--silent-seam <path>=<summary>:behaviour|type]
  unblock-apply --report <json> --record <markdown>
  rewrite-rehearse --from <branch-or-sha> [--issue N] [--allow-extra N] [--allow-paths <glob,...>] [--dry-run]

Stable verbs:
  stable-list [--output <external-json>]
  stable-prepare --report <json> --issue <human-selected-issue>
  stable-publish --report <json> --go <exact-candidate>
`;

export const commandText = (command: string, args: ReadonlyArray<string>): string =>
  [command, ...args]
    .map((value) => (/^[\w./:@#=-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(" ");

export const requireSuccess = (
  runner: CommandRunner,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  input?: string,
  env?: NodeJS.ProcessEnv,
): string => {
  const result = runner.run(command, args, cwd, input, env);
  return requireCommandSuccess(result, command, args);
};

export const gitRaw = (
  runner: CommandRunner,
  cwd: string,
  args: ReadonlyArray<string>,
  rehearsal = false,
): string =>
  requireSuccess(
    runner,
    "git",
    rehearsal ? ["-c", "core.commentChar=auto", ...args] : args,
    cwd,
    undefined,
    rehearsal ? { ...process.env, ...COMMENT_CONFIG } : undefined,
  );

export const git = (
  runner: CommandRunner,
  cwd: string,
  args: ReadonlyArray<string>,
  rehearsal = false,
): string => gitRaw(runner, cwd, args, rehearsal).trim();

export const rootFor = (runner: CommandRunner, cwd: string): string =>
  git(runner, cwd, ["rev-parse", "--show-toplevel"]);

export const worktreePath = (raw: string): string => {
  const value = JSON.parse(raw) as Record<string, unknown>;
  for (const key of ["worktree_path", "worktreePath", "path"])
    if (typeof value[key] === "string") return value[key] as string;
  throw new Error("Worktrunk JSON omitted the worktree path");
};
export const lines = (value: string): ReadonlyArray<string> =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
export const extractBlockingSha = (body: string): string | null =>
  /<!-- blocking-sha:([0-9a-f]{40,64}) -->/.exec(body)?.[1] ?? null;

export const parseVerbArgs = (
  argv: ReadonlyArray<string>,
): { verb: string; values: ReadonlyMap<string, string> } => {
  const verb = argv[0];
  if (verb === undefined) throw new UsageError("expected an unblock verb");
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; ) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new UsageError(`invalid arguments after ${verb}`);
    }
    if (values.has(flag)) throw new UsageError(`duplicate option: ${flag}`);
    if (flag === "--resume" || flag === "--dry-run") {
      values.set(flag, "true");
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`invalid arguments after ${verb}`);
    }
    values.set(flag, value);
    index += 2;
  }
  return { verb, values };
};

export const oneValue = (
  values: ReadonlyMap<string, string>,
  flag: string,
  required = true,
): string | null => {
  const value = values.get(flag) ?? null;
  if (required && value === null) throw new UsageError(`${flag} is required`);
  return value;
};

export const assertOnly = (
  values: ReadonlyMap<string, string>,
  allowed: ReadonlyArray<string>,
): void => {
  for (const flag of values.keys())
    if (!allowed.includes(flag)) throw new UsageError(`unknown option: ${flag}`);
};

export const externalPath = (root: string, path: string): string => {
  const resolved = NodePath.resolve(path);
  const relative = NodePath.relative(NodeFS.realpathSync(root), NodePath.dirname(resolved));
  if (relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== "..")) {
    throw new Error(`report must be outside the repository: ${resolved}`);
  }
  return resolved;
};

export const validateReport = (value: unknown): SyncReport => {
  if (typeof value !== "object" || value === null) throw new Error("report is not an object");
  const report = value as Partial<SyncReport>;
  if (report.schemaVersion !== 1 || typeof report.stage !== "string")
    throw new Error("unsupported report schema");
  if (report.kind !== undefined && report.kind !== "unblock" && report.kind !== "rewrite")
    throw new Error("unsupported report kind");
  if (
    typeof report.repositoryRoot !== "string" ||
    typeof report.reportPath !== "string" ||
    typeof report.recordPath !== "string"
  )
    throw new Error("report paths are missing");
  if (typeof report.issue?.number !== "number" || !FULL_SHA.test(report.issue.blockingSha ?? ""))
    throw new Error("report issue binding is invalid");
  if (
    !Array.isArray(report.candidates) ||
    !Array.isArray(report.conflicts) ||
    !Array.isArray(report.verification)
  )
    throw new Error("report collections are invalid");
  return report as SyncReport;
};

export const readReport = (path: string): SyncReport => {
  const report = validateReport(JSON.parse(NodeFS.readFileSync(path, "utf8")));
  if (NodePath.resolve(path) !== NodePath.resolve(report.reportPath))
    throw new Error("report path does not match its binding");
  return report;
};

export const writeReport = (report: SyncReport): void => {
  const temporary = `${report.reportPath}.tmp-${process.pid}`;
  NodeFS.mkdirSync(NodePath.dirname(report.reportPath), { recursive: true });
  NodeFS.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, report.reportPath);
  NodeFS.chmodSync(report.reportPath, 0o600);
};

const escapeCell = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");

/** The Grounding claim a rendered decision row carries until a human writes one. */
export const NO_GROUNDING_CLAIM = "n/a — no product grounding claim";

const renderRewriteProofs = (rewrite: RewriteBinding): ReadonlyArray<string> => {
  const lines: Array<string> = ["## Rewrite proofs", ""];
  lines.push("| Proof | Expected | Actual | Pass |", "| --- | --- | --- | --- |");
  for (const p of rewrite.proofs) {
    lines.push(
      `| ${escapeCell(p.name)} | ${escapeCell(p.expected)} | ${escapeCell(p.actual)} | ${p.pass ? "pass" : "fail"} |`,
    );
  }
  lines.push("");
  lines.push(`- \`from\`: \`${rewrite.from}\``);
  lines.push(`- \`origin\`: \`${rewrite.originSha}\``);
  lines.push(`- \`base\`: \`${rewrite.base}\``);
  return lines;
};

const renderRewriteRecord = (report: SyncReport): string => {
  const rw = report.rewrite!;
  const lane = report.lane;
  return [
    "## Header",
    "",
    `- \`from\`: \`${rw.from}@${rw.fromSha}\``,
    `- \`expected_old\`: \`${rw.originSha}\``,
    `- Rehearsal branch: \`${lane?.branch ?? "absent"}\``,
    `- Rebased head: \`${report.rebasedHead ?? report.rewrite?.fromSha ?? "absent"}\``,
    `- Stack size: \`${report.stackSize ?? 0}\` fork commits`,
    "",
    ...renderRewriteProofs(rw),
    "",
    "## Silent seams",
    "",
    ...((report.silentSeams ?? []).length === 0
      ? ["None."]
      : (report.silentSeams ?? []).map(
          (s) =>
            `- \`${escapeCell(s.path)}\` [${s.touchesBehaviour ? "behaviour" : "type"}]: ${escapeCell(s.summary)}`,
        )),
    "",
    "## Verification",
    "",
    ...report.verification.map((row) => `- \`${row.command}\`: ${row.result}`),
    "",
    "## Grounding",
    "",
    "None.",
    "",
    report.stage === "checked" ? "land" : "do-not-land",
    "",
  ].join("\n");
};

export const renderRecord = (report: SyncReport): string => {
  if (report.kind === "rewrite" && report.rewrite !== undefined) return renderRewriteRecord(report);
  const target = report.target;
  const source = report.source;
  const lane = report.lane;
  const head = report.rebasedHead ?? "absent";
  const rows = report.conflicts.map(
    (row) =>
      `| \`${row.commit.slice(0, 12)}\` \`${escapeCell(row.subject)}\` | ${row.domain} | \`${escapeCell(row.path)}\` | ${row.class} | ${escapeCell(row.resolution)} | ${escapeCell(row.agentSafe)} | ${row.decidedBy} |`,
  );
  const decisions = new Map<
    string,
    {
      readonly subject: string;
      readonly domain: string;
      readonly classSummary: string;
      readonly action: string;
      readonly decidedBy: "human" | "agent";
    }
  >();
  for (const row of report.orientationDecisions ?? []) {
    decisions.set(row.subject, {
      subject: row.subject,
      domain: row.domain,
      classSummary:
        row.verdict === "candidate"
          ? "orientation: candidate; retire-candidate"
          : `orientation: ${row.verdict}`,
      action: row.action ?? (row.verdict === "candidate" ? "TODO" : row.verdict),
      decidedBy: row.decidedBy,
    });
  }
  for (const row of report.conflicts) {
    if (row.class !== "retire-candidate" && row.class !== "human") continue;
    const existing = decisions.get(row.subject);
    decisions.set(row.subject, {
      subject: row.subject,
      domain: row.domain,
      classSummary: existing === undefined ? row.class : `${existing.classSummary}; ${row.class}`,
      action: existing?.action ?? "TODO",
      decidedBy: existing?.decidedBy ?? row.decidedBy,
    });
  }
  const decisionRows = [...decisions.values()].map(
    (row) =>
      `| \`${escapeCell(row.subject)}\` | ${row.domain} | ${row.classSummary} | ${row.action} | ${NO_GROUNDING_CLAIM} | ${row.decidedBy} |`,
  );
  return [
    "## Header",
    "",
    `- Source: \`origin/hyprws@${source?.expectedOld ?? "absent"}\``,
    `- Target: \`${target?.tag ?? "absent"}@${target?.sha ?? "absent"}\``,
    `- \`expected_old\`: \`${source?.expectedOld ?? "absent"}\``,
    `- Rehearsal branch: \`${lane?.branch ?? "absent"}\``,
    `- Rebased head: \`${head}\``,
    `- Stack size: \`${report.stackSize ?? report.originalCount ?? 0}\` fork commits`,
    "",
    "## Conflicts",
    "",
    ...(rows.length === 0
      ? ["None."]
      : [
          "Escaped pipes are accepted in Subject, File, Resolution, and Agent-safe cells (`\\|`); write a literal backslash as `\\\\`.",
          "",
          "| Fork commit and subject | Domain | File | Class | Resolution | Agent-safe? | Decided by |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...rows,
        ]),
    "",
    "## Automerged overlap review",
    "",
    report.orientation ?? "See orientation in the JSON report.",
    "",
    "## Fork commits",
    "",
    ...(decisionRows.length === 0
      ? ["None."]
      : [
          "| Exact subject | Domain | Class summary | Action | Grounding claim | Decided by |",
          "| --- | --- | --- | --- | --- | --- |",
          ...decisionRows,
        ]),
    "",
    "## Silent seams",
    "",
    ...((report.silentSeams ?? []).length === 0
      ? ["None."]
      : (report.silentSeams ?? []).map(
          (seam) =>
            `- \`${escapeCell(seam.path)}\` [${seam.touchesBehaviour ? "behaviour" : "type"}]: ${escapeCell(seam.summary)}`,
        )),
    "",
    "## Verification",
    "",
    ...report.verification.map((row) => `- \`${row.command}\`: ${row.result}`),
    "",
    "## Grounding",
    "",
    "None.",
    "",
    report.stage === "checked" ? "land" : "do-not-land",
    "",
  ].join("\n");
};

export const writeRecord = (report: SyncReport): void =>
  NodeFS.writeFileSync(report.recordPath, renderRecord(report), { mode: 0o600 });

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

const invalidConflictCell = (column: string, detail: string): Error =>
  new Error(`invalid conflict ${column} cell: ${detail}`);

const unescapeCell = (value: string, column: string): string => {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped !== "\\" && escaped !== "|") {
      throw invalidConflictCell(
        column,
        escaped === undefined ? "trailing backslash" : `unsupported escape \\${escaped}`,
      );
    }
    result += escaped;
    index += 1;
  }
  return result;
};

const recordSection = (record: string, heading: string): string =>
  record.split(`${heading}\n`, 2)[1]?.split("\n## ", 1)[0] ?? "";

export const parseConflictRows = (record: string): ReadonlyArray<ConflictRow> => {
  const section = recordSection(record, "## Conflicts");
  const rows: Array<ConflictRow> = [];
  for (const line of section.split("\n")) {
    const cells = splitTableCells(line);
    if (cells === null || cells[0] === "Fork commit and subject") continue;
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    if (cells.length !== 6 && cells.length !== 7) {
      throw new Error(`invalid conflict row: expected 6 or 7 columns, found ${cells.length}`);
    }

    const commitAndSubject = /^`([0-9a-f]{7,12})` `([^`]*)`$/.exec(cells[0] ?? "");
    if (commitAndSubject === null)
      throw invalidConflictCell("Fork commit and subject", "expected `sha` `subject`");
    const path = /^`([^`]*)`$/.exec(cells[2] ?? "");
    if (path === null) throw invalidConflictCell("File", "expected a backticked path");

    const domain = cells[1] ?? "";
    if (/\\[\\|]/.test(domain))
      throw invalidConflictCell("Domain", "escaped pipes and backslashes are not accepted");
    const klass = cells[3] ?? "TODO";
    if (
      !["generated", "mechanical", "seam-moved", "retire-candidate", "human", "TODO"].includes(
        klass,
      )
    )
      throw invalidConflictCell("Class", klass);
    rows.push({
      commit: commitAndSubject[1] ?? "",
      subject: unescapeCell(commitAndSubject[2] ?? "", "Subject"),
      domain,
      path: unescapeCell(path[1] ?? "", "File"),
      class: klass as ConflictRow["class"],
      resolution: unescapeCell(cells[4] ?? "", "Resolution"),
      agentSafe: unescapeCell(cells[5] ?? "", "Agent-safe"),
      decidedBy:
        cells[6] === undefined || cells[6] === "human"
          ? "human"
          : cells[6] === "agent"
            ? "agent"
            : (() => {
                throw invalidConflictCell("Decided by", cells[6] ?? "");
              })(),
    });
  }
  return rows;
};

const invalidDecisionCell = (column: string, detail: string): Error =>
  new Error(`invalid fork commit ${column} cell: ${detail}`);

export const parseDecisionRows = (record: string): ReadonlyArray<OrientationDecisionRow> => {
  const section = recordSection(record, "## Fork commits");
  const rows: Array<OrientationDecisionRow> = [];
  for (const line of section.split("\n")) {
    const cells = splitTableCells(line);
    if (cells === null || cells[0] === "Exact subject") continue;
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    if (cells.length !== 5 && cells.length !== 6) {
      throw new Error(`invalid fork commit row: expected 5 or 6 columns, found ${cells.length}`);
    }

    const subject = /^`([^`]*)`$/.exec(cells[0] ?? "");
    if (subject === null)
      throw invalidDecisionCell("Exact subject", "expected a backticked subject");
    const domain = cells[1] ?? "";
    if (/\\[\\|]/.test(domain))
      throw invalidDecisionCell("Domain", "escaped pipes and backslashes are not accepted");
    const action = cells[3] ?? "";
    const verdict = action === "keep (mechanical seam)" ? "keep" : action;
    if (!["keep", "retire", "partial"].includes(verdict)) {
      throw invalidDecisionCell(
        "Action",
        `expected keep, keep (mechanical seam), retire, or partial; found ${action}`,
      );
    }
    rows.push({
      subject: unescapeCell(subject[1] ?? "", "Exact subject"),
      domain,
      verdict: verdict as OrientationDecisionRow["verdict"],
      ...(action === "keep (mechanical seam)" ? { action } : {}),
      decidedBy:
        cells[5] === undefined || cells[5] === "human"
          ? "human"
          : cells[5] === "agent"
            ? "agent"
            : (() => {
                throw invalidDecisionCell("Decided by", cells[5] ?? "");
              })(),
    });
  }
  return rows;
};

export interface ParsedRecord {
  readonly conflicts: ReadonlyArray<ConflictRow>;
  readonly decisions: ReadonlyArray<OrientationDecisionRow>;
}

/** Reads only the two tables emitted by renderRecord for a landed walk. */
export const parseRecord = (record: string): ParsedRecord => {
  const conflicts = parseConflictRows(record);
  const incomplete = conflicts.find((row) => row.class === "TODO");
  if (incomplete !== undefined)
    throw new Error(`conflict row remains incomplete for ${incomplete.path}`);
  return { conflicts, decisions: parseDecisionRows(record) };
};

export const orientationTouchedPaths = (orientation: string): ReadonlyArray<string> => {
  const overlap = /## Automerged overlap\n([\s\S]*?)(?:\n## |$)/.exec(orientation)?.[1] ?? "";
  return [...overlap.matchAll(/^  - (.+)$/gm)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .toSorted();
};

/** Retire candidates arrive with the subject in a code span; the row stores the subject itself. */
export const orientationDecisionRows = (
  orientation: string,
): ReadonlyArray<OrientationDecisionRow> =>
  [...orientation.matchAll(/^\s+\[(candidate|keep|retire|partial)\] `(.+)` \(([^)]+)\)$/gm)].map(
    (match) => ({
      verdict: (match[1] ?? "candidate") as OrientationVerdict,
      subject: match[2] ?? "",
      domain: match[3] ?? "?",
      decidedBy: "human",
    }),
  );
