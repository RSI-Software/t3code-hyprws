#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off - The churn ledger is standalone fork operator state.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CHURN_REF, pushBotRef, pushBotRefWithLease, resolveBotRef } from "./lib/fork-bot-refs.ts";
import { runCommandText } from "./lib/fork-command.ts";
import {
  censusChurn,
  CONFLICT_CLASSES,
  conflictRowsByPath,
  enrichCensusSubjects,
  hotSeams,
  parseCensusFiles,
  parseCensusTag,
  parseLedger,
  parseChurnState,
  parseSilentSeams,
  readChurnLedger,
  readChurnState,
  writeChurnState,
  writeChurnLedger,
  type CensusFile,
  type ChurnConflict,
  type ChurnEntry,
} from "./fork-churn-ledger.ts";
import { CHURN_MARKER, blockingSeamLines, renderChurnSection } from "./fork-churn-section.ts";
import { requireSeamRecords } from "./lib/fork-churn-seams.ts";
import { UsageError } from "./lib/fork-cli.ts";
import { FORK_REPOSITORY } from "./lib/fork-policy.ts";
import { BLOCK_LABEL, parseRecord, type ConflictClass } from "./fork-sync-state.ts";
import { parseSequentialCensusEvidence } from "./lib/fork-rebase-issues.ts";
import { runOutcome } from "./fork-churn-outcomes.ts";
import {
  readLessonEvidence,
  lessonAssessmentUnavailable,
  resolveLessonSource,
  renderLessonSource,
} from "./fork-lesson-guidance.ts";

export {
  censusChurn,
  enrichCensusSubjects,
  hotSeams,
  parseCensusFiles,
  parseCensusTag,
  parseLedger,
  type CensusFile,
  type ChurnConflict,
  type ChurnEntry,
};

/**
 * Deprecated. The ledger now lives on `refs/fork/churn`, so no fork commit carries a
 * row and no rebase has to replay one. These paths stay readable until
 * RSI-Software/t3code-hyprws#476 retires them.
 */
export const LEDGER_PATH = "docs/internals/fork-churn.json";
export const DOCUMENT_PATH = "docs/internals/fork-churn.md";
export const DELTA_PATH = "docs/internals/fork-delta.md";

const SHA = /^[0-9a-f]{7,64}$/;

const censusSubjectOf =
  (root: string) =>
  (commit: string): string =>
    runCommandText("git", ["show", "-s", "--format=%s", `${commit}^{commit}`], {
      cwd: root,
    }).trim();

const enrichLedgerForRoot = (
  root: string,
  entries: ReadonlyArray<ChurnEntry>,
): ReadonlyArray<ChurnEntry> => enrichCensusSubjects(entries, censusSubjectOf(root));

const subjectlessCensusCommits = (entries: ReadonlyArray<ChurnEntry>): ReadonlyArray<string> =>
  [
    ...new Set(
      entries.flatMap((entry) =>
        entry.censusFiles.flatMap((file) => (file.subject === undefined ? [file.commit] : [])),
      ),
    ),
  ].toSorted();

const readDurableLedger = (
  root: string,
  entries = readChurnLedger(root),
): ReadonlyArray<ChurnEntry> => {
  const missing = subjectlessCensusCommits(entries);
  if (missing.length > 0)
    throw new Error(
      `${CHURN_REF} has subjectless census commits: ${missing.join(", ")}; run fork-churn migrate-subjects while those objects are available`,
    );
  return entries;
};

