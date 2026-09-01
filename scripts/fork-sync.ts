#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Operator state machine runs before Effect exists.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const REPOSITORY = "RSI-Software/t3code-hyprws";
const BLOCK_LABEL = "rebase-blocked";
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
const FULL_SHA = /^[0-9a-f]{40,64}$/;
const COMMENT_CONFIG = {
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

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    input?: string,
    env?: NodeJS.ProcessEnv,
  ): CommandResult;
}

export class SystemRunner implements CommandRunner {
  run(
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    input?: string,
    env?: NodeJS.ProcessEnv,
  ): CommandResult {
    const result = NodeChildProcess.spawnSync(command, [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
      ...(env === undefined ? {} : { env }),
    });
    if (result.error !== undefined) throw result.error;
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }
}

export class UsageError extends Error {}

const HELP = `Usage: vp run fork:sync <verb> [options]

Unblock verbs:
  unblock-list [--output <external-json>]
  unblock-orient --report <json> --target <release-tag>
  unblock-rehearse --report <json>
  unblock-check --report <json>
  unblock-apply --report <json> --record <markdown>
`;

const commandText = (command: string, args: ReadonlyArray<string>): string =>
  [command, ...args]
    .map((value) => (/^[\w./:@#=-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(" ");

const requireSuccess = (
  runner: CommandRunner,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  input?: string,
  env?: NodeJS.ProcessEnv,
): string => {
  const result = runner.run(command, args, cwd, input, env);
  if (result.status === 0) return result.stdout;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(`${commandText(command, args)} failed${detail ? `: ${detail}` : ""}`);
};

const gitRaw = (
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

const git = (
  runner: CommandRunner,
  cwd: string,
  args: ReadonlyArray<string>,
  rehearsal = false,
): string => gitRaw(runner, cwd, args, rehearsal).trim();

const rootFor = (runner: CommandRunner, cwd: string): string =>
  git(runner, cwd, ["rev-parse", "--show-toplevel"]);
const lines = (value: string): ReadonlyArray<string> =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const extractBlockingSha = (body: string): string | null =>
  /<!-- blocking-sha:([0-9a-f]{40,64}) -->/.exec(body)?.[1] ?? null;

const parseVerbArgs = (
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

const oneValue = (
  values: ReadonlyMap<string, string>,
  flag: string,
  required = true,
): string | null => {
  const value = values.get(flag) ?? null;
  if (required && value === null) throw new UsageError(`${flag} is required`);
  return value;
};

const assertOnly = (values: ReadonlyMap<string, string>, allowed: ReadonlyArray<string>): void => {
  for (const flag of values.keys())
    if (!allowed.includes(flag)) throw new UsageError(`unknown option: ${flag}`);
};

const externalPath = (root: string, path: string): string => {
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

const readReport = (path: string): SyncReport => {
  const report = validateReport(JSON.parse(NodeFS.readFileSync(path, "utf8")));
  if (NodePath.resolve(path) !== NodePath.resolve(report.reportPath))
    throw new Error("report path does not match its binding");
  return report;
};

const writeReport = (report: SyncReport): void => {
  const temporary = `${report.reportPath}.tmp-${process.pid}`;
  NodeFS.mkdirSync(NodePath.dirname(report.reportPath), { recursive: true });
  NodeFS.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, report.reportPath);
  NodeFS.chmodSync(report.reportPath, 0o600);
};

const escapeCell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");

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
const writeRecord = (report: SyncReport): void =>
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

export const parseConflictRows = (record: string): ReadonlyArray<ConflictRow> => {
  const rows: Array<ConflictRow> = [];
  for (const line of record.split("\n")) {
    const match =
      /^\| `([0-9a-f]{7,12})` `(.+)` \| ([^|]+) \| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/.exec(
        line,
      );
    if (match === null) continue;
    const klass = match[5]?.trim() ?? "TODO";
    if (
      !["generated", "mechanical", "seam-moved", "retire-candidate", "human", "TODO"].includes(
        klass,
      )
    )
      throw new Error(`invalid conflict class ${klass}`);
    rows.push({
      commit: match[1] ?? "",
      subject: (match[2] ?? "").replaceAll("\\|", "|"),
      domain: (match[3] ?? "").trim(),
      path: match[4] ?? "",
      class: klass as ConflictRow["class"],
      resolution: (match[6] ?? "").trim(),
      agentSafe: (match[7] ?? "").trim(),
    });
  }
  return rows;
};

const readIssue = (
  runner: CommandRunner,
  root: string,
): { number: number; title: string; body: string } => {
  const raw = requireSuccess(
    runner,
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      BLOCK_LABEL,
      "-R",
      REPOSITORY,
      "--json",
      "number,title,body",
    ],
    root,
  );
  const issues = JSON.parse(raw) as ReadonlyArray<{ number: number; title: string; body: string }>;
  if (issues.length !== 1)
    throw new Error(`expected exactly one open ${BLOCK_LABEL} issue, found ${issues.length}`);
  const issue = issues[0];
  if (issue === undefined) throw new Error("blocked issue disappeared");
  requireSuccess(
    runner,
    "gh",
    ["issue", "view", String(issue.number), "--comments", "-R", REPOSITORY],
    root,
  );
  return issue;
};

const releaseTags = (
  runner: CommandRunner,
  root: string,
  blockingSha: string,
): ReadonlyArray<{ tag: string; sha: string }> => {
  const tags = lines(git(runner, root, ["tag", "--list", "v*", "--sort=-version:refname"])).filter(
    (tag) => STABLE_TAG.test(tag) || NIGHTLY_TAG.test(tag),
  );
  return tags.flatMap((tag) => {
    const sha = git(runner, root, ["rev-parse", `${tag}^{commit}`]);
    const beyond =
      runner.run("git", ["merge-base", "--is-ancestor", blockingSha, sha], root).status === 0;
    const upstream =
      runner.run("git", ["merge-base", "--is-ancestor", sha, "upstream/main"], root).status === 0;
    return beyond && upstream ? [{ tag, sha }] : [];
  });
};

const defaultReportPath = (): string =>
  NodePath.join(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-")), "report.json");

const unblockList = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--output"]);
  const root = rootFor(runner, cwd);
  requireSuccess(runner, "node", ["scripts/fork-preflight.ts"], root);
  const issue = readIssue(runner, root);
  const blockingSha = extractBlockingSha(issue.body);
  if (blockingSha === null)
    throw new Error(`blocked issue ${issue.number} has no full blocking-sha marker`);
  requireSuccess(runner, "node", ["scripts/fork-upstream-watch.ts"], root);
  const candidates = releaseTags(runner, root, blockingSha);
  if (candidates.length === 0)
    throw new Error(`no upstream release tag contains blocking commit ${blockingSha}`);
  const reportPath = externalPath(root, values.get("--output") ?? defaultReportPath());
  const report: SyncReport = {
    schemaVersion: 1,
    stage: "listed",
    repositoryRoot: root,
    reportPath,
    recordPath: NodePath.join(NodePath.dirname(reportPath), "record.md"),
    issue: { number: issue.number, blockingSha, title: issue.title },
    candidates,
    conflicts: [],
    verification: [],
  };
  writeReport(report);
  writeRecord(report);
  process.stdout.write(
    `${reportPath}\nStop. Ask the human to select one listed target:\n${candidates.map(({ tag, sha }) => `  ${tag}@${sha}`).join("\n")}\n`,
  );
  return report;
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

const unblockOrient = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report", "--target"]);
  const report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage !== "listed")
    throw new Error(`unblock-orient requires a listed report, got ${report.stage}`);
  const targetTag = oneValue(values, "--target") ?? "";
  const offered = report.candidates.find(({ tag }) => tag === targetTag);
  if (offered === undefined) throw new Error(`target ${targetTag} was not offered by unblock-list`);
  const root = report.repositoryRoot;
  requireSuccess(runner, "node", ["scripts/fork-preflight.ts"], root);
  const issue = readIssue(runner, root);
  if (
    issue.number !== report.issue.number ||
    extractBlockingSha(issue.body) !== report.issue.blockingSha
  )
    throw new Error("blocked issue changed since unblock-list; start again");
  const liveTarget = git(runner, root, ["rev-parse", `refs/tags/${targetTag}^{commit}`]);
  if (liveTarget !== offered.sha) throw new Error(`target ${targetTag} moved since unblock-list`);
  const expectedOld = git(runner, root, ["rev-parse", "origin/hyprws^{commit}"]);
  const sharedBase = git(runner, root, ["merge-base", expectedOld, liveTarget]);
  const orientation = requireSuccess(
    runner,
    "node",
    ["scripts/fork-orient.ts", "--target", targetTag],
    root,
  );
  const next: SyncReport = {
    ...report,
    stage: "oriented",
    target: { tag: targetTag, sha: liveTarget },
    source: { sha: expectedOld, expectedOld, sharedBase },
    orientation,
    touchedPaths: orientationTouchedPaths(orientation),
    conflicts: orientationDecisionRows(orientation),
  };
  writeReport(next);
  writeRecord(next);
  process.stdout.write(`${next.reportPath}\n${orientation}\n`);
  return next;
};

const wtPath = (raw: string): string => {
  const value = JSON.parse(raw) as Record<string, unknown>;
  for (const key of ["worktree_path", "worktreePath", "path"])
    if (typeof value[key] === "string") return value[key] as string;
  throw new Error("Worktrunk JSON omitted the worktree path");
};

const replayMessages = (runner: CommandRunner, cwd: string, range: string): string =>
  gitRaw(runner, cwd, ["log", "--reverse", "--topo-order", "--format=%B%x1e", range], true);
const currentCommit = (
  runner: CommandRunner,
  cwd: string,
): { sha: string; subject: string; domain: string } => {
  const raw = git(
    runner,
    cwd,
    ["show", "-s", "--format=%H%x1f%s%x1f%(trailers:key=Fork-Domain,valueonly)", "REBASE_HEAD"],
    true,
  );
  const [sha = "", subject = "", domain = "?"] = raw.split("\x1f");
  return { sha, subject, domain: domain.trim() || "?" };
};

const pendingConflicts = (runner: CommandRunner, cwd: string): ReadonlyArray<string> =>
  lines(git(runner, cwd, ["diff", "--name-only", "--diff-filter=U"], true));

const verifyReplay = (report: SyncReport, runner: CommandRunner): void => {
  if (
    report.target === undefined ||
    report.originalMessages === undefined ||
    report.originalCount === undefined ||
    report.lane === undefined
  )
    throw new Error("replay binding is incomplete");
  const count = Number(
    git(runner, report.lane.worktree, ["rev-list", "--count", `${report.target.sha}..HEAD`], true),
  );
  if (count !== report.originalCount)
    throw new Error(`replay commit count changed: ${report.originalCount} -> ${count}`);
  const messages = replayMessages(runner, report.lane.worktree, `${report.target.sha}..HEAD`);
  if (messages !== report.originalMessages) throw new Error("replay commit messages changed");
};

const unblockRehearse = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report"]);
  let report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage === "oriented") {
    if (report.target === undefined || report.source === undefined)
      throw new Error("orientation binding is incomplete");
    const target = report.target;
    const source = report.source;
    requireSuccess(runner, "node", ["scripts/fork-preflight.ts"], report.repositoryRoot);
    const live = git(runner, report.repositoryRoot, ["rev-parse", "origin/hyprws^{commit}"]);
    if (live !== source.expectedOld)
      throw new Error("origin/hyprws moved after orientation; start a new rehearsal");
    const branch = `rehearse/${target.tag}-from-${source.expectedOld.slice(0, 12)}`;
    if (
      runner.run(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        report.repositoryRoot,
      ).status === 0
    )
      throw new Error(`rehearsal lane already exists: ${branch}; inspect it instead of colliding`);
    const originalMessages = replayMessages(
      runner,
      report.repositoryRoot,
      `${source.sharedBase}..${source.expectedOld}`,
    );
    const originalCount = Number(
      git(
        runner,
        report.repositoryRoot,
        ["rev-list", "--count", `${source.sharedBase}..${source.expectedOld}`],
        true,
      ),
    );
    const worktree = wtPath(
      requireSuccess(
        runner,
        "wt",
        [
          "switch",
          "--create",
          branch,
          "--base",
          source.expectedOld,
          "--no-cd",
          "--format",
          "json",
          "--yes",
        ],
        report.repositoryRoot,
      ),
    );
    requireSuccess(runner, "vp", ["i"], worktree);
    git(runner, worktree, ["restore", "--source=HEAD", "--worktree", "--", "pnpm-lock.yaml"], true);
    report = { ...report, lane: { branch, worktree }, originalMessages, originalCount };
    const rebase = runner.run(
      "git",
      ["-c", "core.commentChar=auto", "rebase", target.sha],
      worktree,
      undefined,
      { ...process.env, ...COMMENT_CONFIG, GIT_EDITOR: "true" },
    );
    if (rebase.status !== 0 && pendingConflicts(runner, worktree).length === 0)
      throw new Error(`git rebase failed without conflicts: ${rebase.stderr.trim()}`);
  } else if (report.stage === "conflicts") {
    if (report.lane === undefined) throw new Error("rehearsal lane is missing");
    const lane = report.lane;
    const recordRows = parseConflictRows(NodeFS.readFileSync(report.recordPath, "utf8"));
    const pending = report.conflicts.filter(
      (row) =>
        row.resolution === "TODO" ||
        row.agentSafe === "TODO" ||
        row.agentSafe === "pending regeneration",
    );
    for (const row of pending.filter(({ class: klass }) => klass !== "generated")) {
      const edited = recordRows.find(
        (candidate) => candidate.path === row.path && candidate.subject === row.subject,
      );
      if (
        edited === undefined ||
        edited.class === "TODO" ||
        edited.resolution === "TODO" ||
        edited.agentSafe === "TODO"
      )
        throw new Error(`record row remains incomplete for ${row.path}`);
    }
    const staged = new Set(
      lines(git(runner, lane.worktree, ["diff", "--cached", "--name-only"], true)),
    );
    for (const row of pending.filter(({ path }) => path !== "pnpm-lock.yaml"))
      if (!staged.has(row.path)) throw new Error(`resolved conflict is not staged: ${row.path}`);
    if (pending.some(({ path }) => path === "pnpm-lock.yaml")) {
      git(
        runner,
        lane.worktree,
        ["restore", "--source=HEAD", "--staged", "--worktree", "--", "pnpm-lock.yaml"],
        true,
      );
      requireSuccess(runner, "vp", ["install", "--lockfile-only"], lane.worktree);
      git(runner, lane.worktree, ["add", "pnpm-lock.yaml"], true);
    }
    report = {
      ...report,
      conflicts: report.conflicts.map((row) => {
        if (pending.includes(row) && row.class === "generated")
          return { ...row, agentSafe: "yes — regenerated by unblock-rehearse" };
        return (
          recordRows.find((edited) => edited.path === row.path && edited.subject === row.subject) ??
          row
        );
      }),
    };
    const continued = runner.run(
      "git",
      ["-c", "core.commentChar=auto", "rebase", "--continue"],
      lane.worktree,
      undefined,
      { ...process.env, ...COMMENT_CONFIG, GIT_EDITOR: "true" },
    );
    if (continued.status !== 0 && pendingConflicts(runner, lane.worktree).length === 0)
      throw new Error(`git rebase --continue failed without conflicts: ${continued.stderr.trim()}`);
  } else
    throw new Error(`unblock-rehearse requires oriented or conflicts state, got ${report.stage}`);

  if (report.lane === undefined) throw new Error("rehearsal lane is missing");
  const conflicts = pendingConflicts(runner, report.lane.worktree);
  if (conflicts.length > 0) {
    const commit = currentCommit(runner, report.lane.worktree);
    const additions = conflicts.map(
      (path): ConflictRow => ({
        ...commit,
        commit: commit.sha,
        path,
        class: path === "pnpm-lock.yaml" ? "generated" : "TODO",
        resolution: path === "pnpm-lock.yaml" ? "restore HEAD and regenerate" : "TODO",
        agentSafe: path === "pnpm-lock.yaml" ? "pending regeneration" : "TODO",
      }),
    );
    report = { ...report, stage: "conflicts", conflicts: [...report.conflicts, ...additions] };
    writeReport(report);
    writeRecord(report);
    process.stdout.write(
      `${report.reportPath}\nStop. Resolve and stage non-generated files, complete every TODO row in ${report.recordPath}, then rerun unblock-rehearse.\n`,
    );
    return report;
  }
  verifyReplay(report, runner);
  const rebasedHead = git(runner, report.lane.worktree, ["rev-parse", "HEAD"], true);
  const stackSize = Number(
    git(
      runner,
      report.lane.worktree,
      ["rev-list", "--count", `${report.target?.sha ?? ""}..HEAD`],
      true,
    ),
  );
  report = { ...report, stage: "replayed", rebasedHead, stackSize };
  writeReport(report);
  writeRecord(report);
  process.stdout.write(
    `${report.reportPath}\nStop. Replay complete; review conflict rows before unblock-check.\n`,
  );
  return report;
};

const section = (text: string, heading: string): string => {
  const start = text.indexOf(`${heading}\n`);
  if (start === -1) return "";
  const rest = text.slice(start + heading.length + 1);
  const next = /^\S[^:\n]*:\s*$/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
};

export const lockDriftClass = (
  before: string,
  after: string,
): "none" | "importers" | "snapshots" => {
  if (before === after) return "none";
  return section(before, "importers:") === section(after, "importers:") ? "snapshots" : "importers";
};

const readHeadFile = (runner: CommandRunner, cwd: string, path: string): string =>
  gitRaw(runner, cwd, ["show", `HEAD:${path}`], true);
const restoreSnapshotDrift = (runner: CommandRunner, cwd: string): void => {
  git(runner, cwd, ["restore", "--source=HEAD", "--worktree", "--", "pnpm-lock.yaml"], true);
};

const touchedChecks = (
  runner: CommandRunner,
  report: SyncReport,
): { workspaces: ReadonlyArray<{ path: string; name: string }>; tests: ReadonlyArray<string> } => {
  if (report.lane === undefined) return { workspaces: [], tests: [] };
  const paths = [
    ...new Set([...report.conflicts.map((row) => row.path), ...(report.touchedPaths ?? [])]),
  ].filter((path) => path !== "orientation retire signal");
  const packages = new Map<string, { path: string; name: string }>();
  const tests = new Set<string>();
  const tracked = lines(git(runner, report.lane.worktree, ["ls-files"]));
  for (const path of paths) {
    let directory = NodePath.dirname(path);
    while (directory !== "." && directory !== "/") {
      const packagePath = NodePath.join(report.lane.worktree, directory, "package.json");
      if (NodeFS.existsSync(packagePath)) {
        const parsed = JSON.parse(NodeFS.readFileSync(packagePath, "utf8")) as {
          name?: string;
          scripts?: { typecheck?: string };
        };
        if (parsed.name && parsed.scripts?.typecheck)
          packages.set(directory, { path: directory, name: parsed.name });
        break;
      }
      directory = NodePath.dirname(directory);
    }
    const extension = NodePath.extname(path);
    const stem = path.slice(0, -extension.length);
    for (const candidate of tracked)
      if (candidate.startsWith(`${stem}.test.`) || (candidate === path && /\.test\./.test(path)))
        tests.add(candidate);
  }
  return {
    workspaces: [...packages.values()].toSorted((a, b) => a.path.localeCompare(b.path)),
    tests: [...tests].toSorted(),
  };
};

const unblockCheck = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report"]);
  let report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage !== "replayed")
    throw new Error(`unblock-check requires replayed state, got ${report.stage}`);
  if (report.lane === undefined || report.target === undefined)
    throw new Error("replay binding is incomplete");
  verifyReplay(report, runner);
  const worktree = report.lane.worktree;
  const before = readHeadFile(runner, worktree, "pnpm-lock.yaml");
  requireSuccess(runner, "vp", ["install", "--lockfile-only"], worktree);
  const after = NodeFS.readFileSync(NodePath.join(worktree, "pnpm-lock.yaml"), "utf8");
  const drift = lockDriftClass(before, after);
  if (drift === "importers") {
    const owners = lines(
      git(
        runner,
        worktree,
        [
          "log",
          "--format=%s",
          `${report.target.sha}..HEAD`,
          "--",
          "package.json",
          ":(glob)**/package.json",
        ],
        true,
      ),
    );
    throw new Error(
      `pnpm-lock.yaml importer drift must be folded into its manifest-owning fork commit; candidates: ${owners.join(" | ") || "none"}`,
    );
  }
  if (drift === "snapshots") restoreSnapshotDrift(runner, worktree);
  requireSuccess(runner, "vp", ["i"], worktree);
  const installedAfter = NodeFS.readFileSync(NodePath.join(worktree, "pnpm-lock.yaml"), "utf8");
  if (lockDriftClass(before, installedAfter) === "importers")
    throw new Error("vp i introduced importer drift after replay");
  if (installedAfter !== before) restoreSnapshotDrift(runner, worktree);
  const installedHead = git(runner, worktree, ["rev-parse", "HEAD"], true);
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [
    { command: "vp", args: ["run", "fork:scan", "--target", report.target.tag] },
    { command: "vp", args: ["run", "fork:delta", "--check"] },
  ];
  const checks = touchedChecks(runner, report);
  for (const workspace of checks.workspaces)
    commands.push({ command: "vp", args: ["run", "--filter", workspace.name, "typecheck"] });
  if (checks.tests.length > 0)
    commands.push({ command: "vp", args: ["test", "run", ...checks.tests] });
  const verification: Array<{ command: string; result: string }> = [];
  for (const command of commands) {
    requireSuccess(runner, command.command, command.args, worktree);
    verification.push({ command: commandText(command.command, command.args), result: "passed" });
  }
  if (git(runner, worktree, ["rev-parse", "HEAD"], true) !== installedHead)
    throw new Error("HEAD changed after the installed-tree check");
  report = { ...report, stage: "checked", installedHead, verification };
  writeReport(report);
  writeRecord(report);
  process.stdout.write(
    `${report.reportPath}\n${decisionSurface(NodeFS.readFileSync(report.recordPath, "utf8"))}`,
  );
  return report;
};

