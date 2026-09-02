#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off - The churn ledger is standalone fork operator state.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { runCommandText } from "./lib/fork-command.ts";
import { FORK_REPOSITORY } from "./lib/fork-policy.ts";
import { parseRecord, type ConflictClass, type OrientationDecisionRow } from "./fork-sync-state.ts";

export const LEDGER_PATH = "docs/internals/fork-churn.json";
export const DOCUMENT_PATH = "docs/internals/fork-churn.md";
export const DELTA_PATH = "docs/internals/fork-delta.md";

const CONFLICT_CLASSES = [
  "generated",
  "mechanical",
  "seam-moved",
  "retire-candidate",
  "human",
] as const satisfies ReadonlyArray<ConflictClass>;
const CLASS_RANK = new Map(CONFLICT_CLASSES.map((value, index) => [value, index]));
const SHA = /^[0-9a-f]{7,64}$/;

export interface ChurnConflict {
  readonly path: string;
  readonly commit: string;
  readonly subject: string;
  readonly domain: string;
  readonly class: ConflictClass;
  readonly resolution: string;
  readonly decidedBy: "human" | "agent";
}

export interface CensusFile {
  readonly path: string;
  readonly hunks: number;
  readonly commit: string;
  readonly domain: string;
}

export interface ChurnEntry {
  readonly tag: string;
  readonly before: string;
  readonly after: string;
  readonly recordUrl: string;
  readonly conflicts: ReadonlyArray<ChurnConflict>;
  readonly decisions: ReadonlyArray<OrientationDecisionRow>;
  readonly censusFiles: ReadonlyArray<CensusFile>;
}

interface IssueView {
  readonly body: string;
  readonly url: string;
  readonly comments: ReadonlyArray<{ readonly body: string; readonly url: string }>;
}

interface HotSeam {
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
  const rows: Array<CensusFile> = [];
  for (const line of section(body, "## Sequential rebase census").split("\n")) {
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
    const commit = /^`([0-9a-f]{7,12}) .+`$/.exec(cells[2] ?? "");
    if (commit === null) throw new Error("invalid census Fork commit cell: expected `sha subject`");
    rows.push({
      path: unescapeCell(path[1] ?? ""),
      hunks,
      commit: commit[1] ?? "",
      domain: cells[3] ?? "",
    });
  }
  if (rows.length === 0) throw new Error("sequential rebase census has no file rows");
  return rows;
};

const isConflictClass = (value: unknown): value is ConflictClass =>
  typeof value === "string" && (CONFLICT_CLASSES as ReadonlyArray<string>).includes(value);

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
};

export const parseLedger = (raw: string): ReadonlyArray<ChurnEntry> => {
  const value = JSON.parse(raw) as unknown;
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
        decidedBy: (row.decidedBy === undefined || row.decidedBy === "human"
          ? "human"
          : row.decidedBy === "agent"
            ? "agent"
            : (() => {
                throw new Error(`invalid conflict decidedBy in entry ${entryIndex}`);
              })()) as "human" | "agent",
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
        decidedBy: (row.decidedBy === undefined || row.decidedBy === "human"
          ? "human"
          : row.decidedBy === "agent"
            ? "agent"
            : (() => {
                throw new Error(`invalid decision decidedBy in entry ${entryIndex}`);
              })()) as "human" | "agent",
      };
    });
    const censusFiles = entry.censusFiles.map((item, censusIndex) => {
      if (typeof item !== "object" || item === null)
        throw new Error(`invalid census file ${censusIndex} in entry ${entryIndex}`);
      const row = item as Record<string, unknown>;
      if (!Number.isSafeInteger(row.hunks) || Number(row.hunks) < 0)
        throw new Error(`invalid census hunks in entry ${entryIndex}`);
      return {
        path: requireString(row.path, "census path"),
        hunks: Number(row.hunks),
        commit: requireString(row.commit, "census commit"),
        domain: requireString(row.domain, "census domain"),
      };
    });
    return {
      tag: requireString(entry.tag, "tag"),
      before: requireString(entry.before, "before"),
      after: requireString(entry.after, "after"),
      recordUrl: requireString(entry.recordUrl, "recordUrl"),
      conflicts,
      decisions,
      censusFiles,
    } satisfies ChurnEntry;
  });
  const tags = new Set<string>();
  for (const entry of entries) {
    if (tags.has(entry.tag)) throw new Error(`duplicate tag: ${entry.tag}`);
    tags.add(entry.tag);
  }
  return entries;
};

