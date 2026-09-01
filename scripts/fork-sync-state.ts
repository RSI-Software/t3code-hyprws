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
}

export interface SyncReport {
  readonly schemaVersion: 1;
  readonly stage: SyncStage;
  readonly repositoryRoot: string;
  readonly reportPath: string;
  readonly recordPath: string;
  readonly issue: { readonly number: number; readonly blockingSha: string; readonly title: string };
  readonly candidates: ReadonlyArray<{ readonly tag: string; readonly sha: string }>;
  readonly target?: { readonly tag: string; readonly sha: string };
  readonly source?: {
    readonly sha: string;
    readonly sharedBase: string;
    readonly expectedOld: string;
  };
  readonly lane?: { readonly branch: string; readonly worktree: string };
  readonly originalMessages?: string;
  readonly originalCount?: number;
  readonly conflicts: ReadonlyArray<ConflictRow>;
  readonly orientation?: string;
  readonly touchedPaths?: ReadonlyArray<string>;
  readonly verification: ReadonlyArray<{ readonly command: string; readonly result: string }>;
  readonly rebasedHead?: string;
  readonly stackSize?: number;
  readonly installedHead?: string;
  readonly recordCommentUrl?: string;
}

export const SYNC_HELP = `Usage: vp run fork:sync <verb> [options]

Unblock verbs:
  unblock-list [--output <external-json>]
  unblock-orient --report <json> --target <release-tag>
  unblock-rehearse --report <json>
  unblock-check --report <json>
  unblock-apply --report <json> --record <markdown>

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
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      !flag.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new UsageError(`invalid arguments after ${verb}`);
    }
    if (values.has(flag)) throw new UsageError(`duplicate option: ${flag}`);
    values.set(flag, value);
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

export const renderRecord = (report: SyncReport, existingSanity = "absent"): string => {
  const target = report.target;
  const source = report.source;
  const lane = report.lane;
  const head = report.rebasedHead ?? "absent";
  const rows = report.conflicts.map(
    (row) =>
      `| \`${row.commit.slice(0, 12)}\` \`${escapeCell(row.subject)}\` | ${row.domain} | \`${escapeCell(row.path)}\` | ${row.class} | ${escapeCell(row.resolution)} | ${escapeCell(row.agentSafe)} |`,
  );
  const decisions = new Map<string, ConflictRow>();
  for (const row of report.conflicts)
    if (row.class === "retire-candidate" || row.class === "human") decisions.set(row.subject, row);
  const decisionRows = [...decisions.values()].map(
    (row) =>
      `| \`${row.subject}\` | ${row.domain} | ${row.class} | TODO | n/a — no product grounding claim |`,
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
    `- Human sanity: ${existingSanity}`,
    "",
    "## Conflicts",
    "",
    ...(rows.length === 0
      ? ["None."]
      : [
          "Escaped pipes are accepted in Subject, File, Resolution, and Agent-safe cells (`\\|`); write a literal backslash as `\\\\`.",
          "",
          "| Fork commit and subject | Domain | File | Class | Resolution | Agent-safe? |",
          "| --- | --- | --- | --- | --- | --- |",
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
          "| Exact subject | Domain | Class summary | Action | Grounding claim |",
          "| --- | --- | --- | --- | --- |",
          ...decisionRows,
        ]),
    "",
    "## Silent seams",
    "",
    "None.",
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

const preserveSanity = (record: string): string =>
  /^- Human sanity: (.+)$/m.exec(record)?.[1] ?? "absent";
export const writeRecord = (report: SyncReport): void =>
  NodeFS.writeFileSync(
    report.recordPath,
    renderRecord(
      report,
      NodeFS.existsSync(report.recordPath)
        ? preserveSanity(NodeFS.readFileSync(report.recordPath, "utf8"))
        : "absent",
    ),
    { mode: 0o600 },
  );

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

export const parseConflictRows = (record: string): ReadonlyArray<ConflictRow> => {
  const section = record.split("## Conflicts\n", 2)[1]?.split("\n## ", 1)[0] ?? "";
  const rows: Array<ConflictRow> = [];
  for (const line of section.split("\n")) {
    const cells = splitTableCells(line);
    if (cells === null || cells[0] === "Fork commit and subject") continue;
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    if (cells.length !== 6) {
      throw new Error(`invalid conflict row: expected 6 columns, found ${cells.length}`);
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
    });
  }
  return rows;
};

export const orientationTouchedPaths = (orientation: string): ReadonlyArray<string> => {
  const overlap = /## Automerged overlap\n([\s\S]*?)(?:\n## |$)/.exec(orientation)?.[1] ?? "";
  return [...overlap.matchAll(/^  - (.+)$/gm)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .toSorted();
};

export const orientationDecisionRows = (orientation: string): ReadonlyArray<ConflictRow> =>
  [...orientation.matchAll(/^\s+\[(?:candidate|keep|retire|partial)\] (.+) \(([^)]+)\)$/gm)].map(
    (match) => ({
      commit: "orientation",
      subject: match[1] ?? "",
      domain: match[2] ?? "?",
      path: "orientation retire signal",
      class: "retire-candidate",
      resolution: "review upstream signal",
      agentSafe: "no — human retirement decision",
    }),
  );