interface IssueView {
  readonly body: string;
  readonly url: string;
  readonly comments: ReadonlyArray<{ readonly body: string; readonly url: string }>;
}

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].toSorted();
const escapeCell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");
const code = (value: string): string => {
  let delimiter = "`";
  while (value.includes(delimiter)) delimiter += "`";
  return `${delimiter}${value}${delimiter}`;
};

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
    "> Deprecated. `refs/fork/churn` is the ledger; this document and `fork-churn.json` are a",
    "> frozen mirror that RSI-Software/t3code-hyprws#476 retires at a later rebase.",
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
      // A row with no provenance is nobody's decision, so it is counted on neither side rather
      // than credited to the human by default.
      const decidedRows = [...entry.conflicts, ...entry.decisions];
      const agent = decidedRows.filter(({ decidedBy }) => decidedBy === "agent").length;
      const human = decidedRows.filter(({ decidedBy }) => decidedBy === "human").length;
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
      throw new UsageError("invalid arguments: expected flag/value pairs");
    if (options.has(flag)) throw new UsageError(`duplicate option: ${flag}`);
    options.set(flag, value);
  }
  return options;
};

const takeFlag = (args: ReadonlyArray<string>, flag: string): [boolean, ReadonlyArray<string>] => [
  args.includes(flag),
  args.filter((value) => value !== flag),
];

const append = (args: ReadonlyArray<string>, root: string): void => {
  const [push, rest] = takeFlag(args, "--push");
  const options = parseOptions(rest);
  const allowed = ["--record", "--issue", "--tag", "--before", "--after"];
  for (const option of options.keys())
    if (!allowed.includes(option)) throw new UsageError(`unknown option: ${option}`);
  const required = (flag: string): string => {
    const value = options.get(flag);
    if (value === undefined) throw new UsageError(`${flag} is required`);
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
  const entries = readDurableLedger(root);
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
  const censusEvidence = parseSequentialCensusEvidence(issueView.body);
  if (censusEvidence !== null && censusEvidence.targetTag !== tag)
    throw new Error(`--tag ${tag} does not match census targetTag ${censusEvidence.targetTag}`);
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
  const silentSeams = parseSilentSeams(record);
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
      ...(censusEvidence === null ? {} : { censusEvidence }),
      ...(silentSeams.length === 0 ? {} : { silentSeams }),
      ...(parsed.nightlyReview === undefined ? {} : { nightlyReview: parsed.nightlyReview }),
    },
  ] satisfies ReadonlyArray<ChurnEntry>;
  // The document is a frozen mirror (#476). Precompute it before moving the ref so a
  // malformed delta cannot leave a locally appended row behind after a failed command.
  const documentPath = NodePath.join(root, DOCUMENT_PATH);
  const renderedDocument = NodeFS.existsSync(documentPath) ? renderForRoot(root, next) : null;
  writeChurnLedger(root, next, `churn: ${tag}`);
  if (push) pushBotRef(root, CHURN_REF);
  if (renderedDocument !== null) NodeFS.writeFileSync(documentPath, renderedDocument);
  process.stdout.write(
    `appended ${tag}: ${conflicts.length} conflict(s) on ${CHURN_REF}${push ? " (pushed)" : ""}\n`,
  );
};

interface BlockedIssueView {
  readonly number: number;
}

/** The single open block issue the walk hangs off, or null when nothing is blocked. */
const blockedIssueNumber = (root: string): number | null => {
  const issues = JSON.parse(
    runCommandText(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        BLOCK_LABEL,
        "--repo",
        FORK_REPOSITORY,
        "--json",
        "number",
      ],
      { cwd: root },
    ),
  ) as ReadonlyArray<BlockedIssueView>;
  if (issues.length > 1)
    throw new Error(`expected at most one open ${BLOCK_LABEL} issue, found ${issues.length}`);
  return issues[0]?.number ?? null;
};

interface IssueComments {
  readonly body: string;
  readonly comments: ReadonlyArray<{ readonly url: string; readonly body: string }>;
}

/**
 * `gh issue view --json comments` reports a comment's GraphQL node id, which the REST
 * comment path refuses; the permalink it returns alongside carries the numeric database
 * id that path wants.
 */
export const commentRestId = (url: string): string => {
  const id = /#issuecomment-(\d+)$/.exec(url)?.[1];
  if (id === undefined) throw new Error(`comment url carries no REST id: ${url}`);
  return id;
};