const readLedger = (root: string): ReadonlyArray<ChurnEntry> => {
  const path = NodePath.join(root, LEDGER_PATH);
  return NodeFS.existsSync(path) ? parseLedger(NodeFS.readFileSync(path, "utf8")) : [];
};

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].toSorted();
const escapeCell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");
const code = (value: string): string => {
  let delimiter = "`";
  while (value.includes(delimiter)) delimiter += "`";
  return `${delimiter}${value}${delimiter}`;
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

export const hotSeams = (entries: ReadonlyArray<ChurnEntry>): ReadonlyArray<HotSeam> =>
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

const retirementAnchors = (forkDelta: string): ReadonlyMap<string, string> => {
  const anchors = new Map<string, string>();
  let domain: string | null = null;
  let retirementIndex = 0;
  for (const line of forkDelta.split("\n")) {
    if (line.startsWith("## ")) domain = line.slice(3);
    if (line !== "### Retirement condition" || domain === null) continue;
    const suffix = retirementIndex === 0 ? "" : `-${retirementIndex}`;
    anchors.set(domain, `fork-delta.md#retirement-condition${suffix}`);
    retirementIndex += 1;
  }
  return anchors;
};

const classHistogram = (rows: ReadonlyArray<ChurnConflict>): string =>
  CONFLICT_CLASSES.map(
    (klass) => [klass, rows.filter((row) => row.class === klass).length] as const,
  )
    .filter(([, count]) => count > 0)
    .map(([klass, count]) => `${klass}: ${count}`)
    .join(", ");

const formatCommits = (
  rows: ReadonlyArray<ChurnConflict>,
  links?: ReadonlyMap<string, string>,
): string => {
  const commits = new Map<string, ChurnConflict>();
  for (const row of rows) commits.set(row.subject, row);
  return [...commits.values()]
    .toSorted(
      (left, right) =>
        left.subject.localeCompare(right.subject) || left.commit.localeCompare(right.commit),
    )
    .map((row) => {
      const domain = links?.get(row.domain);
      const suffix = domain === undefined ? "" : ` ([${row.domain}](${domain}))`;
      return `${code(row.commit)} ${code(row.subject)}${suffix}`;
    })
    .join("<br>");
};

const percentage = (part: number, total: number): string => `${((part / total) * 100).toFixed(1)}%`;

export const renderMarkdown = (entries: ReadonlyArray<ChurnEntry>, forkDelta: string): string => {
  const lines: Array<string> = [
    "# Fork conflict churn",
    "",
    "> Generated by `vp run fork:churn`. Do not edit by hand.",
    "",
    `- Entries: ${entries.length}`,
    `- Tag range: ${entries.length === 0 ? "none" : `${code(entries[0]?.tag ?? "")} → ${code(entries.at(-1)?.tag ?? "")}`}`,
    "",
    "## Hot seams",
    "",
  ];
  const hot = hotSeams(entries);
  if (hot.length === 0) {
    lines.push("None.", "");
  } else {
    const links = retirementAnchors(forkDelta);
    lines.push(
      "<!-- prettier-ignore -->",
      "| Path | Walks | Worst class | Fork commits |",
      "| --- | ---: | --- | --- |",
    );
    for (const seam of hot) {
      lines.push(
        `| ${escapeCell(code(seam.path))} | ${seam.walkCount} | ${seam.worstClass} | ${escapeCell(formatCommits(seam.conflicts, links))} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Per file", "");
  const paths = [...conflictRowsByPath(entries)].map(([path, values]) => ({
    path,
    walkCount: new Set(values.map(({ tag }) => tag)).size,
    rows: values.map(({ row }) => row),
  }));
  paths.sort(
    (left, right) => right.walkCount - left.walkCount || left.path.localeCompare(right.path),
  );
  if (paths.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push(
      "<!-- prettier-ignore -->",
      "| Path | Walks conflicted | Class histogram | Fork commits |",
      "| --- | ---: | --- | --- |",
    );
    for (const path of paths) {
      lines.push(
        `| ${escapeCell(code(path.path))} | ${path.walkCount} | ${classHistogram(path.rows)} | ${escapeCell(formatCommits(path.rows))} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Per fork commit", "");
  const commits = new Map<
    string,
    {
      subject: string;
      domain: string;
      tags: Set<string>;
      files: Set<string>;
      verdicts: Array<{ tag: string; verdict: string }>;
    }
  >();
  for (const entry of entries) {
    for (const row of entry.conflicts) {
      const key = `${row.subject}\u0000${row.domain}`;
      const value = commits.get(key) ?? {
        subject: row.subject,
        domain: row.domain,
        tags: new Set(),
        files: new Set(),
        verdicts: [],
      };
      value.tags.add(entry.tag);
      value.files.add(row.path);
      commits.set(key, value);
    }
    for (const row of entry.decisions) {
      const key = `${row.subject}\u0000${row.domain}`;
      const value = commits.get(key) ?? {
        subject: row.subject,
        domain: row.domain,
        tags: new Set(),
        files: new Set(),
        verdicts: [],
      };
      value.verdicts.push({ tag: entry.tag, verdict: row.verdict });
      commits.set(key, value);
    }
  }
  const commitRows = [...commits.values()].toSorted(
    (left, right) =>
      right.tags.size - left.tags.size ||
      left.subject.localeCompare(right.subject) ||
      left.domain.localeCompare(right.domain),
  );
  if (commitRows.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push(
      "<!-- prettier-ignore -->",
      "| Subject | Domain | Walks conflicted | Files | Verdict history |",
      "| --- | --- | ---: | --- | --- |",
    );
    for (const row of commitRows) {
      lines.push(
        `| ${escapeCell(code(row.subject))} | ${row.domain} | ${row.tags.size} | ${
          escapeCell(
            unique([...row.files])
              .map(code)
              .join("<br>"),
          ) || "none"
        } | ${escapeCell(row.verdicts.map(({ tag, verdict }) => `${code(tag)}: ${verdict}`).join("<br>")) || "none"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Per domain", "");
  const domains = new Map<
    string,
    { tags: Set<string>; files: Set<string>; rows: Array<ChurnConflict> }
  >();
  for (const entry of entries) {
    for (const row of entry.conflicts) {
      const value = domains.get(row.domain) ?? { tags: new Set(), files: new Set(), rows: [] };
      value.tags.add(entry.tag);
      value.files.add(row.path);
      value.rows.push(row);
      domains.set(row.domain, value);
    }
  }
  const domainRows = [...domains].toSorted(
    ([leftName, left], [rightName, right]) =>
      right.tags.size - left.tags.size || leftName.localeCompare(rightName),
  );
  if (domainRows.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push(
      "<!-- prettier-ignore -->",
      "| Domain | Walks conflicted | Files | Mechanical + generated vs rest |",
      "| --- | ---: | --- | --- |",
    );
    for (const [domain, value] of domainRows) {
      const mechanical = value.rows.filter(
        (row) => row.class === "mechanical" || row.class === "generated",
      ).length;
      const rest = value.rows.length - mechanical;
      lines.push(
        `| ${domain} | ${value.tags.size} | ${escapeCell(
          unique([...value.files])
            .map(code)
            .join("<br>"),
        )} | ${mechanical}/${value.rows.length} (${percentage(mechanical, value.rows.length)}) vs ${rest}/${value.rows.length} (${percentage(rest, value.rows.length)}) |`,
      );
    }
    lines.push("");
  }

  lines.push("## Walks", "");
  if (entries.length === 0) {
    lines.push("None.", "");
  } else {
    lines.push(
      "<!-- prettier-ignore -->",
      "| Tag | Range | Conflicts by class | Agent/human decisions | Record |",
      "| --- | --- | --- | ---: | --- |",
    );
    for (const entry of entries) {
      const decidedRows = [...entry.conflicts, ...entry.decisions];
      const agent = decidedRows.filter(({ decidedBy }) => decidedBy === "agent").length;
      const human = decidedRows.length - agent;
      lines.push(
        `| ${code(entry.tag)} | ${code(entry.before)} → ${code(entry.after)} | ${classHistogram(entry.conflicts) || "none"} | ${agent}/${human} | [record](${entry.recordUrl}) |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

const renderForRoot = (root: string, entries: ReadonlyArray<ChurnEntry>): string =>
  renderMarkdown(entries, NodeFS.readFileSync(NodePath.join(root, DELTA_PATH), "utf8"));

const parseOptions = (args: ReadonlyArray<string>): ReadonlyMap<string, string> => {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith("--") ||
      value.startsWith("--")
    )
      throw new Error("invalid append arguments");
    if (options.has(flag)) throw new Error(`duplicate option: ${flag}`);
    options.set(flag, value);
  }
  return options;
};

const append = (args: ReadonlyArray<string>, root: string): void => {
  const options = parseOptions(args);
  const allowed = ["--record", "--issue", "--tag", "--before", "--after"];
  for (const option of options.keys())
    if (!allowed.includes(option)) throw new Error(`unknown option: ${option}`);
  const required = (flag: string): string => {
    const value = options.get(flag);
    if (value === undefined) throw new Error(`${flag} is required`);
    return value;
  };
  const recordPath = NodePath.resolve(root, required("--record"));
  const issue = Number(required("--issue"));
  const tag = required("--tag");
  const before = required("--before");
  const after = required("--after");
  if (!Number.isSafeInteger(issue) || issue < 1)
    throw new Error("--issue must be a positive integer");
  if (!SHA.test(before) || !SHA.test(after))
    throw new Error("--before and --after must be Git SHAs");
  const entries = readLedger(root);
  if (entries.some((entry) => entry.tag === tag)) throw new Error(`duplicate tag: ${tag}`);

  const record = NodeFS.readFileSync(recordPath, "utf8");
  const parsed = parseRecord(record);
  const issueView = JSON.parse(
    runCommandText(
      "gh",
      ["issue", "view", String(issue), "--repo", FORK_REPOSITORY, "--json", "body,comments,url"],
      { cwd: root },
    ),
  ) as IssueView;
  const recordUrl =
    issueView.comments.find((comment) => comment.body.trim() === record.trim())?.url ??
    (issueView.body.trim() === record.trim() ? issueView.url : undefined);
  if (recordUrl === undefined)
    throw new Error(`record does not match issue ${issue} body or comments`);
  const conflicts = parsed.conflicts.map(
    ({ path, commit, subject, domain, class: klass, resolution, decidedBy }) => ({
      path,
      commit,
      subject,
      domain,
      class: klass as ConflictClass,
      resolution,
      decidedBy,
    }),
  );
  const next = [
    ...entries,
    {
      tag,
      before,
      after,
      recordUrl,
      conflicts,
      decisions: parsed.decisions,
      censusFiles: parseCensusFiles(issueView.body),
    },
  ] satisfies ReadonlyArray<ChurnEntry>;
  const rendered = renderForRoot(root, next);
  NodeFS.writeFileSync(NodePath.join(root, LEDGER_PATH), `${JSON.stringify(next, null, 2)}\n`);
  NodeFS.writeFileSync(NodePath.join(root, DOCUMENT_PATH), rendered);
  process.stdout.write(`appended ${tag}: ${conflicts.length} conflict(s)\n`);
};

export const run = (argv: ReadonlyArray<string>, root = process.cwd()): number => {
  try {
    const [verb, ...args] = argv;
    if (verb === "append") {
      append(args, root);
      return 0;
    }
    if (verb !== "render") throw new Error("usage: fork-churn append <options> | render [--check]");
    if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
      throw new Error("usage: fork-churn render [--check]");
    const rendered = renderForRoot(root, readLedger(root));
    const documentPath = NodePath.join(root, DOCUMENT_PATH);
    if (args[0] === "--check") {
      const committed = NodeFS.existsSync(documentPath)
        ? NodeFS.readFileSync(documentPath, "utf8")
        : "";
      if (committed !== rendered) {
        process.stderr.write(`${DOCUMENT_PATH} is stale; run vp run fork:churn\n`);
        return 1;
      }
      process.stdout.write(`${DOCUMENT_PATH} is current\n`);
      return 0;
    }
    NodeFS.writeFileSync(documentPath, rendered);
    process.stdout.write(`${DOCUMENT_PATH}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
