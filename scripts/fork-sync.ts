#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Operator state machine runs before Effect exists.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { pushBotRef, RERERE_REF, saveRerereCache } from "./lib/fork-bot-refs.ts";
import { UsageError } from "./lib/fork-cli.ts";
import {
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
  parseUpstreamReleaseTag,
  positionUpstreamReleaseTags,
  selectNewestReleaseTag,
} from "./lib/fork-policy.ts";
import { type StableCandidate } from "./lib/fork-rebase-issues.ts";
import { parseForkTrailers } from "./lib/fork-trailers.ts";

import {
  reconcileStableCandidates,
  SystemGitHub,
  type RebaseGitHubClient,
} from "./fork-rebase-notify.ts";
import { snapshotCrossedStableTags } from "./fork-stable-crossing.ts";
import { remoteLaneHead, waitForCiVerdict } from "./fork-sync-ci.ts";
import { executeStable } from "./fork-sync-stable.ts";
import { humanVerdictsBySubject, readChurnLedger } from "./fork-churn-ledger.ts";
import {
  assertOnly,
  BLOCK_LABEL,
  commandText,
  COMMENT_CONFIG,
  DECISION_ACTIONS,
  externalPath,
  extractBlockingSha,
  filledDecisionCells,
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
  type DecisionAction,
  type InheritedVerdict,
  type OrientationDecisionRow,
  type RecordDecision,
  type RetireEvidence,
  type RewriteProof,
  type SilentSeam,
  type SyncReport,
} from "./fork-sync-state.ts";

export {
  filledDecisionCells,
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
  type DecisionAction,
  type OrientationDecisionRow,
  type OrientationVerdict,
  type RecordDecision,
  type RetireEvidence,
  type RewriteProof,
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

const asBotMode = (mode: string): BotMode => {
  if (mode !== "off" && mode !== "candidate" && mode !== "on")
    throw new Error(`${BOT_VARIABLE} has unsupported mode: ${mode || "empty"}`);
  return mode;
};

/**
 * A workflow job token may not read repository variables, so the bot lane injects
 * the mode as `HYPRWS_AUTO_REBASE` instead. An injected value wins; the API read is
 * the human lane's fallback, and an unset variable still means candidate.
 */
const readBotMode = (runner: CommandRunner, root: string): BotMode => {
  const injected = process.env[BOT_VARIABLE]?.trim() ?? "";
  if (injected.length > 0) return asBotMode(injected);
  const args = ["variable", "get", BOT_VARIABLE, "--repo", REPOSITORY];
  const result = runner.run("gh", args, root);
  if (result.status !== 0 || result.error !== undefined) {
    const detail = [result.stdout.trim(), result.stderr.trim(), result.error?.message]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join("\n");
    if (/\b(?:HTTP 404|not found)\b/i.test(detail)) return "candidate";
    throw new Error(
      [
        `${commandText("gh", args)} failed: ${detail}`,
        `a caller that cannot read repository variables sets ${BOT_VARIABLE} in the environment instead`,
      ].join("\n"),
    );
  }
  return asBotMode(result.stdout.trim());
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

const botModeRefusal = (bot: BotSnapshot): void => {
  if (bot.mode === "on")
    throw new Error(
      [
        "auto-rebase bot mode is on; pause it before continuing:",
        `gh variable set ${BOT_VARIABLE} --body candidate --repo ${REPOSITORY}`,
      ].join("\n"),
    );
};

const requirePausedBot = (bot: BotSnapshot): void => {
  botModeRefusal(bot);
  if (botIsRunning(bot))
    throw new Error("bot run is in progress; wait for it and rerun unblock-list");
};

// A push to `hyprws` restarts the roughly 13 minute sync workflow, so a walk
// that meets a concurrent run holds its window instead of refusing: it names
// the run it waits on, polls on the same 30 second / 45 minute shape as
// `waitForCiVerdict` in fork-sync-ci.ts, and fails loudly at the ceiling.
// Bot mode `on` still refuses: that is a configuration error, not a race.
const BOT_POLL_SECONDS = 30;
const BOT_POLL_LIMIT = 91;

const waitForPausedBot = (runner: CommandRunner, root: string, bot: BotSnapshot): BotSnapshot => {
  botModeRefusal(bot);
  if (!botIsRunning(bot)) return bot;
  const runUrl = bot.lastRun?.url ?? "unknown run";
  process.stdout.write(`waiting for the auto-rebase bot run to finish: ${runUrl}\n`);
  let current = bot;
  for (let poll = 0; poll < BOT_POLL_LIMIT; poll += 1) {
    if (poll + 1 < BOT_POLL_LIMIT)
      requireSuccess(runner, "sleep", [String(BOT_POLL_SECONDS)], root);
    current = readBotSnapshot(runner, root);
    botModeRefusal(current);
    if (!botIsRunning(current)) {
      process.stdout.write("bot run finished; continuing\n");
      return current;
    }
  }
  throw new Error(`bot run is in progress after 45 minutes: ${runUrl}; rerun when it finishes`);
};

// The human lane waits out a concurrent run; the carrier lane is the bot run
// itself, so it keeps the lease refusal in `requireBotCarrier` and never
// waits. A settled snapshot is written back so the next verb does not wait
// twice on the same run.
const settleBotState = (
  report: SyncReport,
  bot: BotSnapshot,
  runner: CommandRunner,
): SyncReport => {
  if (report.botCarried === true) {
    requireBotCarrier(bot);
    return report;
  }
  const settled = waitForPausedBot(runner, report.repositoryRoot, bot);
  if (settled === bot) return report;
  const next = { ...report, bot: settled };
  writeReport(next);
  return next;
};

/**
 * The carrier lane inverts `requirePausedBot`: the bot is on and its run is this
 * process. The workflow's `hyprws-rebase` concurrency group is the real lease, and
 * this is the same guard read from the script's side, so a carry that is not the
 * newest run refuses instead of racing the run that holds it.
 */
const requireBotCarrier = (bot: BotSnapshot): void => {
  const runId = process.env.GITHUB_RUN_ID ?? "";
  if (runId.length === 0)
    throw new Error("--bot-carried runs inside the auto-rebase workflow; GITHUB_RUN_ID is unset");
  if (bot.mode !== "on")
    throw new Error(`--bot-carried requires ${BOT_VARIABLE}=on, found ${bot.mode}`);
  if (bot.lastRun !== null && !bot.lastRun.url.endsWith(`/runs/${runId}`))
    throw new Error(
      `another auto-rebase run holds the lease: ${bot.lastRun.url}; this run is ${runId}`,
    );
};

const requireBotState = (report: SyncReport, bot: BotSnapshot): void =>
  report.botCarried === true ? requireBotCarrier(bot) : requirePausedBot(bot);

// The store-`expectedOld` lease that `unblock-apply` force-with-leases. Every
// other verb must tell the operator the lease moved instead of the generic
// “moved after orientation” phrasing.
const voidedLeaseMessage = (
  branch: string,
  expectedOld: string,
  live: string,
  worktree: string | undefined,
): string => {
  const trash =
    worktree !== undefined ? `\nStale rehearsal worktree is pending trash: trash ${worktree}` : "";
  return `staleness: origin/hyprws moved past the report's lease; report leased at ${expectedOld}, origin/hyprws is now ${live}. Any movement of origin/hyprws voids the rehearsal.\nReport stage is void; restart at vp run fork:sync unblock-list. Rehearsal branch ${branch} is orphaned.${trash}`;
};

const ensureLeaseCurrent = (report: SyncReport, runner: CommandRunner): void => {
  // Make every unblock verb stale-aware. A report that has no source binding
  // (a fresh listed lane) is not yet leased; everything else names the old
  // and new SHA and the restart path. An unresolvable live (test fallback or
  // a missing ref) is not staleness — let the downstream guard decide. Rewrite
  // lanes sit on originSha so they read origin/hyprws against rewrite.originSha
  // instead.
  const leaseSha = report.source?.expectedOld ?? report.rewrite?.originSha;
  if (leaseSha === undefined) return;
  const result = runner.run("git", ["rev-parse", "origin/hyprws^{commit}"], report.repositoryRoot);
  const live = result.stdout.trim();
  if (result.status !== 0 || live.length === 0) return;
  if (live === leaseSha) return;
  const branch =
    report.lane?.branch ??
    (() => {
      try {
        return expectedRehearsalBranch(report);
      } catch {
        return "(rehearsal lane: unknown)";
      }
    })();
  throw new Error(voidedLeaseMessage(branch, leaseSha, live, report.lane?.worktree));
};

/**
 * The rehearsal lane. Worktrunk owns the human lane so the walk shows up in `wt
 * ls` beside every other branch, but it is not installable on a runner, so a
 * bot-carried walk mints the same worktree with plain Git.
 */
const mintLane = (
  report: SyncReport,
  runner: CommandRunner,
  branch: string,
  base: string,
): string => {
  const worktree =
    report.botCarried === true
      ? (() => {
          const path = NodePath.join(
            NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-lane-")),
            branch.replaceAll("/", "-"),
          );
          requireSuccess(
            runner,
            "git",
            ["worktree", "add", "--quiet", "-b", branch, path, base],
            report.repositoryRoot,
          );
          return path;
        })()
      : worktreePath(
          requireSuccess(
            runner,
            "wt",
            ["switch", "--create", branch, "--base", base, "--no-cd", "--format", "json", "--yes"],
            report.repositoryRoot,
          ),
        );
  // A minted lane has no node_modules, and the first gate battery would fail
  // on module resolution before it ever reached a verdict.
  requireSuccess(runner, "vp", ["i"], worktree, undefined, laneEnv(worktree));
  return worktree;
};

/**
 * `tagPinned` follows the caller's target, not its lane. A target the caller
 * pinned cannot move, so mirror currency says nothing about the walk in flight,
 * and upstream can advance between this run's own mirror push and its carry.
 * A walk that lists targets to choose from still requires a current mirror.
 */
const unblockList = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
  tagPinned = false,
): SyncReport => {
  assertOnly(values, ["--output", "--all"]);
  const root = rootFor(runner, cwd);
  requireSuccess(
    runner,
    "node",
    tagPinned ? ["scripts/fork-preflight.ts", "--tag-pinned"] : ["scripts/fork-preflight.ts"],
    root,
  );
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
    `${reportPath}\nStop. Ask the human to select one listed target:\n${offeredTagLines(candidates, values.has("--all")).join("\n")}\n${renderBotSnapshot(bot)}\n`,
  );
  return report;
};