/**
 * Post the churn section on the block issue, replacing the section the previous
 * report left so the issue carries one live view instead of a pile of snapshots.
 */
const report = (args: ReadonlyArray<string>, root: string): number => {
  const options = parseOptions(args);
  for (const option of options.keys())
    if (option !== "--issue" && option !== "--receipt")
      throw new UsageError(`unknown option: ${option}`);
  const receiptPath = options.get("--receipt");
  const receipt = (publication: string, policy: string, url?: string) => {
    if (receiptPath === undefined) return;
    const path = NodePath.resolve(root, receiptPath);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(
      path,
      `${JSON.stringify({ publication, policy, ...(url ? { url } : {}) })}\n`,
    );
  };
  receipt("not-attempted", "not-attempted");
  const explicit = options.get("--issue");
  const issue = explicit === undefined ? blockedIssueNumber(root) : Number(explicit);
  if (issue === null) {
    process.stdout.write(`no open ${BLOCK_LABEL} issue; churn section not posted\n`);
    return 0;
  }
  if (!Number.isSafeInteger(issue) || issue < 1)
    throw new Error("--issue must be a positive integer");
  const view = JSON.parse(
    runCommandText(
      "gh",
      ["issue", "view", String(issue), "--repo", FORK_REPOSITORY, "--json", "body,comments"],
      { cwd: root },
    ),
  ) as IssueComments;
  const existing = view.comments.findLast((comment) => comment.body.includes(CHURN_MARKER));
  // A report reads one immutable snapshot; fetching current guidance must not move
  // the retained ref used by local append/record writers.
  const source = resolveLessonSource(root, CHURN_REF, false);
  if (source.raw === null)
    throw new Error(`${CHURN_REF} lesson evidence is unavailable: ${source.detail}`);
  const lessons = readLessonEvidence(source.raw);
  const entries = readDurableLedger(root, lessons.walks);
  const currentCensus = {
    tag: parseCensusTag(view.body),
    fixedAt: null,
    files: parseCensusFiles(view.body),
    ...(parseSequentialCensusEvidence(view.body) === null
      ? {}
      : {
          censusEvidence: parseSequentialCensusEvidence(view.body)!,
        }),
  } as const;
  const records = lessons.seamRecords;
  const unavailable = lessonAssessmentUnavailable(lessons, source);
  const churn = unavailable === null ? censusChurn(entries, currentCensus, records) : null;
  const section =
    churn === null
      ? `${CHURN_MARKER}\n## Churn\n\nLesson assessment unavailable: ${unavailable}. No repair or policy pass is inferred.\n`
      : renderChurnSection(entries, existing?.body ?? null, currentCensus, records);
  const body = `${section}\n\n\`\`\`text\n${renderLessonSource(source, lessons)}\n\`\`\`\n`;
  const bodyPath = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-churn-report-")),
    "churn.md",
  );
  NodeFS.writeFileSync(bodyPath, body);
  let url: string;
  try {
    url = runCommandText(
      "gh",
      existing === undefined
        ? ["issue", "comment", String(issue), "--repo", FORK_REPOSITORY, "--body-file", bodyPath]
        : [
            "api",
            "--method",
            "PATCH",
            `repos/${FORK_REPOSITORY}/issues/comments/${commentRestId(existing.url)}`,
            "--field",
            `body=@${bodyPath}`,
            "--jq",
            ".html_url",
          ],
      { cwd: root },
    ).trim();
  } catch (error) {
    receipt("failed", "not-attempted");
    throw error;
  }
  process.stdout.write(`churn section on #${issue}: ${url}\n`);
  if (churn === null) {
    receipt("succeeded", "failed", url);
    process.stderr.write(
      `Lesson assessment unavailable: ${unavailable}; the published report does not establish a policy pass.\n`,
    );
    return 1;
  }
  const failures = blockingSeamLines(churn);
  receipt("succeeded", failures.length === 0 ? "succeeded" : "failed", url);
  if (failures.length === 0) return 0;
  process.stderr.write(
    `${failures.length} unresolved blocking seam(s); full evidence is in the issue report.\n${failures.slice(0, 10).join("\n")}\n`,
  );
  return 1;
};