export const decisionSurface = (record: string): string => {
  const rows = record.split("\n").filter((line) => {
    if (!/^\| `.+` \|/.test(line)) return false;
    const classSummary = line.split("|")[3] ?? "";
    return /\b(?:retire-candidate|human)\b/.test(classSummary);
  });
  const grounding = record.split("\n").filter((line) => /^Grounding (?:claim|pending):/.test(line));
  return [
    "## Gate 4 decision surface",
    ...rows,
    ...grounding,
    "Stop. Obtain every decision, grounding confirmation, login/date, and explicit go.",
    "",
  ].join("\n");
};

export const validateSignedRecord = (record: string, report: SyncReport): void => {
  const sanity = /^- Human sanity: ([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})) (\d{4}-\d{2}-\d{2})$/m.exec(
    record,
  );
  if (sanity === null || Number.isNaN(new Date(`${sanity[2]}T00:00:00Z`).valueOf()))
    throw new Error("record is missing Human sanity: <login> YYYY-MM-DD");
  if (/^Grounding pending:/m.test(record)) throw new Error("record still has pending grounding");
  for (const line of decisionSurface(record)
    .split("\n")
    .filter((row) => row.startsWith("|"))) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (!["keep", "retire", "partial"].includes(cells[4] ?? ""))
      throw new Error(`decision row has no keep/retire/partial action: ${line}`);
  }
  if (report.installedHead === undefined) throw new Error("report has no checked installed head");
};