/**
 * Candidates arrive newest first. A walk targets the newest offered tag, so only that one is
 * printed; the older tags a bisect would need are still selectable and print under `--all`.
 */
export const offeredTagLines = (
  candidates: ReadonlyArray<{ readonly tag: string; readonly sha: string }>,
  all: boolean,
): ReadonlyArray<string> => {
  const shown = all ? candidates : candidates.slice(0, 1);
  const hidden = candidates.length - shown.length;
  return [
    ...shown.map(({ tag, sha }) => `  ${tag}@${sha}`),
    ...(hidden === 0
      ? []
      : [`  (${hidden} older offered tag${hidden === 1 ? "" : "s"} hidden; rerun with --all)`]),
  ];
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
  let report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage !== "listed")
    throw new Error(`unblock-orient requires a listed report, got ${report.stage}`);
  if (report.bot === undefined) throw new Error("report has no bot snapshot; rerun unblock-list");
  // Make sure the lease the operator is binding against is still live; otherwise
  // the “moved after orientation” branch below would be too late to name the
  // staleness with the restart path slotted. Any report that already carries a
  // source lease (a resumed orient or a stale listed lane that was edited) also
  // gets the staleness refusal here.
  if (report.source?.expectedOld !== undefined) ensureLeaseCurrent(report, runner);
  report = settleBotState(report, report.bot, runner);
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
  const orientationDecisions = orientationDecisionRows(orientation);
  const retireEvidence = collectRetireEvidence(
    runner,
    root,
    liveTarget,
    { sharedBase, source: expectedOld },
    orientationDecisions,
  );
  const inheritedVerdicts = resolveInheritedVerdicts(report, orientationDecisions, retireEvidence);
  const next: SyncReport = {
    ...report,
    stage: "oriented",
    target: { tag: targetTag, sha: liveTarget },
    source: { sha: expectedOld, expectedOld, sharedBase },
    orientation,
    orientationDecisions,
    retireEvidence,
    inheritedVerdicts,
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
  "diff.algorithm=histogram",
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
    decidedBy: "TODO",
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

const retiredSubjectsForReport = (report: SyncReport): ReadonlySet<string> => {
  const subjects = new Set<string>();
  for (const row of report.recordDecisions ?? []) {
    if (row.action === "retire") subjects.add(row.subject);
  }
  for (const row of report.orientationDecisions ?? []) {
    if (row.verdict === "retire" && row.decidedBy !== "TODO") subjects.add(row.subject);
  }
  if (report.recordPath !== undefined && NodeFS.existsSync(report.recordPath)) {
    let text: string;
    try {
      text = NodeFS.readFileSync(report.recordPath, "utf8");
    } catch (error) {
      throw new Error(
        `failed to read retire decisions from ${report.recordPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const row of filledDecisionCells(text)) {
      if (row.action === "retire") subjects.add(row.subject);
    }
    for (const row of parseDecisionRows(text)) {
      if (row.verdict === "retire" && row.decidedBy !== "TODO") subjects.add(row.subject);
    }
  }
  return subjects;
};

const filterRetiredMessages = (messages: string, retired: ReadonlySet<string>): string => {
  if (retired.size === 0) return messages;
  const parts = messages.split("\x1e");
  const filtered: Array<string> = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    const subject = part.split("\n")[0]?.trim() ?? "";
    if (retired.has(subject)) continue;
    filtered.push(part);
  }
  if (filtered.length === 0) return "";
  return filtered.join("\x1e") + "\x1e";
};

const matchedRetiredCount = (messages: string, retired: ReadonlySet<string>): number => {
  if (retired.size === 0) return 0;
  let count = 0;
  for (const part of messages.split("\x1e")) {
    if (part.length === 0) continue;
    const subject = part.split("\n")[0]?.trim() ?? "";
    if (retired.has(subject)) count += 1;
  }
  return count;
};

export const verifyReplay = (report: SyncReport, runner: CommandRunner): void => {
  if (
    report.target === undefined ||
    report.originalMessages === undefined ||
    report.originalCount === undefined ||
    report.lane === undefined
  )
    throw new Error("replay binding is incomplete");
  const retired = retiredSubjectsForReport(report);
  const matched = matchedRetiredCount(report.originalMessages ?? "", retired);
  const expectedCount = (report.originalCount ?? 0) - matched;
  const count = Number(
    git(runner, report.lane.worktree, ["rev-list", "--count", `${report.target.sha}..HEAD`], true),
  );
  if (count !== expectedCount) {
    if (matched === 0)
      throw new Error(`replay commit count changed: ${report.originalCount} -> ${count}`);
    throw new Error(
      `replay commit count changed: ${report.originalCount} -> ${count} (expected ${expectedCount} after ${matched} retired)`,
    );
  }
  const messages = replayMessages(runner, report.lane.worktree, `${report.target.sha}..HEAD`);
  const expectedMessages = filterRetiredMessages(report.originalMessages ?? "", retired);
  if (messages !== expectedMessages) throw new Error("replay commit messages changed");
};

export const retiredSubjectsForTest = retiredSubjectsForReport;
export const filterRetiredMessagesForTest = filterRetiredMessages;

const unblockRehearse = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report"]);
  let report = readReport(oneValue(values, "--report") ?? "");
  // Any staleness voids a queued checked rehearsal visibly, with the old/new
  // SHAs and the restart path named, with the trash line for the lane.
  ensureLeaseCurrent(report, runner);
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
      throw new Error(
        voidedLeaseMessage(
          `rehearse/${target.tag}-from-${source.expectedOld.slice(0, 12)}`,
          source.expectedOld,
          live,
          undefined,
        ),
      );
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
    const worktree = mintLane(report, runner, branch, source.expectedOld);
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
        edited.agentSafe === "TODO" ||
        edited.decidedBy === "TODO"
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
    const retiredForRehearse = retiredSubjectsForReport(report);
    const pendingRetired = pending.some((row) => retiredForRehearse.has(row.subject));
    let continued: CommandResult;
    if (pendingRetired) {
      // The rebase drops the emptied commit knowingly via --skip, not by accident
      continued = runner.run(
        "git",
        rehearsalRebaseArgs(["rebase", "--skip"]),
        lane.worktree,
        undefined,
        { ...process.env, ...COMMENT_CONFIG, GIT_EDITOR: "true" },
      );
      if (continued.status !== 0 && pendingConflicts(runner, lane.worktree).length === 0)
        throw new Error(`git rebase --skip failed without conflicts: ${continued.stderr.trim()}`);
    } else {
      continued = runner.run(
        "git",
        rehearsalRebaseArgs(["rebase", "--continue"]),
        lane.worktree,
        undefined,
        { ...process.env, ...COMMENT_CONFIG, GIT_EDITOR: "true" },
      );
      if (continued.status !== 0 && pendingConflicts(runner, lane.worktree).length === 0)
        throw new Error(
          `git rebase --continue failed without conflicts: ${continued.stderr.trim()}`,
        );
    }
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
  // The carrier lane holds a push credential in the Git environment. Lane commands
  // are rebased code, so they run without it; fork-sync's own pushes keep it because
  // they read `process.env` directly (RSI-Software/t3code-hyprws#444).
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "HYPRWS_PUSH_TOKEN",
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

/**
 * A decision the report already carries for a subject, whether the agent signed it at gate 4 or an
 * earlier check preserved it from the record.
 */
const reportDecisionFor = (report: SyncReport, subject: string): RecordDecision | undefined => {
  const preserved = (report.recordDecisions ?? []).find((row) => row.subject === subject);
  if (preserved !== undefined) return preserved;
  const signed = (report.orientationDecisions ?? []).find(
    (row) => row.subject === subject && row.decidedBy !== "TODO",
  );
  if (signed === undefined || signed.decidedBy === "TODO") return undefined;
  return { subject, action: signed.action ?? signed.verdict, decidedBy: signed.decidedBy };
};

/**
 * The record is the operator's surface, so a cell filled there outlives the regeneration a check
 * performs. Two sources that disagree are not mergeable: the report is machine state and the record
 * is a human signature, and picking either one silently discards a decision someone made.
 */
const preserveRecordDecisions = (report: SyncReport): SyncReport => {
  if (!NodeFS.existsSync(report.recordPath)) return report;
  const filled = filledDecisionCells(NodeFS.readFileSync(report.recordPath, "utf8"));
  for (const row of filled) {
    const carried = reportDecisionFor(report, row.subject);
    if (carried === undefined) continue;
    if (carried.action === row.action && carried.decidedBy === row.decidedBy) continue;
    throw new Error(
      `record decision disagrees with the report for \`${row.subject}\`: report has ${carried.action} (${carried.decidedBy}), record has ${row.action} (${row.decidedBy})`,
    );
  }
  return filled.length === 0 ? report : { ...report, recordDecisions: filled };
};

const unblockCheck = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report", "--silent-seam"]);
  let report = readReport(oneValue(values, "--report") ?? "");
  // RSI-Software/t3code-hyprws#388: any hyprws movement past the lease voids the
  // queued checked rehearsal visibly, with the old/new SHAs and the restart
  // path and the trash line for the stale rehearsal.
  ensureLeaseCurrent(report, runner);
  const silentSeamRaw = oneValue(values, "--silent-seam", false);
  const silentSeams =
    silentSeamRaw === null ? [] : silentSeamRaw.split("\n").filter(Boolean).map(parseSilentSeam);
  if (report.stage !== "replayed")
    throw new Error(`unblock-check requires replayed state, got ${report.stage}`);
  if (report.kind === "rewrite") {
    if (report.lane === undefined || report.rewrite === undefined)
      throw new Error("replay binding is incomplete");
    // rewrite has no tag replay to verify; binding is the lane head itself
  } else {
    if (report.lane === undefined || report.target === undefined)
      throw new Error("replay binding is incomplete");
    report = preserveRecordDecisions(report);
    verifyReplay(report, runner);
  }
  const lane = report.lane!;
  const worktree = lane.worktree;
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
          report.kind === "rewrite"
            ? `${report.rewrite!.base}..HEAD`
            : `${report.target!.sha}..HEAD`,
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
  // Both lanes pin the scan to the tag the stack sits on. A rewrite keeps the
  // fork's current base, so scanning it against a moved `upstream/main` would
  // fail the rewrite for upstream drift it did not introduce.
  const scanTag =
    report.kind === "rewrite"
      ? ((report.rewrite as NonNullable<typeof report.rewrite>).baseTag ??
        baseReleaseTag(
          runner,
          worktree,
          (report.rewrite as NonNullable<typeof report.rewrite>).base,
        ))
      : (report.target as NonNullable<typeof report.target>).tag;
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [
    { command: "vp", args: ["run", "--no-cache", "fork:scan", "--target", scanTag] },
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
    ["push", "--force-with-lease", "origin", `HEAD:refs/heads/${lane.branch}`],
    true,
  );
  if (remoteLaneHead(runner, worktree, lane.branch, true) !== installedHead)
    throw new Error("pushed rehearsal head does not match the installed tree");
  const ciRun = waitForCiVerdict(runner, worktree, lane.branch, installedHead);
  verification.push({ command: `hyprws CI ${ciRun.url}`, result: "passed" });
  report = preserveRecordDecisions({
    ...report,
    stage: "checked",
    installedHead,
    ciHead: installedHead,
    verification,
    silentSeams: [...(report.silentSeams ?? []), ...silentSeams],
  });
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
    if (!["keep", ...DECISION_ACTIONS, "retire", "partial"].includes(cells[4] ?? ""))
      throw new Error(`decision row has no keep/retire/partial action: ${line}`);
    // An inherited verdict carries a human's prior answer forward but is visibly distinct:
    // `inherited (<tag>)` never silently becomes `human`. It still counts as a signed row for
    // Gate 4 so only genuinely new or changed candidates block landing.
    const decider = cells[6] ?? "";
    const isInherited = decider.startsWith("inherited (") && decider.endsWith(")");
    if (!["human", "agent"].includes(decider) && !isInherited)
      throw new Error(`decision row records no decider: ${line}`);
  }
  if (report.installedHead === undefined) throw new Error("report has no checked installed head");
};

