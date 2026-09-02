#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Operator state machine runs before Effect exists.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { UsageError } from "./lib/fork-cli.ts";
import {
  requireCommandSuccess,
  SystemCommandRunner as SystemRunner,
  type CommandResult,
  type CwdCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";

export {
  SystemCommandRunner as SystemRunner,
  type CommandResult,
  type CwdCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";
import {
  FORK_REPOSITORY,
  HYPRWS_REF,
  isNightlyUpstreamTag,
  positionUpstreamReleaseTags,
  selectNewestReleaseTag,
} from "./lib/fork-policy.ts";
import { parseForkTrailers } from "./lib/fork-trailers.ts";

import { executeStable } from "./fork-sync-stable.ts";
import {
  assertOnly,
  BLOCK_LABEL,
  commandText,
  COMMENT_CONFIG,
  externalPath,
  extractBlockingSha,
  git,
  gitRaw,
  lines,
  NO_GROUNDING_CLAIM,
  oneValue,
  orientationDecisionRows,
  orientationTouchedPaths,
  parseConflictRows,
  parseDecisionRows,
  parseVerbArgs,
  renderRecord,
  readReport,
  REPOSITORY,
  requireSuccess,
  rootFor,
  SYNC_HELP,
  writeRecord,
  writeReport,
  worktreePath,
  type BotMode,
  type BotRun,
  type BotSnapshot,
  type ConflictRow,
  type SilentSeam,
  type SyncReport,
} from "./fork-sync-state.ts";

export {
  NO_GROUNDING_CLAIM,
  orientationDecisionRows,
  orientationTouchedPaths,
  parseConflictRows,
  renderRecord,
  validateReport,
  type BotMode,
  type BotRun,
  type BotSnapshot,
  type ConflictClass,
  type ConflictRow,
  type OrientationDecisionRow,
  type OrientationVerdict,
  type SilentSeam,
  type SyncReport,
  type SyncStage,
} from "./fork-sync-state.ts";

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
  const firstParentShas = lines(
    git(runner, root, ["rev-list", "--first-parent", "--reverse", "upstream/main"]),
  );
  const blockingPosition = firstParentShas.indexOf(blockingSha);
  if (blockingPosition === -1) return [];
  const tags = positionUpstreamReleaseTags(
    { run: (args) => git(runner, root, args) },
    firstParentShas,
  ).filter(({ position }) => position >= blockingPosition);
  return tags
    .toSorted((left, right) => {
      const newest = selectNewestReleaseTag([left, right]);
      return newest === left ? -1 : 1;
    })
    .map(({ tag, sha }) => ({ tag, sha }));
};

const defaultReportPath = (): string =>
  NodePath.join(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-")), "report.json");

const BOT_VARIABLE = "HYPRWS_AUTO_REBASE";
const BOT_WORKFLOW = "hyprws-upstream-sync.yml";

const readBotMode = (runner: CommandRunner, root: string): BotMode => {
  const args = ["variable", "get", BOT_VARIABLE, "--repo", REPOSITORY];
  const result = runner.run("gh", args, root);
  if (result.status !== 0 || result.error !== undefined) {
    const detail = `${result.stdout}\n${result.stderr}`;
    if (/\b(?:HTTP 404|not found)\b/i.test(detail)) return "candidate";
    requireCommandSuccess(result, "gh", args);
  }
  const mode = result.stdout.trim();
  if (mode !== "off" && mode !== "candidate" && mode !== "on")
    throw new Error(`${BOT_VARIABLE} has unsupported mode: ${mode || "empty"}`);
  return mode;
};

const cronField = (field: string, minimum: number, maximum: number): ReadonlySet<number> => {
  const values = new Set<number>();
  for (const segment of field.split(",")) {
    const parts = segment.split("/");
    if (parts.length > 2) throw new Error(`unsupported cron field: ${field}`);
    const range = parts[0] ?? "";
    const step = parts[1] === undefined ? 1 : Number(parts[1]);
    if (!Number.isInteger(step) || step < 1) throw new Error(`unsupported cron field: ${field}`);
    let start: number;
    let end: number;
    if (range === "*") {
      start = minimum;
      end = maximum;
    } else if (range.includes("-")) {
      const bounds = range.split("-");
      if (bounds.length !== 2) throw new Error(`unsupported cron field: ${field}`);
      start = Number(bounds[0]);
      end = Number(bounds[1]);
    } else {
      start = Number(range);
      end = start;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < minimum ||
      end > maximum ||
      start > end
    )
      throw new Error(`unsupported cron field: ${field}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
};

export const nextScheduledFire = (cron: string, now = new Date()): string => {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`expected a five-field cron, got: ${cron}`);
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  const minutes = cronField(minute, 0, 59);
  const hours = cronField(hour, 0, 23);
  const monthDays = cronField(dayOfMonth, 1, 31);
  const months = cronField(month, 1, 12);
  const weekDays = new Set([...cronField(dayOfWeek, 0, 7)].map((value) => value % 7));
  const monthDayWildcard = dayOfMonth === "*";
  const weekDayWildcard = dayOfWeek === "*";
  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60 * 5;
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const monthDayMatches = monthDays.has(candidate.getUTCDate());
    const weekDayMatches = weekDays.has(candidate.getUTCDay());
    const dayMatches =
      monthDayWildcard && weekDayWildcard
        ? true
        : monthDayWildcard
          ? weekDayMatches
          : weekDayWildcard
            ? monthDayMatches
            : monthDayMatches || weekDayMatches;
    if (
      minutes.has(candidate.getUTCMinutes()) &&
      hours.has(candidate.getUTCHours()) &&
      months.has(candidate.getUTCMonth() + 1) &&
      dayMatches
    )
      return candidate.toISOString();
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error(`cron has no fire in the next five years: ${cron}`);
};

const workflowCron = (root: string): string => {
  const workflow = NodeFS.readFileSync(
    NodePath.join(root, ".github", "workflows", BOT_WORKFLOW),
    "utf8",
  );
  const cron = /^\s*-\s+cron:\s*["']([^"']+)["']\s*$/m.exec(workflow)?.[1];
  if (cron === undefined) throw new Error(`${BOT_WORKFLOW} has no quoted schedule cron`);
  return cron;
};

const readBotSnapshot = (runner: CommandRunner, root: string): BotSnapshot => {
  const mode = readBotMode(runner, root);
  const rawRuns = requireSuccess(
    runner,
    "gh",
    [
      "run",
      "list",
      "--workflow",
      BOT_WORKFLOW,
      "-L",
      "1",
      "--json",
      "status,conclusion,createdAt,url",
      "--repo",
      REPOSITORY,
    ],
    root,
  );
  const runs = JSON.parse(rawRuns) as ReadonlyArray<BotRun>;
  const lastRun = runs[0] ?? null;
  return { mode, lastRun, nextFire: nextScheduledFire(workflowCron(root)) };
};

const botIsRunning = (bot: BotSnapshot): boolean =>
  bot.lastRun !== null &&
  ["queued", "waiting", "requested", "pending", "in_progress"].includes(bot.lastRun.status);

export const renderBotSnapshot = (bot: BotSnapshot): string => {
  const last =
    bot.lastRun === null
      ? "none"
      : [bot.lastRun.status, bot.lastRun.conclusion, bot.lastRun.createdAt, bot.lastRun.url]
          .filter((value): value is string => value !== null && value.length > 0)
          .join(" ");
  return [
    "bot:",
    `  mode: ${bot.mode}`,
    `  last run: ${last}`,
    `  next fire: ${bot.nextFire}`,
    ...(botIsRunning(bot) ? ["  RUNNING"] : []),
  ].join("\n");
};

const requirePausedBot = (bot: BotSnapshot): void => {
  if (bot.mode === "on")
    throw new Error(
      [
        "auto-rebase bot mode is on; pause it before continuing:",
        `gh variable set ${BOT_VARIABLE} --body candidate --repo ${REPOSITORY}`,
      ].join("\n"),
    );
  if (botIsRunning(bot))
    throw new Error("bot run is in progress; wait for it and rerun unblock-list");
};

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
  const bot = readBotSnapshot(runner, root);
  const reportPath = externalPath(root, values.get("--output") ?? defaultReportPath());
  const report: SyncReport = {
    schemaVersion: 1,
    stage: "listed",
    repositoryRoot: root,
    reportPath,
    recordPath: NodePath.join(NodePath.dirname(reportPath), "record.md"),
    issue: { number: issue.number, blockingSha, title: issue.title },
    candidates,
    bot,
    conflicts: [],
    verification: [],
  };
  writeReport(report);
  writeRecord(report);
  process.stdout.write(
    `${reportPath}\nStop. Ask the human to select one listed target:\n${candidates.map(({ tag, sha }) => `  ${tag}@${sha}`).join("\n")}\n${renderBotSnapshot(bot)}\n`,
  );
  return report;
};

export const resolveUnblockTarget = (
  candidates: ReadonlyArray<{ readonly tag: string; readonly sha: string }>,
  target: string,
): { readonly tag: string; readonly sha: string } => {
  const bare = candidates.find(({ tag }) => tag === target);
  if (bare !== undefined) return bare;

  const separator = target.lastIndexOf("@");
  const targetTag = separator === -1 ? target : target.slice(0, separator);
  const givenSha = separator === -1 ? "" : target.slice(separator + 1);
  const offered = candidates.find(({ tag }) => tag === targetTag);
  if (offered !== undefined) {
    const normalizedGiven = givenSha.toLowerCase();
    const matchingShas = new Set(
      candidates
        .map(({ sha }) => sha.toLowerCase())
        .filter((sha) => sha.startsWith(normalizedGiven)),
    );
    const isFullSha = normalizedGiven === offered.sha.toLowerCase();
    const isUniquePrefix =
      /^[0-9a-f]{7,40}$/i.test(givenSha) &&
      offered.sha.toLowerCase().startsWith(normalizedGiven) &&
      matchingShas.size === 1;
    if (isFullSha || isUniquePrefix) return offered;
    throw new Error(`target ${targetTag} was offered at ${offered.sha}, not ${givenSha}`);
  }

  const accepted = candidates.flatMap(({ tag, sha }) => [tag, `${tag}@${sha}`]).join(", ");
  throw new Error(`target ${target} was not offered by unblock-list; accepted forms: ${accepted}`);
};

const unblockOrient = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report", "--target"]);
  const report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage !== "listed")
    throw new Error(`unblock-orient requires a listed report, got ${report.stage}`);
  if (report.bot === undefined) throw new Error("report has no bot snapshot; rerun unblock-list");
  requirePausedBot(report.bot);
  const offered = resolveUnblockTarget(report.candidates, oneValue(values, "--target") ?? "");
  const targetTag = offered.tag;
  const root = report.repositoryRoot;
  requireSuccess(runner, "node", ["scripts/fork-preflight.ts", "--tag-pinned"], root);
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
    orientationDecisions: orientationDecisionRows(orientation),
    touchedPaths: orientationTouchedPaths(orientation),
  };
  writeReport(next);
  writeRecord(next);
  process.stdout.write(`${next.reportPath}\n${orientation}\n`);
  return next;
};

const replayMessages = (runner: CommandRunner, cwd: string, range: string): string =>
  gitRaw(runner, cwd, ["log", "--reverse", "--topo-order", "--format=%B%x1e", range], true);
const currentCommit = (
  runner: CommandRunner,
  cwd: string,
): { sha: string; subject: string; domain: string } => {
  const raw = git(runner, cwd, ["show", "-s", "--format=%H%x1f%s%x1f%b", "REBASE_HEAD"], true);
  const [sha = "", subject = "", body = ""] = raw.split("\x1f");
  return { sha, subject, domain: parseForkTrailers(body).domain ?? "?" };
};

const pendingConflicts = (runner: CommandRunner, cwd: string): ReadonlyArray<string> =>
  lines(git(runner, cwd, ["diff", "--name-only", "--diff-filter=U"], true));

export const rehearsalRebaseArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "-c",
  "core.commentChar=auto",
  "-c",
  "rerere.enabled=true",
  "-c",
  "rerere.autoupdate=false",
  ...args,
];

export const identifyRerereResolvedPaths = (
  conflicts: ReadonlyArray<string>,
  remaining: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const unresolved = new Set(remaining);
  return conflicts.filter((path) => !unresolved.has(path));
};

const rerereResolvedPaths = (
  runner: CommandRunner,
  cwd: string,
  conflicts: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  identifyRerereResolvedPaths(
    conflicts,
    lines(git(runner, cwd, ["-c", "rerere.enabled=true", "rerere", "remaining"], true)),
  );

/** unblock-rehearse owns these paths end to end: it restores HEAD and regenerates them itself. */
const isGeneratedPath = (path: string): boolean => path === "pnpm-lock.yaml";

export const rehearsalConflictRows = (
  commit: { readonly sha: string; readonly subject: string; readonly domain: string },
  conflicts: ReadonlyArray<string>,
  rerereResolved: ReadonlyArray<string>,
): ReadonlyArray<ConflictRow> => {
  const reused = new Set(rerereResolved);
  return conflicts.map((path) => ({
    ...commit,
    commit: commit.sha,
    path,
    class: isGeneratedPath(path) ? "generated" : "TODO",
    resolution: isGeneratedPath(path)
      ? "restore HEAD and regenerate"
      : reused.has(path)
        ? "review rerere's recorded resolution and stage"
        : "TODO",
    agentSafe: isGeneratedPath(path) ? "pending regeneration" : "TODO",
    decidedBy: "human",
  }));
};

export const rehearsalConflictStop = (
  reportPath: string,
  recordPath: string,
  commit: { readonly sha: string; readonly subject: string },
  conflicts: ReadonlyArray<string>,
  rerereResolved: ReadonlyArray<string> = [],
): string => {
  const reused = new Set(rerereResolved);
  const header = [
    reportPath,
    `Stop. Rebase conflict in ${commit.subject} (${commit.sha.slice(0, 12)}).`,
    "Conflicted paths:",
  ];
  // A generated-only conflict owes the human nothing: there is no file to resolve and no TODO row.
  if (conflicts.every(isGeneratedPath))
    return [
      ...header,
      ...conflicts.map(
        (path) =>
          `  - ${path} (generated${reused.has(path) ? "; rerere's recorded resolution is discarded" : ""})`,
      ),
      "Nothing to resolve or record. Rerun unblock-rehearse; it restores HEAD, regenerates the lockfile, and continues.",
      "",
    ].join("\n");
  const action =
    reused.size === 0
      ? "Resolve and stage non-generated files"
      : "Review and stage rerere-resolved files; resolve and stage remaining non-generated files";
  return [
    ...header,
    ...conflicts.map(
      (path) =>
        `  - ${path}${reused.has(path) ? " (rerere reused a recorded resolution; review before staging)" : ""}`,
    ),
    `${action}, complete every TODO row in ${recordPath}, then rerun unblock-rehearse.`,
    "",
  ].join("\n");
};

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
    requireSuccess(
      runner,
      "node",
      ["scripts/fork-preflight.ts", "--tag-pinned"],
      report.repositoryRoot,
    );
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
    const worktree = worktreePath(
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
    // A minted lane has no node_modules, and the first gate battery would fail
    // on module resolution before it ever reached a verdict.
    requireSuccess(runner, "vp", ["i"], worktree, undefined, laneEnv(worktree));
    git(runner, worktree, ["restore", "--source=HEAD", "--worktree", "--", "pnpm-lock.yaml"], true);
    report = { ...report, lane: { branch, worktree }, originalMessages, originalCount };
    const rebase = runner.run(
      "git",
      rehearsalRebaseArgs(["rebase", target.sha]),
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
    for (const row of pending.filter(({ path }) => !isGeneratedPath(path)))
      if (!staged.has(row.path)) throw new Error(`resolved conflict is not staged: ${row.path}`);
    if (pending.some(({ path }) => isGeneratedPath(path))) {
      git(
        runner,
        lane.worktree,
        ["restore", "--source=HEAD", "--staged", "--worktree", "--", "pnpm-lock.yaml"],
        true,
      );
      requireSuccess(
        runner,
        "vp",
        ["install", "--lockfile-only"],
        lane.worktree,
        undefined,
        laneEnv(lane.worktree),
      );
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
      rehearsalRebaseArgs(["rebase", "--continue"]),
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
    const rerereResolved = rerereResolvedPaths(runner, report.lane.worktree, conflicts);
    const additions = rehearsalConflictRows(commit, conflicts, rerereResolved);
    report = { ...report, stage: "conflicts", conflicts: [...report.conflicts, ...additions] };
    writeReport(report);
    writeRecord(report);
    process.stdout.write(
      rehearsalConflictStop(
        report.reportPath,
        report.recordPath,
        commit,
        conflicts,
        rerereResolved,
      ),
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

const GATE_VERIFICATION_ENV_KEYS = new Set([
  // Vite+'s `node_modules/.bin/vp` shim exports an absolute NODE_PATH into the
  // store of the checkout it belongs to. Inherited, it is a module-resolution
  // fallback the lane never installed, and the nested test runner reads Vite+
  // out of the invoking checkout instead.
  "NODE_PATH",
  "NPM_CONFIG_REGISTRY",
  "VP_ENV_USE_EVAL_ENABLE",
  "VP_NODE_DIST_MIRROR",
  "VP_NODE_SKIP_SIGNATURE_VERIFY",
  "VP_NODE_VERSION",
]);

const isInsideNodeModules = (entry: string): boolean =>
  NodePath.resolve(entry).split(NodePath.sep).includes("node_modules");

/**
 * The lane's own `node_modules/.bin` first, and no other checkout's bin
 * directory at all. A foreign `.bin` on PATH resolves `vp` to that checkout's
 * shim, which then pins module resolution to its store for every process below,
 * so the same verb passes from the lane and fails from the canonical checkout.
 */
export const laneExecutablePath = (inherited: string | undefined, worktree: string): string => {
  const laneBin = NodePath.join(worktree, "node_modules", ".bin");
  const inheritedEntries = (inherited ?? "")
    .split(NodePath.delimiter)
    .filter((entry) => entry.length > 0 && entry !== laneBin && !isInsideNodeModules(entry));
  return [laneBin, ...inheritedEntries].join(NodePath.delimiter);
};

/** The environment every lane command runs under, whatever the verb was invoked from. */
export const gateVerificationEnv = (
  inherited: NodeJS.ProcessEnv,
  worktree: string,
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) =>
        !GATE_VERIFICATION_ENV_KEYS.has(key) &&
        !key.startsWith("npm_") &&
        !key.startsWith("ELECTRON_"),
    ),
  ),
  PATH: laneExecutablePath(inherited.PATH, worktree),
});

const laneEnv = (worktree: string): NodeJS.ProcessEnv => gateVerificationEnv(process.env, worktree);

interface CiRun {
  readonly databaseId: number;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
}

interface CiJob {
  readonly name: string;
  readonly conclusion: string | null;
}

const CI_POLL_SECONDS = 30;
const CI_POLL_LIMIT = 91;

const remoteLaneHead = (runner: CommandRunner, worktree: string, branch: string): string =>
  git(runner, worktree, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], true).split(
    /\s+/,
    1,
  )[0] ?? "";

const failedCiEvidence = (runner: CommandRunner, worktree: string, run: CiRun): string => {
  const jobs = JSON.parse(
    requireSuccess(
      runner,
      "gh",
      ["run", "view", String(run.databaseId), "--json", "jobs", "-R", REPOSITORY],
      worktree,
    ),
  ) as { readonly jobs: ReadonlyArray<CiJob> };
  const failedJobs = jobs.jobs.filter(
    ({ conclusion }) =>
      conclusion !== null && !["success", "skipped", "neutral"].includes(conclusion),
  );
  const log = requireSuccess(
    runner,
    "gh",
    ["run", "view", String(run.databaseId), "--log-failed", "-R", REPOSITORY],
    worktree,
  );
  return [
    `hyprws CI failed: ${run.url}`,
    ...failedJobs.map(({ name }) => {
      const jobLog = log.split("\n").filter((line) => line.startsWith(`${name}\t`));
      return [`Failing job: ${name}`, ...jobLog.slice(-40)].join("\n");
    }),
  ].join("\n");
};

const waitForCiVerdict = (
  runner: CommandRunner,
  worktree: string,
  branch: string,
  head: string,
): CiRun => {
  let printedUrl = false;
  for (let poll = 0; poll < CI_POLL_LIMIT; poll += 1) {
    const runs = JSON.parse(
      requireSuccess(
        runner,
        "gh",
        [
          "run",
          "list",
          "--workflow",
          "hyprws-ci.yml",
          "--branch",
          branch,
          "--json",
          "databaseId,headSha,status,conclusion,url",
          "-R",
          REPOSITORY,
        ],
        worktree,
      ),
    ) as ReadonlyArray<CiRun>;
    const run = runs.find(({ headSha }) => headSha === head);
    if (run !== undefined) {
      if (!printedUrl) {
        process.stdout.write(`${run.url}\n`);
        printedUrl = true;
      }
      if (run.status === "completed") {
        if (run.conclusion !== "success") throw new Error(failedCiEvidence(runner, worktree, run));
        return run;
      }
    }
    if (poll + 1 < CI_POLL_LIMIT)
      requireSuccess(runner, "sleep", [String(CI_POLL_SECONDS)], worktree);
  }
  throw new Error(`hyprws CI timed out after 45 minutes waiting for ${head} on ${branch}`);
};

export const parseSilentSeam = (value: string): SilentSeam => {
  const separator = value.indexOf("=");
  const kindSeparator = value.lastIndexOf(":");
  if (separator < 1 || kindSeparator <= separator + 1)
    throw new UsageError(
      "--silent-seam must be <path>=<summary>:behaviour or <path>=<summary>:type",
    );
  const path = value.slice(0, separator);
  const summary = value.slice(separator + 1, kindSeparator);
  const kind = value.slice(kindSeparator + 1);
  if (kind !== "behaviour" && kind !== "type")
    throw new UsageError(
      "--silent-seam must be <path>=<summary>:behaviour or <path>=<summary>:type",
    );
  return { path, summary, touchesBehaviour: kind === "behaviour" };
};

const unblockCheck = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report", "--silent-seam"]);
  let report = readReport(oneValue(values, "--report") ?? "");
  const silentSeam = oneValue(values, "--silent-seam", false);
  if (report.stage !== "replayed")
    throw new Error(`unblock-check requires replayed state, got ${report.stage}`);
  if (report.lane === undefined || report.target === undefined)
    throw new Error("replay binding is incomplete");
  verifyReplay(report, runner);
  const worktree = report.lane.worktree;
  const verificationEnv = laneEnv(worktree);
  const before = readHeadFile(runner, worktree, "pnpm-lock.yaml");
  requireSuccess(
    runner,
    "vp",
    ["install", "--lockfile-only"],
    worktree,
    undefined,
    verificationEnv,
  );
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
  requireSuccess(runner, "vp", ["i"], worktree, undefined, verificationEnv);
  const installedAfter = NodeFS.readFileSync(NodePath.join(worktree, "pnpm-lock.yaml"), "utf8");
  if (lockDriftClass(before, installedAfter) === "importers")
    throw new Error("vp i introduced importer drift after replay");
  if (installedAfter !== before) restoreSnapshotDrift(runner, worktree);
  const installedHead = git(runner, worktree, ["rev-parse", "HEAD"], true);
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [
    {
      command: "vp",
      args: ["run", "--no-cache", "fork:scan", "--target", report.target.tag],
    },
    { command: "vp", args: ["run", "--no-cache", "fork:delta", "--check"] },
  ];
  const verification: Array<{ command: string; result: string }> = [];
  for (const command of commands) {
    requireSuccess(runner, command.command, command.args, worktree, undefined, verificationEnv);
    verification.push({ command: commandText(command.command, command.args), result: "passed" });
  }
  if (git(runner, worktree, ["rev-parse", "HEAD"], true) !== installedHead)
    throw new Error("HEAD changed after the installed-tree check");
  git(
    runner,
    worktree,
    ["push", "--force-with-lease", "origin", `HEAD:refs/heads/${report.lane.branch}`],
    true,
  );
  if (remoteLaneHead(runner, worktree, report.lane.branch) !== installedHead)
    throw new Error("pushed rehearsal head does not match the installed tree");
  const ciRun = waitForCiVerdict(runner, worktree, report.lane.branch, installedHead);
  verification.push({ command: `hyprws CI ${ciRun.url}`, result: "passed" });
  report = {
    ...report,
    stage: "checked",
    installedHead,
    ciHead: installedHead,
    verification,
    silentSeams: [
      ...(report.silentSeams ?? []),
      ...(silentSeam === null ? [] : [parseSilentSeam(silentSeam)]),
    ],
  };
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
    return /\borientation: (?:candidate|keep|retire|partial)\b|\b(?:retire-candidate|human)\b/.test(
      classSummary,
    );
  });
  const silentSeams =
    record
      .split("## Silent seams\n", 2)[1]
      ?.split("\n## ", 1)[0]
      ?.split("\n")
      .filter((line) => /^- `.+` \[(?:behaviour|type)\]:/.test(line)) ?? [];
  const grounding = record.split("\n").filter((line) => /^Grounding (?:claim|pending):/.test(line));
  // A row carrying the default claim asks the human for nothing, so a surface
  // made only of those asks for the decisions and the go, and nothing else.
  const claimed =
    grounding.length > 0 ||
    rows.some((row) => (row.split("|")[5] ?? "").trim() !== NO_GROUNDING_CLAIM);
  return [
    "## Gate 4 decision surface",
    ...rows,
    ...silentSeams,
    ...grounding,
    claimed
      ? "Stop. Obtain every decision, every grounding confirmation, and an explicit go."
      : "Stop. Obtain every decision and an explicit go.",
    "",
  ].join("\n");
};

export const validateSignedRecord = (record: string, report: SyncReport): void => {
  if (/^Grounding pending:/m.test(record)) throw new Error("record still has pending grounding");
  for (const line of decisionSurface(record)
    .split("\n")
    .filter((row) => row.startsWith("|"))) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (!["keep", "keep (mechanical seam)", "retire", "partial"].includes(cells[4] ?? ""))
      throw new Error(`decision row has no keep/retire/partial action: ${line}`);
  }
  if (report.installedHead === undefined) throw new Error("report has no checked installed head");
};

export const expectedRehearsalBranch = (report: SyncReport): string => {
  if (report.target === undefined || report.source === undefined)
    throw new Error("rehearsal branch binding is incomplete");
  return `rehearse/${report.target.tag}-from-${report.source.expectedOld.slice(0, 12)}`;
};

export const validateAutoLane = (report: SyncReport, runner: CommandRunner): void => {
  if (report.lane === undefined) throw new Error("rehearsal lane is missing");
  const expected = expectedRehearsalBranch(report);
  if (report.lane.branch !== expected)
    throw new Error(`rehearsal lane mismatch: expected ${expected}, got ${report.lane.branch}`);
  if (git(runner, report.lane.worktree, ["status", "--porcelain"], true) !== "")
    throw new Error("rehearsal lane worktree is not clean");
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
  report = refreshAutoBotSnapshot(report, runner);
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
  if (report.ciHead === undefined || report.ciHead !== report.installedHead)
    throw new Error("checked report has no CI verdict for the installed head");
  if (remoteLaneHead(runner, worktree, lane.branch) !== report.ciHead)
    throw new Error("pushed rehearsal lane moved after the CI verdict; rerun unblock-check");
  if (!orientationCoheres(report, runner))
    throw new Error("orientation no longer coheres with live refs; rerun unblock-orient");
  validateAutoLane(report, runner);
  const applyEnv = laneEnv(worktree);
  requireSuccess(
    runner,
    "vp",
    ["run", "fork:upstream-refs", recordPath],
    worktree,
    undefined,
    applyEnv,
  );
  const gateArgs = [
    "run",
    "fork:sync-gate",
    "--tag",
    target.tag,
    "--record",
    recordPath,
    ...(isNightlyUpstreamTag(target.tag) ? ["--allow-nightly"] : []),
  ];
  requireSuccess(runner, "vp", gateArgs, worktree, undefined, applyEnv);
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
      `--force-with-lease=${HYPRWS_REF}:${source.expectedOld}`,
      "origin",
      `HEAD:${HYPRWS_REF}`,
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
  git(runner, worktree, ["push", "origin", "--delete", lane.branch], true);
  report = { ...report, stage: "applied", recordCommentUrl };
  writeReport(report);
  process.stdout.write(`applied: ${target.tag} with lease ${source.expectedOld}\n`);
  return report;
};

interface AutoTargetIssue {
  readonly title: string;
  readonly createdAt: string;
  readonly parent?: { readonly number: number } | null;
}

export const resolveAutoTarget = (
  candidates: ReadonlyArray<{ readonly tag: string; readonly sha: string }>,
  explicit: string | null,
  trackerIssues: ReadonlyArray<AutoTargetIssue>,
): { readonly target: { readonly tag: string; readonly sha: string }; readonly rule: string } => {
  if (explicit !== null)
    return { target: resolveUnblockTarget(candidates, explicit), rule: "explicit --target" };
  const offered = new Map(candidates.map((candidate) => [candidate.tag, candidate]));
  const tracker = trackerIssues
    .flatMap((issue) => {
      const tag = /^unblock walk lands (\S+)(?: \[📡#397\])?$/.exec(issue.title)?.[1];
      const target = tag === undefined ? undefined : offered.get(tag);
      return target === undefined ? [] : [{ issue, target }];
    })
    .toSorted((left, right) => left.issue.createdAt.localeCompare(right.issue.createdAt))[0];
  if (tracker !== undefined) return { target: tracker.target, rule: "open tracker sub-issue" };
  const oldest = candidates.at(-1);
  if (oldest === undefined) throw new Error("unblock-list offered no target");
  return { target: oldest, rule: "oldest offered tag containing the block" };
};

const captureStdout = <T>(effect: () => T): { readonly output: string; readonly value: T } => {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const value = effect();
    return { output, value };
  } finally {
    process.stdout.write = original;
  }
};

class AutoStop extends Error {}
class AutoBotRefusal extends Error {
  readonly reportPath: string;

  constructor(message: string, reportPath: string) {
    super(message);
    this.reportPath = reportPath;
  }
}
class AutoFailure extends Error {
  readonly reportPath: string;

  constructor(message: string, reportPath: string) {
    super(message);
    this.reportPath = reportPath;
  }
}

const autoConflictStopSurface = (surface: string, reportPath: string): string =>
  surface.replace(
    /^(.*), then rerun unblock-rehearse\.$/m,
    `$1, then run node scripts/fork-sync.ts unblock-rehearse --report ${reportPath}; after it completes, run the resume command below.`,
  );

const stopAuto = (surface: string, reportPath: string): never => {
  process.stdout.write(
    `${surface.trimEnd()}\nresume: node scripts/fork-sync.ts unblock-auto --resume --report ${reportPath}\n`,
  );
  throw new AutoStop();
};

const refreshAutoBotSnapshot = (report: SyncReport, runner: CommandRunner): SyncReport => {
  const bot = readBotSnapshot(runner, report.repositoryRoot);
  try {
    requirePausedBot(bot);
  } catch (error) {
    throw new AutoBotRefusal(
      error instanceof Error ? error.message : String(error),
      report.reportPath,
    );
  }
  const next = { ...report, bot };
  writeReport(next);
  return next;
};

const trackerTargetIssues = (runner: CommandRunner, root: string): ReadonlyArray<AutoTargetIssue> =>
  (
    JSON.parse(
      requireSuccess(
        runner,
        "gh",
        [
          "issue",
          "list",
          "--state",
          "open",
          "--search",
          '"unblock walk lands" in:title',
          "--json",
          "title,createdAt,parent",
          "--repo",
          REPOSITORY,
        ],
        root,
      ),
    ) as ReadonlyArray<AutoTargetIssue>
  ).filter(({ parent }) => parent?.number === 397);

const orientationCoheres = (report: SyncReport, runner: CommandRunner): boolean => {
  if (
    report.target === undefined ||
    report.source === undefined ||
    report.orientation === undefined
  )
    return false;
  const root = report.repositoryRoot;
  const source = git(runner, root, ["rev-parse", "origin/hyprws^{commit}"]);
  const liveTarget = git(runner, root, ["rev-parse", `refs/tags/${report.target.tag}^{commit}`]);
  const sharedBase = git(runner, root, ["merge-base", source, liveTarget]);
  const containsBlock =
    runner.run(
      "git",
      ["merge-base", "--is-ancestor", report.issue.blockingSha, report.target.sha],
      root,
    ).status === 0;
  return (
    containsBlock &&
    report.target.sha === liveTarget &&
    report.source.sha === source &&
    report.source.expectedOld === source &&
    report.source.sharedBase === sharedBase &&
    /^mirror:\s+origin\/main matches upstream\/main at [0-9a-f]{7,64}$/m.test(report.orientation)
  );
};

const pendingAutoConflictRows = (report: SyncReport): ReadonlyArray<ConflictRow> =>
  report.conflicts.filter(
    ({ agentSafe }) => agentSafe === "TODO" || agentSafe === "pending regeneration",
  );

const isRerereRow = (row: ConflictRow): boolean =>
  row.resolution === "review rerere's recorded resolution and stage";

const rererePathIsClean = (
  row: ConflictRow,
  remaining: ReadonlySet<string>,
  worktree: string,
  runner: CommandRunner,
): boolean => {
  if (remaining.has(row.path)) return false;
  let contents: string;
  try {
    contents = NodeFS.readFileSync(NodePath.join(worktree, row.path), "utf8");
  } catch {
    return false;
  }
  if (/^(?:<{7}|={7}|>{7})/m.test(contents)) return false;
  return (
    runner.run(
      "git",
      ["-c", "core.commentChar=auto", "diff", "--check", "--", row.path],
      worktree,
      undefined,
      { ...process.env, ...COMMENT_CONFIG },
    ).status === 0
  );
};

export const autoResolveConflicts = (
  report: SyncReport,
  runner: CommandRunner,
): SyncReport | null => {
  if (report.lane === undefined) throw new Error("rehearsal lane is missing");
  const pending = pendingAutoConflictRows(report);
  if (
    pending.some((row) => row.class !== "generated" && !(row.class === "TODO" && isRerereRow(row)))
  )
    return null;
  const rerereRows = pending.filter(
    (row) => row.class !== "generated" && row.class === "TODO" && isRerereRow(row),
  );
  let remaining: ReadonlySet<string>;
  try {
    remaining = new Set(
      lines(
        git(
          runner,
          report.lane.worktree,
          ["-c", "rerere.enabled=true", "rerere", "remaining"],
          true,
        ),
      ),
    );
  } catch {
    return null;
  }
  if (
    rerereRows.some(
      (row) => !rererePathIsClean(row, remaining, report.lane?.worktree ?? "", runner),
    )
  )
    return null;
  const next: SyncReport = {
    ...report,
    conflicts: report.conflicts.map((row) => {
      if (!pending.includes(row)) return row;
      if (row.class === "generated") return { ...row, decidedBy: "agent" };
      return {
        ...row,
        class: "mechanical",
        resolution: "rerere replay",
        agentSafe: "true",
        decidedBy: "agent",
      };
    }),
  };
  writeReport(next);
  writeRecord(next);
  for (const path of new Set(pending.map(({ path }) => path)))
    git(runner, report.lane.worktree, ["add", "--", path], true);
  return next;
};

const behaviourOverlap = (orientation: string): ReadonlyMap<string, string> =>
  new Map(
    [
      ...orientation.matchAll(
        /^\s+\[(?:candidate|keep|retire|partial)\] `(.+)` \([^)]+\)\n\s+behaviour-overlap: (.*)$/gm,
      ),
    ].map((match) => [match[1] ?? "", match[2] ?? ""]),
  );

const hardOverlapPaths = (overlap: string): ReadonlyArray<string> | null => {
  if (!overlap.startsWith("hard: ")) return null;
  const paths = overlap
    .slice("hard: ".length)
    .split(/,\s+/)
    .map((value) => value.replace(/\s+\(\d+ hunks?\)$/, ""));
  return paths.length > 0 && paths.every((path) => path.length > 0) ? paths : null;
};

export const gateFourStopReason = (report: SyncReport): string | null => {
  const behaviourSeam = (report.silentSeams ?? []).find(({ touchesBehaviour }) => touchesBehaviour);
  if (behaviourSeam !== undefined)
    return `silent seam touches behaviour: ${behaviourSeam.path}: ${behaviourSeam.summary}`;
  const judgementConflict = report.conflicts.find(
    ({ class: klass }) => klass === "retire-candidate" || klass === "human",
  );
  if (judgementConflict !== undefined)
    return `conflict requires judgement: ${judgementConflict.path} (${judgementConflict.class})`;

  const overlaps = behaviourOverlap(report.orientation ?? "");
  const mechanicalPaths = new Set(
    report.conflicts.filter(({ class: klass }) => klass === "mechanical").map(({ path }) => path),
  );
  for (const row of report.orientationDecisions ?? []) {
    if (row.verdict === "keep") continue;
    if (row.verdict === "retire" || row.verdict === "partial")
      return `orientation verdict requires judgement: ${row.verdict} \`${row.subject}\``;

    const overlap = overlaps.get(row.subject);
    if (overlap === undefined || overlap === "none")
      return `candidate has no parsed behaviour overlap: \`${row.subject}\``;
    if (overlap.startsWith("weak hunk overlap")) continue;
    const hardPaths = hardOverlapPaths(overlap);
    if (hardPaths !== null) {
      const missing = hardPaths.filter((path) => !mechanicalPaths.has(path));
      if (missing.length === 0) continue;
      return `hard overlap lacks a mechanical conflict for \`${row.subject}\`: ${missing.join(", ")}`;
    }
    return `unparsed overlap for \`${row.subject}\`: behaviour-overlap: ${overlap}`;
  }
  return null;
};

export const autoGateFour = (report: SyncReport): SyncReport | null => {
  if (gateFourStopReason(report) !== null) return null;
  return {
    ...report,
    orientationDecisions: (report.orientationDecisions ?? []).map((row) => ({
      ...row,
      ...(row.verdict === "candidate" ? { action: "keep (mechanical seam)" as const } : {}),
      decidedBy: "agent",
    })),
  };
};

interface WorkflowDispatchRun {
  readonly databaseId: number;
  readonly url: string;
}

const workflowDispatchRuns = (
  report: SyncReport,
  runner: CommandRunner,
): ReadonlyArray<WorkflowDispatchRun> =>
  JSON.parse(
    requireSuccess(
      runner,
      "gh",
      [
        "run",
        "list",
        "--workflow",
        BOT_WORKFLOW,
        "--event",
        "workflow_dispatch",
        "-L",
        "10",
        "--json",
        "databaseId,url",
        "--repo",
        REPOSITORY,
      ],
      report.repositoryRoot,
    ),
  ) as ReadonlyArray<WorkflowDispatchRun>;

const RECONCILIATION_POLL_LIMIT = 6;
const RECONCILIATION_POLL_SECONDS = 2;

export const reconcileAfterApply = (report: SyncReport, runner: CommandRunner): SyncReport => {
  if (report.reconciliation?.state === "dispatched") return report;
  let baselineRunId = report.reconciliation?.baselineRunId;
  if (baselineRunId === undefined) {
    baselineRunId = Math.max(
      0,
      ...workflowDispatchRuns(report, runner).map(({ databaseId }) => databaseId),
    );
    report = { ...report, reconciliation: { state: "ambiguous", baselineRunId } };
    writeReport(report);
    requireSuccess(
      runner,
      "gh",
      ["workflow", "run", BOT_WORKFLOW, "--ref", "hyprws", "--repo", REPOSITORY],
      report.repositoryRoot,
    );
  }

  for (let poll = 0; poll < RECONCILIATION_POLL_LIMIT; poll += 1) {
    const run = workflowDispatchRuns(report, runner)
      .filter(({ databaseId }) => databaseId > baselineRunId)
      .toSorted((left, right) => right.databaseId - left.databaseId)[0];
    if (run !== undefined) {
      const next: SyncReport = {
        ...report,
        reconciliation: {
          state: "dispatched",
          baselineRunId,
          runUrl: run.url,
        },
      };
      writeReport(next);
      return next;
    }
    if (poll + 1 < RECONCILIATION_POLL_LIMIT)
      requireSuccess(runner, "sleep", [String(RECONCILIATION_POLL_SECONDS)], report.repositoryRoot);
  }
  throw new Error(`reconciliation dispatch is ambiguous after run ${baselineRunId}`);
};

const unblockAuto = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--target", "--report", "--resume"]);
  const resume = values.has("--resume");
  if (resume && !values.has("--report")) throw new UsageError("--resume requires --report");
  if (resume && values.has("--target"))
    throw new UsageError("--target cannot be used with --resume");

  let report: SyncReport;
  if (resume) {
    report = readReport(oneValue(values, "--report") ?? "");
  } else {
    const listValues = new Map<string, string>();
    const reportPath = oneValue(values, "--report", false);
    if (reportPath !== null) listValues.set("--output", reportPath);
    report = captureStdout(() => unblockList(listValues, cwd, runner)).value;
  }

  try {
    if (report.stage !== "applied") {
      if (resume) {
        report = refreshAutoBotSnapshot(report, runner);
        if (report.target !== undefined && !orientationCoheres(report, runner))
          stopAuto(`${report.reportPath}\n${report.orientation ?? ""}`, report.reportPath);
        if (report.lane !== undefined) validateAutoLane(report, runner);
      } else {
        if (report.bot === undefined)
          throw new Error("report has no bot snapshot; rerun unblock-auto");
        try {
          requirePausedBot(report.bot);
        } catch (error) {
          throw new AutoBotRefusal(
            error instanceof Error ? error.message : String(error),
            report.reportPath,
          );
        }
      }
    }

    if (report.stage === "listed") {
      const explicit = oneValue(values, "--target", false);
      const trackerIssues =
        explicit === null ? trackerTargetIssues(runner, report.repositoryRoot) : [];
      const selected = resolveAutoTarget(report.candidates, explicit, trackerIssues);
      process.stdout.write(
        `target rule: ${selected.rule}: ${selected.target.tag}@${selected.target.sha}\n`,
      );
      const oriented = captureStdout(() =>
        unblockOrient(
          new Map([
            ["--report", report.reportPath],
            ["--target", `${selected.target.tag}@${selected.target.sha}`],
          ]),
          cwd,
          runner,
        ),
      );
      report = oriented.value;
      if (!orientationCoheres(report, runner)) stopAuto(oriented.output, report.reportPath);
    }

    while (report.stage === "oriented" || report.stage === "conflicts") {
      const rehearsal = captureStdout(() =>
        unblockRehearse(new Map([["--report", report.reportPath]]), cwd, runner),
      );
      report = rehearsal.value;
      if (report.stage !== "conflicts") continue;
      report =
        autoResolveConflicts(report, runner) ??
        stopAuto(autoConflictStopSurface(rehearsal.output, report.reportPath), report.reportPath);
    }

    if (report.stage === "replayed") {
      report = captureStdout(() =>
        unblockCheck(new Map([["--report", report.reportPath]]), cwd, runner),
      ).value;
    }

    if (report.stage === "checked") {
      let record = NodeFS.readFileSync(report.recordPath, "utf8");
      const behaviourSeam = (report.silentSeams ?? []).find(
        ({ touchesBehaviour }) => touchesBehaviour,
      );
      if (behaviourSeam !== undefined && report.behaviourSeamStopPresented !== true) {
        report = { ...report, behaviourSeamStopPresented: true };
        writeReport(report);
        stopAuto(
          `${report.reportPath}\n${decisionSurface(record)}Gate 4 refusal: silent seam touches behaviour: ${behaviourSeam.path}: ${behaviourSeam.summary}\n`,
          report.reportPath,
        );
      }

      const canonical = record === renderRecord(report);
      let signed = resume && report.behaviourSeamStopPresented === true;
      if (resume && !canonical) {
        try {
          validateSignedRecord(record, report);
          parseDecisionRows(record);
          signed = true;
        } catch {
          stopAuto(`${report.reportPath}\n${decisionSurface(record)}`, report.reportPath);
        }
      }
      if (!signed) {
        const reason = gateFourStopReason(report);
        if (reason !== null)
          stopAuto(
            `${report.reportPath}\n${decisionSurface(record)}Gate 4 refusal: ${reason}\n`,
            report.reportPath,
          );
        report =
          autoGateFour(report) ??
          stopAuto(
            `${report.reportPath}\n${decisionSurface(record)}Gate 4 refusal: automatic decision did not produce a record\n`,
            report.reportPath,
          );
        writeReport(report);
        writeRecord(report);
        record = NodeFS.readFileSync(report.recordPath, "utf8");
      }

      report = refreshAutoBotSnapshot(report, runner);
      if (!orientationCoheres(report, runner))
        stopAuto(`${report.reportPath}\n${report.orientation ?? ""}`, report.reportPath);
      validateAutoLane(report, runner);
      report = captureStdout(() =>
        unblockApply(
          new Map([
            ["--report", report.reportPath],
            ["--record", report.recordPath],
          ]),
          cwd,
          runner,
        ),
      ).value;
      process.stdout.write(`applied: ${report.target?.tag ?? "unknown"}\n`);
    }

    if (report.stage === "applied" && report.reconciliation?.state !== "dispatched") {
      report = reconcileAfterApply(report, runner);
      process.stdout.write(`workflow: ${report.reconciliation?.runUrl ?? "unknown"}\n`);
    }

    return report;
  } catch (error) {
    if (error instanceof AutoStop || error instanceof AutoBotRefusal) throw error;
    throw new AutoFailure(
      error instanceof Error ? error.message : String(error),
      report.reportPath,
    );
  }
};

export const execute = (
  argv: ReadonlyArray<string>,
  cwd = process.cwd(),
  runner: CommandRunner = new SystemRunner(),
): SyncReport => {
  if (argv[0]?.startsWith("stable-"))
    return executeStable(argv, cwd, runner) as unknown as SyncReport;
  const { verb, values } = parseVerbArgs(argv);
  if (verb === "unblock-auto") return unblockAuto(values, cwd, runner);
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
    process.stdout.write(SYNC_HELP);
    return 0;
  }
  try {
    execute(argv, cwd, runner);
    return 0;
  } catch (error) {
    if (error instanceof AutoStop) return 2;
    if (error instanceof AutoBotRefusal) {
      process.stderr.write(
        `${error.message}\nresume: node scripts/fork-sync.ts unblock-auto --resume --report ${error.reportPath}\n`,
      );
      return 3;
    }
    if (error instanceof AutoFailure) {
      process.stderr.write(
        `failed: ${error.message}\nresume: node scripts/fork-sync.ts unblock-auto --resume --report ${error.reportPath}\n`,
      );
      return 1;
    }
    if (error instanceof UsageError) {
      process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    process.stderr.write(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