const recordSeams = (args: ReadonlyArray<string>, root: string): number => {
  if (args.filter((value) => value === "--push").length > 1)
    throw new UsageError("duplicate --push");
  const [push, rest] = takeFlag(args, "--push");
  if (rest.length !== 2 || rest[0] !== "--input" || rest[1]!.startsWith("--"))
    throw new UsageError("usage: fork-churn record --input <reviewed-bundle.json> [--push]");
  const bundle: unknown = JSON.parse(NodeFS.readFileSync(NodePath.resolve(root, rest[1]!), "utf8"));
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle))
    throw new Error("invalid seam record bundle");
  const input = bundle as Record<string, unknown>;
  if (
    input.version !== 1 ||
    !Array.isArray(input.records) ||
    Object.keys(input).some((key) => key !== "version" && key !== "records")
  )
    throw new Error("expected seam bundle {version:1, records:[...]}");
  const expectedOld = resolveBotRef(root, CHURN_REF);
  if (expectedOld === null) throw new Error("seed the churn ledger before recording seam evidence");
  const state = readChurnState(root);
  const seamRecords = requireSeamRecords([...state.seamRecords, ...input.records]);
  const added = seamRecords.length - state.seamRecords.length;
  const commit =
    added === 0
      ? expectedOld
      : writeChurnState(root, { ...state, seamRecords }, "churn: record seam evidence");
  if (push) {
    try {
      pushBotRefWithLease(root, CHURN_REF, expectedOld);
    } catch (error) {
      if (commit !== expectedOld)
        runCommandText("git", ["update-ref", CHURN_REF, expectedOld, commit], { cwd: root });
      throw error;
    }
  }
  process.stdout.write(
    `recorded ${added} seam record(s) on ${CHURN_REF} at ${commit}${push ? " (pushed with expected-old lease)" : ""}; guard results are maintainer attestations\n`,
  );
  return 0;
};

/**
 * Move the file-backed ledger onto its bot-owned ref. One-time, and refused once the
 * ref exists, because the ref outruns the frozen file from the first walk onward.
 */
const seed = (args: ReadonlyArray<string>, root: string): number => {
  const [push, rest] = takeFlag(args, "--push");
  const options = parseOptions(rest);
  for (const option of options.keys())
    if (option !== "--from") throw new UsageError(`unknown option: ${option}`);
  const from = NodePath.resolve(root, options.get("--from") ?? LEDGER_PATH);
  if (resolveBotRef(root, CHURN_REF) !== null)
    throw new Error(`${CHURN_REF} already exists; it is seeded once and appended to after that`);
  const source = parseChurnState(NodeFS.readFileSync(from, "utf8"));
  const entries = enrichLedgerForRoot(root, source.walks);
  const commit = writeChurnState(
    root,
    { ...source, walks: entries },
    `churn: seed from ${NodePath.relative(root, from)}`,
  );
  if (push) pushBotRef(root, CHURN_REF);
  process.stdout.write(
    `${CHURN_REF} at ${commit}: ${entries.length} walk(s)${push ? " (pushed)" : ""}\n`,
  );
  return 0;
};

/**
 * One-time durable upgrade for census rows written before subjects were stored. Resolve every
 * missing subject before creating a commit, then publish only against the exact ref we read.
 */