export const expectedRehearsalBranch = (report: SyncReport): string => {
  if (report.kind === "rewrite") {
    if (report.rewrite === undefined) throw new Error("rehearsal branch binding is incomplete");
    return `rehearse/rewrite-${report.rewrite.fromShort}-from-${report.rewrite.originShort}`;
  }
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

export const baseReleaseTag = (runner: CommandRunner, root: string, baseSha: string): string => {
  const tags = lines(git(runner, root, ["tag", "--points-at", baseSha]))
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "" && parseUpstreamReleaseTag(tag) !== null);
  const tag = tags[0];
  if (tag === undefined)
    throw new Error(`no upstream release tag points at the rewrite base ${baseSha}`);
  return tag;
};

/**
 * Every apply teaches rerere how a seam resolves, so the cache joins its bot-owned
 * ref for the next walk. The apply already landed; a failed publish is reported and
 * never voids it (RSI-Software/t3code-hyprws#444).
 */
const publishRerereCache = (worktree: string, tag: string): void => {
  try {
    const commit = saveRerereCache(worktree, `rerere: ${tag}`);
    if (commit === null) return;
    pushBotRef(worktree, RERERE_REF);
    process.stdout.write(`${RERERE_REF} at ${commit}\n`);
  } catch (error) {
    process.stderr.write(
      `warning: ${RERERE_REF} not published: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
};

/**
 * The snapshot branch is already on `origin` and is the durable artefact, so a failed
 * announcement is reported and never voids the apply it followed
 * (RSI-Software/t3code-hyprws#444). Nothing reopens the question later: the bot cannot
 * see a tag the base has passed, so the printed branch is the whole recovery.
 */
export const announceStableCandidates = (
  candidates: ReadonlyArray<StableCandidate>,
  client: RebaseGitHubClient = new SystemGitHub(REPOSITORY),
): void => {
  if (candidates.length === 0) return;
  const branches = candidates.map((candidate) => `origin/${candidate.branch}`).join(", ");
  try {
    reconcileStableCandidates(client, candidates);
    process.stdout.write(`stable candidates announced from ${branches}\n`);
  } catch (error) {
    process.stderr.write(
      `warning: stable candidate issues not reconciled: ${error instanceof Error ? error.message : String(error)}\n` +
        `The snapshots are pushed; open their candidate issues by hand from ${branches}.\n`,
    );
  }
};

const unblockRefresh = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report"]);
  const report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage !== "checked" && report.stage !== "replayed")
    throw new Error(`unblock-refresh requires checked or replayed state, got ${report.stage}`);
  const refreshed = refreshRehearsalHead(report, runner);
  process.stdout.write(
    `${refreshed.reportPath}\nRebased head refreshed to ${refreshed.rebasedHead ?? "absent"}\n`,
  );
  return refreshed;
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
  // A checked report that is already stale must void as staleness
  // even when the bot is back on. Probe staleness before the bot so a stale
  // rehearsal silences the bot complaint. When the lease is still live, the
  // bot wins first; a staleness that only appears after the orientation check
  // restores staleness wording at the push edge below.
  let staleBeforeBot: Error | null = null;
  try {
    ensureLeaseCurrent(report, runner);
  } catch (error) {
    if (error instanceof Error && /staleness: origin\/hyprws moved/.test(error.message))
      staleBeforeBot = error;
  }
  if (staleBeforeBot !== null)
    report = refreshAutoBotSnapshot(report, runner).bot === undefined ? report : report;
  else report = refreshAutoBotSnapshot(report, runner);
  if (staleBeforeBot !== null) throw staleBeforeBot;
  const recordPath = NodePath.resolve(oneValue(values, "--record") ?? "");
  if (recordPath !== NodePath.resolve(report.recordPath))
    throw new Error("record path does not match the report binding");
  const record = NodeFS.readFileSync(recordPath, "utf8");
  validateSignedRecord(record, report);
  const isRewrite = report.kind === "rewrite";
  if (report.lane === undefined || report.source === undefined)
    throw new Error("apply binding is incomplete");
  if (isRewrite ? report.rewrite === undefined : report.target === undefined)
    throw new Error("apply binding is incomplete");
  const lane = report.lane;
  const source = report.source;
  const worktree = lane.worktree;
  if (git(runner, worktree, ["rev-parse", "HEAD"], true) !== report.installedHead)
    throw new Error("checked rehearsal head moved; rerun unblock-check");
  if (report.ciHead === undefined || report.ciHead !== report.installedHead)
    throw new Error("checked report has no CI verdict for the installed head");
  if (remoteLaneHead(runner, worktree, lane.branch, true) !== report.ciHead)
    throw new Error("pushed rehearsal lane moved after the CI verdict; rerun unblock-check");
  // A stale report that survived every prior pre-check still names the lease
  // that moved here, with the old/new SHAs and the restart path slotted. The
  // staleness does not preempt botMode: a green rehearsal with a still-live
  // lease must surface the botMode complaint, so staleBeforeBot is only used
  // to restore staleness wording when orientationCoheres would otherwise give
  // the generic phrasing.
  if (!isRewrite && !orientationCoheres(report, runner))
    throw (
      staleBeforeBot ??
      new Error(
        voidedLeaseMessage(
          lane.branch,
          source.expectedOld,
          git(runner, report.repositoryRoot, ["rev-parse", "origin/hyprws^{commit}"]),
          lane.worktree,
        ),
      )
    );
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
  // The gate is tag-pinned. A rewrite keeps the fork's current base, so its
  // release tag is the one the gate must see.
  const rewrite = report.rewrite;
  const gateTag = isRewrite
    ? ((rewrite as NonNullable<typeof rewrite>).baseTag ??
      baseReleaseTag(runner, worktree, (rewrite as NonNullable<typeof rewrite>).base))
    : (report.target as NonNullable<typeof report.target>).tag;
  const gateArgs = [
    "run",
    "fork:sync-gate",
    "--tag",
    gateTag,
    "--record",
    recordPath,
    ...(isNightlyUpstreamTag(gateTag) ? ["--allow-nightly"] : []),
  ];
  requireSuccess(runner, "vp", gateArgs, worktree, undefined, applyEnv);
  const recordCommentUrl = requireSuccess(
    runner,
    "gh",
    ["issue", "comment", String(report.issue.number), "-R", REPOSITORY, "--body-file", recordPath],
    worktree,
  ).trim();
  // A stable upstream tag is snapshotted and announced by whichever lane moves the
  // fork base past it. The bot only ever sees the tags inside its own walk window, so
  // the ones this apply crosses are the lane's to publish
  // (RSI-Software/t3code-hyprws#499). Snapshots are pushed before the trunk, exactly
  // as the bot orders them, because a create-only snapshot stands on its own.
  const newBaseSha = git(runner, worktree, ["rev-parse", `${gateTag}^{commit}`]);
  const stableCandidates = snapshotCrossedStableTags({
    root: worktree,
    oldSha: source.expectedOld,
    oldBaseSha: git(runner, worktree, ["merge-base", source.expectedOld, newBaseSha]),
    newBaseSha,
    warn: (message) => process.stderr.write(`warning: ${message}\n`),
  });
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
  announceStableCandidates(stableCandidates);
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
      isRewrite
        ? `Installed the rehearsed rewrite of the fork series on \`${gateTag}\`; the leased rewrite replaced \`${source.expectedOld}\`. Rehearsal record: ${recordCommentUrl}`
        : `Resolved blocking upstream commit \`${report.issue.blockingSha}\` while rebasing \`hyprws\` onto \`${gateTag}\`; the leased rewrite replaced \`${source.expectedOld}\`. Rehearsal record: ${recordCommentUrl}`,
    ],
    worktree,
  );
  git(runner, worktree, ["push", "origin", "--delete", lane.branch], true);
  publishRerereCache(worktree, gateTag);
  report = { ...report, stage: "applied", recordCommentUrl };
  writeReport(report);
  process.stdout.write(`applied: ${gateTag} with lease ${source.expectedOld}\n`);
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
  // Candidates arrive newest first. A slice is a consequence of a judgement stop, so it needs its
  // own tracker sub-issue; the default walk carries the fork to the head of the offered tags.
  const newest = candidates[0];
  if (newest === undefined) throw new Error("unblock-list offered no target");
  return { target: newest, rule: "newest offered tag containing the block" };
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
    const settled = settleBotState(report, bot, runner);
    if (settled !== report) return settled;
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

const refreshRehearsalHead = (report: SyncReport, runner: CommandRunner): SyncReport => {
  if (report.lane === undefined) throw new Error("rehearsal lane is missing");
  const head = git(runner, report.lane.worktree, ["rev-parse", "HEAD"]);
  const next: SyncReport = {
    ...report,
    rebasedHead: head,
    installedHead: head,
    ciHead: head,
  };
  writeReport(next);
  writeRecord(next);
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

/** A diff of these says nothing about a fork commit's own identity. */
const isOpaqueDiffPath = (path: string): boolean =>
  path === "pnpm-lock.yaml" || path.endsWith(".lock") || path.endsWith(".snap");

const MINIMUM_LITERAL_LENGTH = 12;
const IDENTIFIER_LIMIT = 40;

/** A settings key is only distinctive once it looks namespaced; `name` matches every tree. */
const isDistinctiveKey = (key: string): boolean => key.length >= 6 && /[.\-A-Z]/.test(key);

/**
 * The names a fork commit introduces: exported bindings, test titles, settings keys, and long
 * string literals. Conflicting near upstream work is not evidence that upstream implemented the
 * fork behaviour; finding one of these names in the target tree is.
 */
export const forkCommitIdentifiers = (diff: string): ReadonlyArray<string> => {
  const found = new Set<string>();
  let opaque = false;
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (header !== null) {
      opaque = isOpaqueDiffPath(header[1] ?? "");
      continue;
    }
    if (opaque || !line.startsWith("+")) continue;
    const added = line.slice(1);
    const exported =
      /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(
        added,
      )?.[1];
    if (exported !== undefined) found.add(exported);
    const key = /^\s*"([\w][\w.$-]*)"\s*:/.exec(added)?.[1];
    if (key !== undefined && isDistinctiveKey(key)) found.add(key);
    for (const match of added.matchAll(
      /\b(?:it|test|describe)(?:\.\w+)*\(\s*(["'`])((?:\\.|(?!\1).)+?)\1/g,
    ))
      if (match[2] !== undefined) found.add(match[2]);
    for (const match of added.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const literal = match[2] ?? "";
      if (literal.length >= MINIMUM_LITERAL_LENGTH && !literal.includes("${")) found.add(literal);
    }
  }
  return [...found].filter((value) => value.trim().length > 0).slice(0, IDENTIFIER_LIMIT);
};

/** Greps the target tag's tree for identifiers the fork commit introduced. */
export const retireCandidateMatches = (
  runner: CommandRunner,
  root: string,
  targetSha: string,
  identifiers: ReadonlyArray<string>,
): RetireEvidence["matches"] => {
  if (identifiers.length === 0) return [];
  const result = runner.run(
    "git",
    [
      "grep",
      "--no-color",
      "-I",
      "-n",
      "--fixed-strings",
      ...identifiers.flatMap((value) => ["-e", value]),
      targetSha,
    ],
    root,
  );
  if (result.status === 1) return [];
  if (result.status !== 0)
    throw new Error(`git grep against ${targetSha} failed: ${result.stderr.trim()}`);
  const matches: Array<{ identifier: string; location: string }> = [];
  const seen = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    const parsed = /^[^:]*:(.+?):(\d+):(.*)$/.exec(line);
    if (parsed === null) continue;
    const text = parsed[3] ?? "";
    const identifier = identifiers.find((value) => text.includes(value));
    if (identifier === undefined || seen.has(identifier)) continue;
    seen.add(identifier);
    matches.push({ identifier, location: `${parsed[1] ?? ""}:${parsed[2] ?? ""}` });
  }
  return matches;
};

/** Tests every orientation retire candidate against the target tag's tree. */
export const collectRetireEvidence = (
  runner: CommandRunner,
  root: string,
  targetSha: string,
  range: { readonly sharedBase: string; readonly source: string },
  decisions: ReadonlyArray<OrientationDecisionRow>,
): ReadonlyArray<RetireEvidence> => {
  const candidates = decisions.filter(({ verdict }) => verdict === "candidate");
  if (candidates.length === 0) return [];
  const commits = new Map<string, string>();
  for (const line of lines(
    git(runner, root, ["log", "--format=%H%x09%s", `${range.sharedBase}..${range.source}`]),
  )) {
    const separator = line.indexOf("\t");
    const subject = separator === -1 ? "" : line.slice(separator + 1);
    if (subject !== "" && !commits.has(subject)) commits.set(subject, line.slice(0, separator));
  }
  return candidates.flatMap((row) => {
    const commit = commits.get(row.subject);
    if (commit === undefined) return [];
    const identifiers = forkCommitIdentifiers(
      gitRaw(runner, root, ["show", "--format=", "--unified=0", "--no-color", commit]),
    );
    if (identifiers.length === 0) return [];
    return [
      {
        subject: row.subject,
        commit,
        identifiers,
        matches: retireCandidateMatches(runner, root, targetSha, identifiers),
      },
    ];
  });
};

const retireEvidenceFor = (report: SyncReport): ReadonlyMap<string, RetireEvidence> =>
  new Map(
    (report.retireEvidence ?? [])
      .filter(({ identifiers }) => identifiers.length > 0)
      .map((row) => [row.subject, row]),
  );

/**
 * Verdicts that survived a previous walk on `refs/fork/churn`.
 * Durable store is `refs/fork/churn` (bot-owned, outside the rebased lane), following
 * the `refs/fork/churn` precedent over a new ref. A carried verdict renders with an
 * `inherited (<tag>)` decider and is therefore distinguishable from a fresh one.
 */
export const resolveInheritedVerdicts = (
  report: SyncReport,
  decisions: ReadonlyArray<OrientationDecisionRow>,
  _evidence: ReadonlyArray<RetireEvidence>,
): ReadonlyArray<InheritedVerdict> => {
  let verdicts: ReadonlyMap<
    string,
    {
      readonly subject: string;
      readonly domain: string;
      readonly verdict: string;
      readonly sourceTag: string;
    }
  >;
  try {
    const entries = readChurnLedger(report.repositoryRoot);
    verdicts = humanVerdictsBySubject(entries);
  } catch {
    verdicts = new Map();
  }
  const decidedSubjects = new Set((report.recordDecisions ?? []).map((r) => r.subject));
  const carried: Array<InheritedVerdict> = [];
  for (const row of decisions) {
    if (row.verdict !== "candidate") continue;
    if (decidedSubjects.has(row.subject)) continue;
    const v = verdicts.get(row.subject);
    if (v === undefined) continue;
    carried.push({
      subject: v.subject,
      domain: v.domain,
      action: v.verdict,
      decidedBy: "human",
      sourceTag: v.sourceTag,
    });
  }
  return carried.filter((c) => decisions.some((d) => d.subject === c.subject));
};

/**
 * Every reason gate 4 needs a human, in the order the record presents them. One stop hides the rest
 * when a walk reports only the first, so the operator answers them one round trip at a time.
 */
export const gateFourStopReasons = (report: SyncReport): ReadonlyArray<string> => {
  const reasons: Array<string> = [];
  // A presented seam is a stop the human already answered by resuming, so it stops the walk once.
  if (report.behaviourSeamStopPresented !== true)
    for (const seam of (report.silentSeams ?? []).filter(
      ({ touchesBehaviour }) => touchesBehaviour,
    ))
      reasons.push(`silent seam touches behaviour: ${seam.path}: ${seam.summary}`);
  for (const row of report.conflicts.filter(
    ({ class: klass }) => klass === "retire-candidate" || klass === "human",
  ))
    reasons.push(`conflict requires judgement: ${row.path} (${row.class})`);

  const overlaps = behaviourOverlap(report.orientation ?? "");
  const evidence = retireEvidenceFor(report);
  const mechanicalPaths = new Set(
    report.conflicts.filter(({ class: klass }) => klass === "mechanical").map(({ path }) => path),
  );
  for (const row of report.orientationDecisions ?? []) {
    if (row.verdict === "keep") continue;
    if (row.verdict === "retire" || row.verdict === "partial") {
      reasons.push(`orientation verdict requires judgement: ${row.verdict} \`${row.subject}\``);
      continue;
    }

    // The target tree is evidence where proximity is not: a candidate whose own identifiers are
    // absent upstream was never retired, and one whose identifiers are present is a real question.
    const tested = evidence.get(row.subject);
    if (tested !== undefined) {
      const match = tested.matches[0];
      if (match !== undefined)
        reasons.push(
          `retire candidate is present in the target tree: \`${row.subject}\`: ${match.identifier} at ${match.location}`,
        );
      continue;
    }

    const overlap = overlaps.get(row.subject);
    if (overlap === undefined || overlap === "none") {
      reasons.push(`candidate has no parsed behaviour overlap: \`${row.subject}\``);
      continue;
    }
    if (overlap.startsWith("weak hunk overlap")) continue;
    const hardPaths = hardOverlapPaths(overlap);
    if (hardPaths === null) {
      reasons.push(`unparsed overlap for \`${row.subject}\`: behaviour-overlap: ${overlap}`);
      continue;
    }
    const missing = hardPaths.filter((path) => !mechanicalPaths.has(path));
    if (missing.length > 0)
      reasons.push(
        `hard overlap lacks a mechanical conflict for \`${row.subject}\`: ${missing.join(", ")}`,
      );
  }
  return reasons;
};

export const autoGateFour = (report: SyncReport): SyncReport | null => {
  if (gateFourStopReasons(report).length > 0) return null;
  const evidence = retireEvidenceFor(report);
  return {
    ...report,
    orientationDecisions: (report.orientationDecisions ?? []).map((row) => ({
      ...row,
      ...(row.verdict === "candidate"
        ? {
            action: (evidence.has(row.subject)
              ? "keep (target tree absent)"
              : "keep (mechanical seam)") as DecisionAction,
          }
        : {}),
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
  assertOnly(values, ["--target", "--report", "--resume", "--bot-carried", "--silent-seam"]);
  const resume = values.has("--resume");
  const botCarried = values.has("--bot-carried");
  if (resume && !values.has("--report")) throw new UsageError("--resume requires --report");
  if (resume && values.has("--target"))
    throw new UsageError("--target cannot be used with --resume");

  let report: SyncReport;
  if (resume) {
    report = readReport(oneValue(values, "--report") ?? "");
    if (botCarried && report.botCarried !== true)
      throw new UsageError("--bot-carried cannot resume a report the human lane started");
  } else {
    const listValues = new Map<string, string>();
    const reportPath = oneValue(values, "--report", false);
    if (reportPath !== null) listValues.set("--output", reportPath);
    report = captureStdout(() =>
      unblockList(listValues, cwd, runner, values.has("--target")),
    ).value;
  }
  // The carrier binding is written before any bot gate reads it, and it stays on
  // the report so a resumed walk cannot silently change lanes.
  if (botCarried && report.botCarried !== true) {
    report = { ...report, botCarried: true };
    writeReport(report);
  }

  try {
    if (report.stage !== "applied") {
      if (resume) {
        ensureLeaseCurrent(report, runner);
        report = refreshAutoBotSnapshot(report, runner);
        if (report.target !== undefined && !orientationCoheres(report, runner))
          stopAuto(`${report.reportPath}\n${report.orientation ?? ""}`, report.reportPath);
        if (report.lane !== undefined) validateAutoLane(report, runner);
      } else {
        if (report.bot === undefined)
          throw new Error("report has no bot snapshot; rerun unblock-auto");
        try {
          report = settleBotState(report, report.bot, runner);
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
      const silentSeamEntries = values.has("--silent-seam")
        ? values.get("--silent-seam")!.split("\n").filter(Boolean)
        : [];
      const checkArgs = new Map<string, string>([["--report", report.reportPath]]);
      // parseVerbArgs joins repeated --silent-seam with newline; unblockCheck splits again
      if (silentSeamEntries.length > 0)
        checkArgs.set("--silent-seam", silentSeamEntries.join("\n"));
      report = captureStdout(() => unblockCheck(checkArgs, cwd, runner)).value;
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
      // Presenting a behaviour seam records that the human saw it, never that anyone decided the
      // rows behind it. Both resume routes fill the record first and sign a complete one.
      let signed = false;
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
        const reasons = gateFourStopReasons(report);
        if (reasons.length > 0)
          stopAuto(
            `${report.reportPath}\n${decisionSurface(record)}${reasons
              .map((reason) => `Gate 4 refusal: ${reason}\n`)
              .join("")}`,
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

    // The carrier's own apply pushes `hyprws`, and that push is the workflow's
    // trigger, so dispatching a second run would only duplicate the reconciliation
    // the push already queues behind this run.
    if (
      report.botCarried !== true &&
      report.stage === "applied" &&
      report.reconciliation?.state !== "dispatched"
    ) {
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

const shortSha = (sha: string): string => sha.slice(0, 12);

// Minimal glob matcher: supports * and **
const pathGlobToRegExp = (glob: string): RegExp => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
};

const rewriteRehearse = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
): SyncReport => {
  const fromArg = values.get("--from");
  if (fromArg === undefined || fromArg.length === 0) throw new UsageError("--from is required");
  const issueArg = values.get("--issue");
  const allowExtraRaw = values.get("--allow-extra");
  const allowPathsRaw = values.get("--allow-paths");
  const dryRun = values.has("--dry-run");
  const allowedFlags = new Set([
    "--from",
    "--issue",
    "--allow-extra",
    "--allow-paths",
    "--dry-run",
  ]);
  for (const k of values.keys())
    if (!allowedFlags.has(k)) throw new UsageError(`unknown option: ${k}`);
  const allowExtra = allowExtraRaw === undefined ? 0 : Number(allowExtraRaw);
  if (allowExtraRaw !== undefined && (!Number.isInteger(allowExtra) || allowExtra < 0))
    throw new UsageError("--allow-extra requires a non-negative integer");
  const allowPaths =
    allowPathsRaw === undefined
      ? []
      : allowPathsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  const root = rootFor(runner, cwd);
  // The same bounded wait as the unblock walk: a concurrent run holds this
  // entry verb too. The ceiling message keeps the "bot run is in progress"
  // wording so the runner still reports it as a precondition refusal.
  // Bot mode `on` still refuses immediately; only the RUNNING case waits.
  waitForPausedBot(runner, root, readBotSnapshot(runner, root));
  const bot2 = readBotSnapshot(runner, root);
  if (bot2.mode === "on") {
    const msg = `auto-rebase bot mode is on; pause it before continuing:\ngh variable set ${BOT_VARIABLE} --body candidate --repo ${REPOSITORY}`;
    const err = new Error(msg) as Error & { reportPath?: string; isBotRefusal?: boolean };
    (err as unknown as { isBotRefusal: boolean }).isBotRefusal = true;
    throw err;
  }
  const expectedOld = git(runner, root, ["rev-parse", "origin/hyprws"]);
  const fromSha = git(runner, root, ["rev-parse", fromArg]);
  const baseOrigin = git(runner, root, ["merge-base", "upstream/main", "origin/hyprws"]);
  const baseFrom = git(runner, root, ["merge-base", "upstream/main", fromSha]);
  const countOrigin = Number(
    git(runner, root, ["rev-list", "--count", `${baseOrigin}..origin/hyprws`]),
  );
  const countFrom = Number(git(runner, root, ["rev-list", "--count", `${baseFrom}..${fromSha}`]));
  const originDigest = (() => {
    const raw = requireSuccess(
      runner,
      "git",
      [
        "-c",
        "core.commentChar=auto",
        "log",
        "--reverse",
        "--topo-order",
        "--format=%B%x1e",
        `${baseOrigin}..origin/hyprws`,
      ],
      root,
      undefined,
      { ...process.env, ...COMMENT_CONFIG },
    );
    return NodeCrypto.createHash("sha256").update(raw).digest("hex");
  })();
  // First-N digest: compare first min(countOrigin, countFrom) commit messages; for allow-extra case compare first countOrigin
  const fromFirstN = (() => {
    const n = Math.min(countOrigin, countFrom);
    if (n === 0) return "";
    // Find the sha that is n commits after base on the from branch
    const list = git(runner, root, [
      "rev-list",
      "--reverse",
      "--topo-order",
      `${baseFrom}..${fromSha}`,
    ])
      .split("\n")
      .filter(Boolean);
    const nth = list[n - 1];
    if (nth === undefined) return "";
    const raw = requireSuccess(
      runner,
      "git",
      [
        "-c",
        "core.commentChar=auto",
        "log",
        "--reverse",
        "--topo-order",
        "--format=%B%x1e",
        `${baseFrom}..${nth}`,
      ],
      root,
      undefined,
      { ...process.env, ...COMMENT_CONFIG },
    );
    return NodeCrypto.createHash("sha256").update(raw).digest("hex");
  })();
  const originHeadShort = shortSha(expectedOld);
  const fromShort = shortSha(fromSha);
  const diffRaw = (() => {
    // git diff <from> origin/hyprws -- ':!*.test.ts' ':!*.test.tsx' plus allowPaths filtering
    // Do base diff, then filter allowed paths if any
    const baseArgs = [
      "diff",
      "--name-only",
      fromSha,
      "origin/hyprws",
      "--",
      ":!*.test.ts",
      ":!*.test.tsx",
    ] as const;
    const names = requireSuccess(runner, "git", [...baseArgs], root)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowPaths.length === 0) return names;
    const pats = allowPaths.map(pathGlobToRegExp);
    return names.filter((p) => !pats.some((re) => re.test(p)));
  })();
  const diffEmpty = diffRaw.length === 0;
  const sameBase = baseFrom === baseOrigin;
  const countPass = countFrom === countOrigin || countFrom === countOrigin + allowExtra;
  const digestPass = originDigest === fromFirstN || countOrigin === 0;
  // For count-0 special: digest computed over first min so it matches when counts differ by 1 due to docs commit? We compare full origin digest vs first-N from digest
  // When counts differ by allowExtra, origin digest should equal first-countOrigin digest of from
  const proofs: RewriteProof[] = [
    {
      name: "bot paused",
      expected: "candidate/off and not RUNNING",
      actual: `${bot2.mode}${bot2.lastRun ? `/${bot2.lastRun.status}` : ""}`,
      pass: true,
    },
    {
      name: "same base",
      expected: baseOrigin.slice(0, 12),
      actual: `${baseFrom.slice(0, 12)} (origin ${baseOrigin.slice(0, 12)})`,
      pass: sameBase,
      ...(sameBase ? {} : { detail: `from base ${baseFrom} != origin base ${baseOrigin}` }),
    },
    {
      name: "commit count",
      expected:
        allowExtra > 0 ? `${countOrigin} or ${countOrigin + allowExtra}` : String(countOrigin),
      actual: String(countFrom),
      pass: countPass,
      ...(countPass
        ? {}
        : {
            detail: `stale base: from has ${countFrom}, origin has ${countOrigin}${allowExtra ? ` (+allow ${allowExtra})` : ""}`,
          }),
    },
    {
      name: "message digest (first N)",
      expected: originDigest.slice(0, 12),
      actual: fromFirstN.slice(0, 12),
      pass: digestPass,
      ...(digestPass
        ? {}
        : {
            detail: `origin ${originDigest.slice(0, 12)} != from-first-N ${fromFirstN.slice(0, 12)}`,
          }),
    },
    {
      name: "non-test diff",
      expected: allowPaths.length ? `empty after excluding ${allowPaths.join(",")}` : "empty",
      actual: diffEmpty ? "empty" : diffRaw.join(", "),
      pass: diffEmpty,
    },
  ];
  const proofTable = [
    "## Rewrite proofs",
    "| Proof | Expected | Actual | Pass |",
    "| --- | --- | --- | --- |",
    ...proofs.map(
      (p) => `| ${p.name} | ${p.expected} | ${p.actual} | ${p.pass ? "pass" : "fail"} |`,
    ),
    "",
    `- base: ${baseOrigin}`,
    `- origin: ${expectedOld}`,
    `- from: ${fromSha} (${fromArg})`,
  ].join("\n");
  for (const p of proofs) {
    process.stdout.write(
      `${p.pass ? "pass" : "fail"}: ${p.name} expected=${p.expected} actual=${p.actual}${p.detail ? ` (${p.detail})` : ""}\n`,
    );
  }
  process.stdout.write(proofTable + "\n");
  const firstFail = proofs.find((p) => !p.pass);
  if (firstFail !== undefined) {
    const err = new Error(
      `${firstFail.name} proof failed: expected ${firstFail.expected}, got ${firstFail.actual}${firstFail.detail ? ` (${firstFail.detail})` : ""}\n${proofTable}`,
    ) as Error & { isBotRefusal?: boolean };
    // Count/base failures should be exit 3 per brief; bot was already handled above.
    // Mark non-bot precondition failures so run() maps to 3 as well if desired. For now throw plain and let run() map bot only; but brief says each precondition refusal is exit 3.
    // We add a marker so run() can map any precondition failure to 3.
    (err as unknown as { isPrecondition: boolean }).isPrecondition = true;
    throw err;
  }
  // Resolve issue number for the report (optional, for record linkage). If --issue given use it, else try to read the rebase-blocked issue if open.
  let issueNumber = 0;
  let blockingSha = "0".repeat(40);
  let issueTitle = "rewrite rehearsal";
  if (issueArg !== undefined) {
    issueNumber = Number(issueArg);
    blockingSha = expectedOld; // not used for rewrite; keep a valid SHA
  } else {
    try {
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
      const arr = JSON.parse(raw) as Array<{ number: number; title: string; body: string }>;
      if (arr.length === 1 && arr[0] !== undefined) {
        issueNumber = arr[0].number;
        issueTitle = arr[0].title;
        const m = /<!-- blocking-sha:([0-9a-f]{40,64}) -->/.exec(arr[0].body);
        if (m) blockingSha = m[1] ?? blockingSha;
      }
    } catch {}
  }
  if (issueNumber === 0) {
    issueNumber = 1;
  }
  const laneBranch = `rehearse/rewrite-${fromShort}-from-${originHeadShort}`;
  const reportDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-sync-rewrite-"));
  const reportPath = NodePath.join(reportDir, "report.json");
  const recordPath = NodePath.join(reportDir, "record.md");
  let worktree = "";
  if (!dryRun) {
    // Check branch doesn't already exist
    const exists =
      runner.run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${laneBranch}`], root)
        .status === 0;
    if (exists) throw new Error(`rehearsal lane already exists: ${laneBranch}`);
    const laneResult = requireSuccess(
      runner,
      "wt",
      ["switch", "--create", laneBranch, "--base", fromSha, "--no-cd", "--format", "json", "--yes"],
      root,
    );
    const parsed = JSON.parse(laneResult) as Record<string, unknown>;
    worktree = String(parsed["worktree_path"] ?? parsed["worktreePath"] ?? parsed["path"] ?? "");
    if (!worktree) throw new Error("Worktrunk JSON omitted the worktree path");
    requireSuccess(runner, "vp", ["i"], worktree, undefined, {
      ...process.env,
      PATH: [NodePath.join(worktree, "node_modules", ".bin"), process.env.PATH ?? ""].join(
        NodePath.delimiter,
      ),
    } as NodeJS.ProcessEnv);
  } else {
    worktree = NodePath.join(root, ".tmp-rewrite-dry-run");
  }
  const report: SyncReport = {
    schemaVersion: 1,
    stage: "replayed",
    kind: "rewrite",
    repositoryRoot: root,
    reportPath,
    recordPath,
    issue: { number: issueNumber, blockingSha, title: issueTitle },
    candidates: [],
    bot: bot2,
    source: { sha: expectedOld, expectedOld, sharedBase: baseOrigin },
    lane: { branch: laneBranch, worktree },
    originalMessages: "",
    originalCount: countFrom,
    conflicts: [],
    verification: [],
    rebasedHead: fromSha,
    stackSize: countFrom,
    rewrite: {
      from: fromArg,
      fromSha,
      fromShort,
      originSha: expectedOld,
      originShort: originHeadShort,
      base: baseOrigin,
      baseTag: baseReleaseTag(runner, root, baseOrigin),
      baseToOriginCount: countOrigin,
      baseToFromCount: countFrom,
      allowExtra,
      allowPaths,
      originDigest,
      fromFirstNDigest: fromFirstN,
      diffEmpty,
      proofs,
    },
  };
  writeReport(report);
  writeRecord(report);
  if (!dryRun) {
    // Push lane (same mechanics as unblock-rehearse)
    // Push with force-with-lease handled by git push
    requireSuccess(
      runner,
      "git",
      ["push", "--force-with-lease", "origin", `HEAD:refs/heads/${laneBranch}`],
      worktree,
    );
  } else {
    process.stdout.write("(dry-run: lane not created or pushed)\n");
  }
  process.stdout.write(`${reportPath}\n`);
  return report;
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
  if (verb === "unblock-refresh") return unblockRefresh(values, cwd, runner);
  if (verb === "unblock-apply") return unblockApply(values, cwd, runner);
  if (verb === "rewrite-rehearse")
    return rewriteRehearse(values, cwd, runner) as unknown as SyncReport;
  throw new UsageError(`unknown verb: ${verb}`);
};

const isPreconditionRefusal = (error: unknown): boolean =>
  (typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>).isPrecondition === true) ||
  (error instanceof Error &&
    /proof failed|same base|commit count|message digest|non-test diff|bot.*paused|bot run is in progress/i.test(
      error.message,
    ));

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
    if ((error as Record<string, unknown> | null)?.isBotRefusal === true) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 3;
    }
    if (isPreconditionRefusal(error)) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
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