const unblockApply = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report", "--record"]);
  let report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage !== "checked")
    throw new Error(`unblock-apply requires checked state, got ${report.stage}`);
  const recordPath = NodePath.resolve(oneValue(values, "--record") ?? "");
  if (recordPath !== NodePath.resolve(report.recordPath))
    throw new Error("record path does not match the report binding");
  const record = NodeFS.readFileSync(recordPath, "utf8");
  validateSignedRecord(record, report);
  if (report.lane === undefined || report.target === undefined || report.source === undefined)
    throw new Error("apply binding is incomplete");
  const lane = report.lane;
  const target = report.target;
  const source = report.source;
  const worktree = lane.worktree;
  if (git(runner, worktree, ["rev-parse", "HEAD"], true) !== report.installedHead)
    throw new Error("checked rehearsal head moved; rerun unblock-check");
  requireSuccess(runner, "vp", ["run", "fork:upstream-refs", recordPath], worktree);
  const gateArgs = [
    "run",
    "fork:sync-gate",
    "--tag",
    target.tag,
    "--record",
    recordPath,
    ...(NIGHTLY_TAG.test(target.tag) ? ["--allow-nightly"] : []),
  ];
  requireSuccess(runner, "vp", gateArgs, worktree);
  const recordCommentUrl = requireSuccess(
    runner,
    "gh",
    ["issue", "comment", String(report.issue.number), "-R", REPOSITORY, "--body-file", recordPath],
    worktree,
  ).trim();
  const push = runner.run(
    "git",
    [
      "-c",
      "core.commentChar=auto",
      "push",
      `--force-with-lease=refs/heads/hyprws:${source.expectedOld}`,
      "origin",
      "HEAD:refs/heads/hyprws",
    ],
    worktree,
    undefined,
    { ...process.env, ...COMMENT_CONFIG },
  );
  if (push.status !== 0)
    throw new Error(`leased apply refused; this report cannot be refreshed: ${push.stderr.trim()}`);
  requireSuccess(
    runner,
    "gh",
    [
      "issue",
      "comment",
      String(report.issue.number),
      "-R",
      REPOSITORY,
      "--body",
      `Resolved blocking upstream commit \`${report.issue.blockingSha}\` while rebasing \`hyprws\` onto \`${target.tag}\`; the leased rewrite replaced \`${source.expectedOld}\`. Rehearsal record: ${recordCommentUrl}`,
    ],
    worktree,
  );
  report = { ...report, stage: "applied", recordCommentUrl };
  writeReport(report);
  process.stdout.write(`applied: ${target.tag} with lease ${source.expectedOld}\n`);
  return report;
};

export const execute = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  runner: CommandRunner = new SystemRunner(),
): SyncReport => {
  const { verb, values } = parseVerbArgs(argv);
  if (verb === "unblock-list") return unblockList(values, cwd, runner);
  if (verb === "unblock-orient") return unblockOrient(values, cwd, runner);
  if (verb === "unblock-rehearse") return unblockRehearse(values, cwd, runner);
  if (verb === "unblock-check") return unblockCheck(values, cwd, runner);
  if (verb === "unblock-apply") return unblockApply(values, cwd, runner);
  throw new UsageError(`unknown verb: ${verb}`);
};

export const run = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  runner: CommandRunner = new SystemRunner(),
): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    execute(argv, cwd, runner);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    process.stderr.write(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