const migrateSubjects = (args: ReadonlyArray<string>, root: string): number => {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--push"))
    throw new UsageError("usage: fork-churn migrate-subjects [--push]");
  const push = args[0] === "--push";
  const expectedOld = resolveBotRef(root, CHURN_REF);
  if (expectedOld === null)
    throw new Error(
      `${CHURN_REF} does not carry a ledger; seed it before migrating census subjects`,
    );
  const entries = readChurnLedger(root);
  const missing = subjectlessCensusCommits(entries);
  if (missing.length === 0) {
    process.stdout.write(`${CHURN_REF} already has durable census subjects\n`);
    return 0;
  }

  const migrated = enrichLedgerForRoot(root, entries);
  const commit = writeChurnLedger(root, migrated, "churn: migrate census subjects");
  if (push) {
    try {
      pushBotRefWithLease(root, CHURN_REF, expectedOld);
    } catch (pushError) {
      try {
        runCommandText("git", ["update-ref", CHURN_REF, expectedOld, commit], { cwd: root });
      } catch (restoreError) {
        throw new Error(
          `${pushError instanceof Error ? pushError.message : String(pushError)}\nfailed to restore ${CHURN_REF} to ${expectedOld}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          { cause: restoreError },
        );
      }
      throw pushError;
    }
  }
  process.stdout.write(
    `migrated ${missing.length} census commit(s) on ${CHURN_REF} at ${commit}${push ? " (pushed with expected-old lease)" : ""}\n`,
  );
  return 0;
};

const USAGE =
  "usage: fork-churn append <options> | record --input <json> [--push] | outcome --input <json> [--push] | migrate-subjects [--push] | render [--check] | report [--issue <n>] [--receipt <json>] | seed [--from <json>] [--push]";

const HELP = `Record fork rebase evidence and target outcomes through distribution.
${USAGE}

outcome imports immutable {version:1, receipts:[...]} evidence. Alternatively,
--auto-report PATH collects planner/result evidence with optional --report-receipt PATH;
--sync-report PATH collects a retained sync report and its local outcome sidecar.
--release collects FORK_RELEASE_NEEDS job results and verifies GitHub tag/assets.
FORK_OUTCOME_EXPORT retains an importable bundle before ledger publication.
Eligibility is declared independently of bot mode. Missing stages never imply success.
Output is JSON with retained outcomes, resume action and explicitly eligible streaks.

record --input PATH imports a reviewed {version:1, records:[...]} bundle.
It validates content digests and frozen evidence; it does not execute guard commands.
--push publishes the bot-owned ref with an expected-old lease.
report writes the GitHub churn comment and reports unresolved failures.
It reads one current immutable lesson source and reports its SHA/freshness without moving local refs.
Newer schemas publish an unavailable assessment and exit 1; no policy pass is inferred.
render writes the local mirror; --check compares without writing.
seed initializes the ledger; append records a completed walk.
Exit: 0 complete, 1 runtime/evidence failure or blocking seam, 2 invalid arguments.
Output: compact receipts on stdout; failures on stderr. -h / --help writes nothing.
`;

export const run = (argv: ReadonlyArray<string>, root = process.cwd()): number => {
  try {
    if (
      (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) ||
      (argv.length === 2 &&
        ["record", "outcome"].includes(argv[0]!) &&
        ["--help", "-h"].includes(argv[1]!))
    ) {
      process.stdout.write(HELP);
      return 0;
    }
    // The package alias historically defaulted to render; preserve that invocation.
    const [verb, ...args] = argv.length === 0 || argv[0] === "--check" ? ["render", ...argv] : argv;
    if (verb === "record") return recordSeams(args, root);
    if (verb === "append") {
      append(args, root);
      return 0;
    }
    if (verb === "outcome") return runOutcome(args, root);
    if (verb === "report") return report(args, root);
    if (verb === "seed") return seed(args, root);
    if (verb === "migrate-subjects") return migrateSubjects(args, root);
    if (verb !== "render") throw new UsageError(USAGE);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
      throw new UsageError("usage: fork-churn render [--check]");
    const rendered = renderForRoot(root, readDurableLedger(root));
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
    return error instanceof UsageError ? 2 : 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
