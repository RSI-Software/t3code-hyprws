#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Operator state machine runs before Effect exists.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { captureSyncOutcome, runOutcome } from "./fork-churn-outcomes.ts";
import {
  runRewriteBuild,
  verifyRewriteBuild,
  type RewriteBuildReceipt,
} from "./lib/fork-rewrite-build.ts";

import {
  CHURN_REF,
  fetchBotRef,
  publishRerereSnapshot,
  RERERE_REF,
  saveRerereCache,
} from "./lib/fork-bot-refs.ts";
import { appendChurnRow } from "./fork-churn.ts";
import {
  budgetFindings,
  FORK_BUDGET_PATH,
  parseForkBudget,
  raiseForkBudget,
  type ForkBudgetFinding,
  type ForkBudgetMeasured,
} from "./lib/fork-budget.ts";
import { UsageError } from "./lib/fork-cli.ts";
import { applyAdditiveFixes, checkAdditive, type AdditiveFinding } from "./lib/fork-additive.ts";
import {
  executeConflictOutcome,
  isUnresolved,
  readConflictStages,
  seamKey,
  type UnresolvedOutcome,
} from "./lib/fork-conflict-outcomes.ts";
import { appendDecision, type WalkDecision } from "./lib/fork-decisions.ts";
import {
  formatCommand,
  repairCommitMessage,
  repairKind,
  type RepairKind,
  runRepairs,
  verifyPlan,
  type RepairFailure,
} from "./lib/fork-repairs.ts";
import {
  runCommand,
  SystemCommandRunner as SystemRunner,
  type CwdCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";

export {
  SystemCommandRunner as SystemRunner,
  type CommandResult,
  type CwdCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";
import {
  HYPRWS_REF,
  isNightlyUpstreamTag,
  parseUpstreamReleaseTag,
  positionUpstreamReleaseTags,
  selectNewestReleaseTag,
} from "./lib/fork-policy.ts";
import {
  forkCommitSourceExtensions,
  isFixtureLiteral,
  isModuleSpecifierLine,
  isOpaqueDiffPath,
  isRetireEvidenceSite,
  RETIRE_PROBE_EXCLUSIONS,
} from "./lib/fork-retire-probe.ts";
import { type StableCandidate } from "./lib/fork-rebase-issues.ts";
import { normalizeReplayMessages, withoutRepairMessages } from "./lib/fork-replay-messages.ts";
import {
  forkLogArguments,
  isForkDomain,
  parseForkLog,
  parseForkTrailers,
} from "./lib/fork-trailers.ts";
import { commitNumstatArguments, parseCommitNumstat } from "./lib/fork-numstat.ts";
import { retainRewriteArchive, rewriteArchiveBinding } from "./lib/fork-rewrite-archive.ts";
import { buildWalkSize, type WalkSize } from "./lib/fork-walk-size.ts";

import {
  reconcileStableCandidates,
  SystemGitHub,
  type RebaseGitHubClient,
} from "./fork-rebase-notify.ts";
import { snapshotCrossedStableTags } from "./fork-stable-crossing.ts";
import { remoteLaneHead, waitForCiVerdict } from "./fork-sync-ci.ts";
import { executeStable } from "./fork-sync-stable.ts";
import { humanVerdictsBySubject, readChurnLedger, readChurnState } from "./fork-churn-ledger.ts";
import {
  assertOnly,
  baseDecisionRows,
  BLOCK_LABEL,
  BOT_COMMIT_CONFIG,
  commandText,
  COMMENT_CONFIG,
  DECISION_ACTIONS,
  externalPath,
  extractBlockingSha,
  filledDecisionCells,
  git,
  gitRaw,
  lines,
  NIGHTLY_REVIEW_EVIDENCE,
  NO_GROUNDING_CLAIM,
  oneValue,
  orientationDecisionRows,
  orientationTouchedPaths,
  parseConflictRows,
  parseDecisionRows,
  parseVerbArgs,
  renderNightlyReview,
  renderRecord,
  readReport,
  REPOSITORY,
  requireAgentProvenance,
  requireNightlyReview,
  requireSuccess,
  reviewBoundRows,
  rootFor,
  splitTableCells,
  SYNC_HELP,
  uniqueSilentSeams,
  walkDecisionsOf,
  writeRecord,
  writeReport,
  worktreePath,
  type AgentProvenance,
  type BotMode,
  type BotRun,
  type BotSnapshot,
  type ConflictRow,
  type DecisionAction,
  type InheritedVerdict,
  type NightlyReviewEvidence,
  type OrientationDecisionRow,
  type RecordDecision,
  type RetireEvidence,
  type RewriteProof,
  type SilentSeam,
  type SyncReport,
  type WalkRecord,
  type WalkStopReason,
} from "./fork-sync-state.ts";

export {
  filledDecisionCells,
  NIGHTLY_REVIEW_EVIDENCE,
  NIGHTLY_WITHHOLD_RULES,
  NO_GROUNDING_CLAIM,
  orientationDecisionRows,
  orientationTouchedPaths,
  parseConflictRows,
  renderNightlyReview,
  renderRecord,
  validateReport,
  type AgentProvenance,
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
 * Unlike the paused human lane, the carrier requires the bot to be on and its run to be this
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
  return `staleness: origin/hyprws moved past the report's lease; report leased at ${expectedOld}, origin/hyprws is now ${live}. Any movement of origin/hyprws voids the rehearsal.\nReport stage is void; the walk re-lists from the moved trunk, and a single verb restarts at vp run fork:sync unblock-list. Rehearsal branch ${branch} is orphaned.${trash}\nSee the walk freeze in docs/operations/fork-sync.md.`;
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
  const leaseHead = git(runner, root, ["rev-parse", "origin/hyprws^{commit}"]);
  process.stdout.write(
    `${reportPath}\nStop. Ask the human to select one listed target:\n${offeredTagLines(candidates, values.has("--all")).join("\n")}\n${renderBotSnapshot(bot)}\nFreeze: walk lease taken at \`${leaseHead}\` (origin/hyprws) — while this report holds the lease, hyprws takes no landing until unblock-apply or an explicit void; see the walk freeze in docs/operations/fork-sync.md.\n`,
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

/**
 * A rebase is running exactly while its state directory exists; `REBASE_HEAD` outlives the
 * finish and cannot answer this. A git directory that will not resolve proves nothing, so it
 * reports "running" and the caller continues the rebase, which is what a stopped lane needs.
 */
const rebaseInProgress = (runner: CommandRunner, cwd: string): boolean => {
  const gitDir = git(runner, cwd, ["rev-parse", "--git-dir"], true);
  if (gitDir === "") return true;
  const root = NodePath.isAbsolute(gitDir) ? gitDir : NodePath.join(cwd, gitDir);
  return ["rebase-merge", "rebase-apply"].some((state) =>
    NodeFS.existsSync(NodePath.join(root, state)),
  );
};

export const conflictResolutionIsReady = (
  path: string,
  _staged: ReadonlySet<string>,
  unmerged: ReadonlySet<string>,
  unstaged: ReadonlySet<string>,
): boolean => !unmerged.has(path) && !unstaged.has(path);

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
        { cause: error },
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
  const terminalSuffix = parts.pop() ?? "";
  const retained: Array<{ readonly index: number; readonly message: string }> = [];
  let removed = 0;
  for (const [index, part] of parts.entries()) {
    const subject = part.trimStart().split("\n")[0]?.trim() ?? "";
    if (retired.has(subject)) {
      removed += 1;
      continue;
    }
    retained.push({ index, message: part });
  }
  if (removed === 0) return messages;
  const first = retained[0];
  if (first === undefined) return "";
  const firstMessage = first.index > 0 ? first.message.replace(/^\n/, "") : first.message;
  return (
    [firstMessage, ...retained.slice(1).map(({ message }) => message)].join("\x1e") +
    "\x1e" +
    terminalSuffix
  );
};

const matchedRetiredCount = (messages: string, retired: ReadonlySet<string>): number => {
  if (retired.size === 0) return 0;
  let count = 0;
  for (const part of messages.split("\x1e")) {
    if (part.length === 0) continue;
    const subject = part.trimStart().split("\n")[0]?.trim() ?? "";
    if (retired.has(subject)) count += 1;
  }
  return count;
};

/**
 * The fork series the walk replayed, with walk repairs dropped from both sides. A repair from an
 * earlier walk is an ordinary commit on trunk by the time this walk reads its baseline, so a proof
 * that strips repairs from the lane but not from the baseline reads the earlier walk's bookkeeping
 * as a shrunk stack and halts a replay that is entirely healthy.
 */
const originalSeries = (report: SyncReport): { messages: string; count: number } => {
  const stripped = withoutRepairMessages(report.originalMessages ?? "");
  return { messages: stripped.messages, count: (report.originalCount ?? 0) - stripped.removed };
};

const expectedReplayCount = (report: SyncReport, retired: ReadonlySet<string>): number => {
  const baseline = originalSeries(report);
  return baseline.count - matchedRetiredCount(baseline.messages, retired);
};

/**
 * Measures the stack the walk replayed: the three numbers per cycle the walk records as its size
 * (RSI-Software/t3code-hyprws#672) — total fork commits, the per-domain table, and the shared-
 * file count, read from the replayed lane against the net fork and upstream diffs exactly like
 * `fork:delta --inventory`.
 */
const walkSizeRecord = (report: SyncReport, runner: CommandRunner): WalkSize | undefined => {
  if (
    report.lane === undefined ||
    report.target === undefined ||
    report.source === undefined ||
    report.source.sharedBase.length === 0
  )
    return undefined;
  const range = `${report.target.sha}..HEAD`;
  const commits = parseForkLog(
    gitRaw(runner, report.lane.worktree, forkLogArguments(report.target.sha, "HEAD"), true),
  );
  const statsBySha = parseCommitNumstat(
    gitRaw(
      runner,
      report.lane.worktree,
      commitNumstatArguments(commits.map(({ sha }) => sha)),
      true,
    ),
  );
  const quoteArgs = ["-c", "core.quotePath=false", "diff", "--name-only"];
  const forkChanged = new Set(
    lines(gitRaw(runner, report.lane.worktree, [...quoteArgs, range], true)),
  );
  const upstreamChanged = new Set(
    lines(
      gitRaw(runner, report.repositoryRoot, [
        ...quoteArgs,
        `${report.source.sharedBase}..${report.target.sha}`,
      ]),
    ),
  );
  return buildWalkSize({ commits, statsBySha, forkChanged, upstreamChanged });
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
  const baseline = originalSeries(report);
  const matched = matchedRetiredCount(baseline.messages, retired);
  const expectedCount = expectedReplayCount(report, retired);
  // The walk appends its own repair commits after the replay, so both proofs run over the fork
  // series alone. A rerun that already carries a repair still has to show the same fork commits.
  const series = withoutRepairMessages(
    replayMessages(runner, report.lane.worktree, `${report.target.sha}..HEAD`),
  );
  const count =
    Number(
      git(
        runner,
        report.lane.worktree,
        ["rev-list", "--count", `${report.target.sha}..HEAD`],
        true,
      ),
    ) - series.removed;
  if (count !== expectedCount) {
    if (matched === 0)
      throw new Error(`replay commit count changed: ${baseline.count} -> ${count}`);
    throw new Error(
      `replay commit count changed: ${baseline.count} -> ${count} (expected ${expectedCount} after ${matched} retired)`,
    );
  }
  const expectedMessages = filterRetiredMessages(baseline.messages, retired);
  if (normalizeReplayMessages(series.messages) !== normalizeReplayMessages(expectedMessages))
    throw new Error("replay commit messages changed");
};

/**
 * A worker that dies between `git rebase --continue` and the replayed write leaves a finished
 * rebase behind, and resuming it cannot continue a rebase that is no longer running. Falling
 * through to verification is safe only once the lane already holds the whole replayed stack, so
 * a lane that never started, or that stopped part-way, still refuses here.
 */
const assertReplayedWithoutRebase = (report: SyncReport, runner: CommandRunner): void => {
  if (
    report.target === undefined ||
    report.lane === undefined ||
    report.originalCount === undefined
  )
    throw new Error("replay binding is incomplete");
  const worktree = report.lane.worktree;
  const restart = "no rebase is in progress and the lane does not hold the replayed stack";
  if (
    runner.run(
      "git",
      ["-c", "core.commentChar=auto", "merge-base", "--is-ancestor", report.target.sha, "HEAD"],
      worktree,
      undefined,
      { ...process.env, ...COMMENT_CONFIG },
    ).status !== 0
  )
    throw new Error(`${restart}: ${report.target.tag} is not an ancestor of the lane head`);
  const expectedCount = expectedReplayCount(report, retiredSubjectsForReport(report));
  const repairs = withoutRepairMessages(
    replayMessages(runner, worktree, `${report.target.sha}..HEAD`),
  ).removed;
  const count =
    Number(git(runner, worktree, ["rev-list", "--count", `${report.target.sha}..HEAD`], true)) -
    repairs;
  if (count !== expectedCount)
    throw new Error(`${restart}: it holds ${count} commits, expected ${expectedCount}`);
};

export const retiredSubjectsForTest = retiredSubjectsForReport;
export const filterRetiredMessagesForTest = filterRetiredMessages;

export const completeGeneratedConflictRegeneration = (row: ConflictRow): ConflictRow => ({
  ...row,
  agentSafe: "yes — regenerated by unblock-rehearse",
  decidedBy: "agent",
});

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
    const rebasing = rebaseInProgress(runner, lane.worktree);
    const recordRows = parseConflictRows(NodeFS.readFileSync(report.recordPath, "utf8"));
    const pending = report.conflicts.filter(
      (row) =>
        row.resolution === "TODO" ||
        row.agentSafe === "TODO" ||
        row.agentSafe === "pending regeneration",
    );
    // Every gap here is a row a human still owns, so they are collected and raised together: a
    // stop that names one row at a time costs the operator a rerun for each of them.
    const handoffGaps: Array<string> = [];
    for (const row of pending.filter(({ class: klass }) => klass !== "generated")) {
      const edited = recordRows.find(
        (candidate) => candidate.path === row.path && candidate.subject === row.subject,
      );
      if (edited === undefined) {
        handoffGaps.push(`${row.path}: the record carries no row for ${row.subject}`);
        continue;
      }
      const blank = (
        [
          ["class", edited.class],
          ["resolution", edited.resolution],
          ["agent-safe", edited.agentSafe],
          ["decided by", edited.decidedBy],
        ] as const
      )
        .filter(([, cell]) => cell === "TODO")
        .map(([name]) => name);
      if (blank.length > 0)
        handoffGaps.push(`${row.path}: record row still on TODO for ${blank.join(", ")}`);
    }
    const staged = new Set(
      lines(git(runner, lane.worktree, ["diff", "--cached", "--name-only"], true)),
    );
    const unmerged = new Set(pendingConflicts(runner, lane.worktree));
    const unstaged = new Set(lines(git(runner, lane.worktree, ["diff", "--name-only"], true)));
    for (const row of pending.filter(({ path }) => !isGeneratedPath(path))) {
      if (conflictResolutionIsReady(row.path, staged, unmerged, unstaged)) continue;
      handoffGaps.push(
        unmerged.has(row.path)
          ? `${row.path}: conflict remains unmerged`
          : `${row.path}: resolved conflict is not staged or restored to HEAD`,
      );
    }
    if (handoffGaps.length > 0) throw new HandoffIncomplete(handoffGaps);
    // A finished rebase already carries the regenerated lockfile in its commits; regenerating it
    // again would only dirty the lane.
    if (rebasing && pending.some(({ path }) => isGeneratedPath(path))) {
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
          return completeGeneratedConflictRegeneration(row);
        return (
          recordRows.find((edited) => edited.path === row.path && edited.subject === row.subject) ??
          row
        );
      }),
    };
    const retiredForRehearse = retiredSubjectsForReport(report);
    const pendingRetired = pending.some((row) => retiredForRehearse.has(row.subject));
    if (!rebasing) {
      // The replay outlived the worker that ran it: verify the lane it left instead of
      // continuing a rebase that already finished.
      assertReplayedWithoutRebase(report, runner);
    } else if (pendingRetired) {
      // The rebase drops the emptied commit knowingly via --skip, not by accident
      const continued = runner.run(
        "git",
        rehearsalRebaseArgs(["rebase", "--skip"]),
        lane.worktree,
        undefined,
        { ...process.env, ...COMMENT_CONFIG, GIT_EDITOR: "true" },
      );
      if (continued.status !== 0 && pendingConflicts(runner, lane.worktree).length === 0)
        throw new Error(`git rebase --skip failed without conflicts: ${continued.stderr.trim()}`);
    } else {
      const continued = runner.run(
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
    report = preserveRecordDecisions({
      ...report,
      stage: "conflicts",
      conflicts: [...report.conflicts, ...additions],
    });
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
  // Every walk records the size of the stack it replayed (RSI-Software/t3code-hyprws#672).
  const size = walkSizeRecord(report, runner);
  report = preserveRecordDecisions({
    ...report,
    stage: "replayed",
    rebasedHead,
    stackSize,
    walk: { ...(report.walk ?? {}), ...(size === undefined ? {} : { size }) },
  });
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

/** Git under the walk's own identity, for the commits the walk writes rather than replays. */
const botGit = (runner: CommandRunner, cwd: string, args: ReadonlyArray<string>): string =>
  requireSuccess(runner, "git", ["-c", "core.commentChar=auto", ...args], cwd, undefined, {
    ...process.env,
    ...COMMENT_CONFIG,
    ...BOT_COMMIT_CONFIG,
  }).trim();

/**
 * The domain a repair belongs to: the one the fork commits owning the rewritten files declare.
 * Mixed ownership, an unknown domain, or a file no fork commit owns is `fork-meta`, because the
 * repair is then the walk's own bookkeeping rather than a change to one domain.
 */
export const repairDomain = (
  runner: CommandRunner,
  worktree: string,
  base: string,
  paths: ReadonlyArray<string>,
): string => {
  const owners = new Map<string, string>();
  const raw = gitRaw(
    runner,
    worktree,
    ["log", "--format=%x1e%H%x1f%b%x1f", "--name-only", `${base}..HEAD`],
    true,
  );
  for (const record of raw.split("\x1e").slice(1)) {
    const [, body = "", files = ""] = record.split("\x1f");
    const trailers = parseForkTrailers(body);
    // A repair owns no domain of its own; the fork commit under it still does.
    if (trailers.repair !== undefined) continue;
    for (const file of lines(files)) if (!owners.has(file)) owners.set(file, trailers.domain ?? "");
  }
  const domains = new Set(paths.map((path) => owners.get(path) ?? ""));
  const only = domains.size === 1 ? [...domains][0] : undefined;
  return isForkDomain(only) ? only : "fork-meta";
};

/**
 * Commit whatever a repair pass rewrote, as the walk's own commit. Nothing is amended and nothing
 * is squashed into a replayed fork commit: the SHAs the rehearsal proved stay exactly as they are,
 * and the repair arrives with an author, a subject and the trailers that say which walk made it
 * (RSI-Software/t3code-hyprws#663). A conflict resolution is not a repair — rebase semantics put
 * it inside the commit being replayed, and `autoResolveConflicts` leaves it there.
 */
const commitWalkRepairs = (
  report: SyncReport,
  runner: CommandRunner,
  worktree: string,
  outcome: {
    readonly ran: ReadonlyArray<{ readonly command: string }>;
    readonly dirtiedBy?: string;
  },
  /** A budget reconciliation names its own kind and owes the raise trailer the gate reads. */
  overrides?: { readonly kind?: RepairKind; readonly budgetRaise?: string },
): ReadonlyArray<{ readonly sha: string; readonly subject: string }> => {
  const tag = report.target?.tag;
  const base = report.target?.sha;
  if (tag === undefined || base === undefined) throw new Error("repair commit has no target tag");
  if (git(runner, worktree, ["status", "--porcelain"], true).length === 0) return [];
  botGit(runner, worktree, ["add", "-A"]);
  const paths = lines(git(runner, worktree, ["diff", "--cached", "--name-only"], true));
  if (paths.length === 0) return [];
  const command =
    outcome.dirtiedBy ?? outcome.ran[outcome.ran.length - 1]?.command ?? "the repair pass";
  const message = repairCommitMessage({
    kind: overrides?.kind ?? repairKind(command),
    tag,
    domain: repairDomain(runner, worktree, base, paths),
    command,
    ...(overrides?.budgetRaise === undefined ? {} : { budgetRaise: overrides.budgetRaise }),
  });
  botGit(runner, worktree, ["commit", "--no-verify", "-m", message]);
  const [sha = "", subject = ""] = git(
    runner,
    worktree,
    ["show", "-s", "--format=%H%x1f%s", "HEAD"],
    true,
  ).split("\x1f");
  return [{ sha, subject }];
};

/** `vp run` prints its own command banner above the script's stdout; the JSON starts at its first line. */
const jsonPayload = (raw: string): string => {
  const start = raw.startsWith("{") ? 0 : raw.indexOf("\n{");
  if (start === -1)
    throw new Error(`fork:delta --inventory --json printed no JSON object:\n${raw}`);
  return raw.slice(start);
};

export interface ForkBudgetReconciliation {
  readonly findings: ReadonlyArray<ForkBudgetFinding>;
  readonly commit?: { readonly sha: string; readonly subject: string };
}

/** The `Fork-Budget: raise <reason>` text, naming the walk and every ceiling it moved. */
export const budgetRaiseReason = (
  tag: string,
  findings: ReadonlyArray<ForkBudgetFinding>,
): string =>
  `the ${tag} replay widened ${findings
    .map(
      (finding) => `${finding.domain} ${finding.measure} ${finding.ceiling} -> ${finding.actual}`,
    )
    .join(", ")}`;

/**
 * Reconcile the budget with the stack the replay produced (RSI-Software/t3code-hyprws#745). A
 * kept-both resolution grows the domain it lands in, so a ceiling the fork measured before the
 * replay can be genuinely too low the moment the replay ends. The gate names the whole fix in its
 * refusal — raise the exceeded ceiling and carry `Fork-Budget: raise <reason>` on the commit that
 * does — and none of it is a judgement, so the walk takes that route itself instead of crashing on
 * a refusal whose repair it already knows. Only an exceeded ceiling moves, and only up to the
 * number now measured: a re-render would ratchet every untouched domain down to today's numbers
 * and spend headroom nobody decided to spend. The raise rides in the walk's own `Fork-Repair`
 * commit, whose lines the inventory already excludes, so writing it cannot widen a domain again.
 */
const reconcileForkBudget = (
  report: SyncReport,
  runner: CommandRunner,
  worktree: string,
  verificationEnv: NodeJS.ProcessEnv,
): ForkBudgetReconciliation => {
  const tag = report.target?.tag;
  const budgetFile = NodePath.join(worktree, FORK_BUDGET_PATH);
  if (tag === undefined || !NodeFS.existsSync(budgetFile)) return { findings: [] };
  const inventory = JSON.parse(
    jsonPayload(
      requireSuccess(
        runner,
        "vp",
        ["run", "--no-cache", "fork:delta", "--inventory", "--json"],
        worktree,
        undefined,
        verificationEnv,
      ),
    ),
  ) as { readonly domains: ReadonlyArray<ForkBudgetMeasured> };
  const markdown = NodeFS.readFileSync(budgetFile, "utf8");
  const findings = budgetFindings(inventory.domains, parseForkBudget(markdown));
  if (findings.length === 0) return { findings: [] };
  NodeFS.writeFileSync(budgetFile, raiseForkBudget(markdown, findings, inventory.domains));
  const [commit] = commitWalkRepairs(
    report,
    runner,
    worktree,
    { ran: [], dirtiedBy: "fork:delta --inventory" },
    { kind: "budget", budgetRaise: budgetRaiseReason(tag, findings) },
  );
  if (commit === undefined) throw new Error("the budget raise wrote no commit");
  return { findings, commit };
};

/**
 * The purely-additive half of the walk's self-verification (RSI-Software/t3code-hyprws#661). The
 * first pass reads the replayed tree against the two upstream trees; whatever a mechanical fix can
 * make additive again is applied and committed as the walk's own `additive` repair commit, and the
 * check runs exactly once more. The retry is recorded either way: on a pass the findings stay the
 * first-pass ones (each fixed or dropped), on a stop they are the ones no fix could clear.
 */
const runAdditivePhase = (
  report: SyncReport,
  runner: CommandRunner,
  worktree: string,
  verificationEnv: NodeJS.ProcessEnv,
): {
  readonly additive: NonNullable<WalkRecord["additive"]>;
  readonly repairCommit?: { readonly sha: string; readonly subject: string };
} => {
  const trees = {
    target: (report.target as NonNullable<typeof report.target>).sha,
    previous: report.source!.sharedBase,
  };
  const first = checkAdditive(runner, worktree, trees);
  if (first.length === 0) return { additive: { pass: true, attempts: 1, findings: [], fixed: [] } };
  const fixes = applyAdditiveFixes(runner, worktree, trees.target, first);
  let commit: { readonly sha: string; readonly subject: string } | undefined;
  if (fixes.paths.length > 0) {
    // The fixes are the walk's own rewrite, so they land as an `additive` repair commit, and the
    // appended trailers are proven in the lane exactly like the repair pass's.
    const [repaired] = commitWalkRepairs(report, runner, worktree, {
      ran: [],
      dirtiedBy: "additive",
    });
    if (repaired === undefined)
      throw new Error("additive repairs dirtied the tree but left no commit");
    const delta = { command: "vp", args: ["run", "--no-cache", "fork:delta", "--check"] } as const;
    requireSuccess(runner, delta.command, delta.args, worktree, undefined, verificationEnv);
    commit = repaired;
  }
  const retry = checkAdditive(runner, worktree, trees);
  return {
    additive: {
      pass: retry.length === 0,
      attempts: 2,
      findings: retry.length === 0 ? first : retry,
      fixed: fixes.fixed,
      ...(commit === undefined ? {} : { commit: commit.sha }),
    },
    ...(commit === undefined ? {} : { repairCommit: commit }),
  };
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

/**
 * The record is the decision surface, so a cell filled there is the decision — a rerun that
 * classifies the same subject differently loses to it instead of refusing the walk. A refusal here
 * was a human gate on a lane that has no human in it. Every verb that rewrites the record runs
 * this first, rehearse included: a rehearsal resumed after the operator filled a cell must not
 * re-mint it as `TODO`.
 */
export const preserveRecordDecisions = (report: SyncReport): SyncReport => {
  if (!NodeFS.existsSync(report.recordPath)) return report;
  const filled = filledDecisionCells(NodeFS.readFileSync(report.recordPath, "utf8"));
  if (filled.length === 0) return report;
  const filledSubjects = new Set(filled.map(({ subject }) => subject));
  return {
    ...report,
    recordDecisions: [
      ...(report.recordDecisions ?? []).filter(({ subject }) => !filledSubjects.has(subject)),
      ...filled,
    ],
  };
};

const unblockCheck = (
  values: ReadonlyMap<string, string>,
  cwd: string,
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
    if (!orientationCoheres(report, runner))
      throw new Error("rewrite construction binding is stale");
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
  let installedHead = git(runner, worktree, ["rev-parse", "HEAD"], true);
  if (report.kind === "rewrite" && installedHead !== report.rewrite?.build?.result)
    throw new Error("installed rewrite differs from its constructed head; rebuild the manifest");
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
  // Before the gate, not after its refusal: the replay's own resolutions can put a domain over a
  // ceiling measured before them, and that raise is the walk's to take (see reconcileForkBudget).
  // The rewrite lane is excluded — its head is a constructed manifest result its reviewer signed,
  // so the walk appends nothing to it.
  const budget =
    report.kind === "rewrite"
      ? { findings: [] as ReadonlyArray<ForkBudgetFinding> }
      : reconcileForkBudget(report, runner, worktree, verificationEnv);
  if (budget.commit !== undefined) {
    installedHead = budget.commit.sha;
    report = {
      ...report,
      walk: {
        ...(report.walk ?? {}),
        repairCommits: [...(report.walk?.repairCommits ?? []), budget.commit],
      },
    };
    writeReport(report);
  }
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [
    { command: "vp", args: ["run", "--no-cache", "fork:scan", "--target", scanTag] },
    { command: "vp", args: ["run", "--no-cache", "fork:delta", "--check"] },
  ];
  const verification: Array<{ command: string; result: string }> = [];
  // A raise widens what the fork may hold, so it is named in the record rather than left to the
  // commit body alone.
  if (budget.commit !== undefined) {
    verification.push({
      command: `fork budget raise: ${budgetRaiseReason(report.target?.tag ?? "", budget.findings)}`,
      result: "recorded",
    });
  }
  for (const command of commands) {
    requireSuccess(runner, command.command, command.args, worktree, undefined, verificationEnv);
    verification.push({ command: commandText(command.command, command.args), result: "passed" });
  }
  // Purely-additive verification (RSI-Software/t3code-hyprws#661), between the replayed tree and
  // the repair battery: the walk checks its own tree against the two upstream trees, mechanically
  // repairs what it can make additive again as its own `additive` repair commit, and re-checks
  // exactly once. A check the machine cannot make pass stops the walk.
  let additiveCommit: string | undefined;
  if (report.kind !== "rewrite" && report.target !== undefined && report.source !== undefined) {
    const phase = runAdditivePhase(report, runner, worktree, verificationEnv);
    additiveCommit = phase.additive.commit;
    report = {
      ...report,
      walk: {
        ...(report.walk ?? {}),
        additive: phase.additive,
        ...(phase.repairCommit === undefined
          ? {}
          : {
              repairCommits: [...(report.walk?.repairCommits ?? []), phase.repairCommit],
            }),
      },
    };
    writeReport(report);
    // The additive commit is the lane head now; the installed-tree binding must follow it or the
    // head guard below refuses the tree the walk itself just repaired.
    if (additiveCommit !== undefined) installedHead = additiveCommit;
    if (!phase.additive.pass) throw new AdditiveStop(phase.additive.findings, report.reportPath);
  }
  // In-lane repair, scoped to what the replay actually touched: the seams it automerged and the
  // conflicts it resolved. This is the walk's verification. Trunk CI runs the full battery after
  // the apply, where its verdict is a confirmation rather than a round trip the walk waits on.
  const repairPaths = [
    ...new Set([
      ...(report.touchedPaths ?? []),
      ...report.conflicts
        .filter(({ class: klass }) => klass !== "generated")
        .map(({ path }) => path),
    ]),
  ].sort();
  const repairs = runRepairs(
    runner,
    worktree,
    verifyPlan(worktree, repairPaths),
    verificationEnv,
    () => git(runner, worktree, ["status", "--porcelain"], true).length > 0,
  );
  for (const run of repairs.ran) verification.push({ command: run.command, result: run.result });
  if (repairs.failure !== undefined) {
    report = { ...report, walk: { ...(report.walk ?? {}), repairs: verification } };
    writeReport(report);
    throw new RepairStop(repairs.failure, report.reportPath);
  }
  // Everything the pass rewrote becomes the walk's own commit, appended after the fork series it
  // repairs. The series rewrite is excluded: its head is a constructed manifest result, so an
  // extra commit there would contradict the proposal its reviewer signed.
  const repaired =
    report.kind === "rewrite" ? [] : commitWalkRepairs(report, runner, worktree, repairs);
  const repairCommits = [
    ...(report.walk?.repairCommits ?? []).filter(
      (previous) => !repaired.some(({ sha }) => sha === previous.sha),
    ),
    ...repaired,
  ];
  if (repaired.length > 0) {
    // Prove the appended trailers in the lane rather than leaving them to trunk CI.
    const delta = { command: "vp", args: ["run", "--no-cache", "fork:delta", "--check"] } as const;
    requireSuccess(runner, delta.command, delta.args, worktree, undefined, verificationEnv);
    verification.push({ command: commandText(delta.command, delta.args), result: "passed" });
  }
  // A repair commit is the lane head by construction, so the head the walk publishes needs no
  // second read of `HEAD`.
  const checkedHead = repaired[repaired.length - 1]?.sha ?? installedHead;
  // The series rewrite is a human-driven proposal with no machine path: it rewrites the whole fork
  // stack at once, so its reviewer still signs a CI verdict on a pushed lane. The unblock walk does
  // not; its lane repair above is the verification, and trunk CI confirms after the apply.
  let ciHead: string | undefined;
  let proposedBy = report.proposedBy;
  if (report.kind === "rewrite") {
    git(
      runner,
      worktree,
      ["push", "--force-with-lease", "origin", `HEAD:refs/heads/${lane.branch}`],
      true,
    );
    if (remoteLaneHead(runner, worktree, lane.branch, true) !== checkedHead)
      throw new Error("pushed rehearsal head does not match the installed tree");
    const ciRun = waitForCiVerdict(runner, worktree, lane.branch, checkedHead);
    verification.push({ command: `hyprws CI ${ciRun.url}`, result: "passed" });
    ciHead = checkedHead;
    // A `checked` report already binds its proposer: sign-off is valid on any `checked` report,
    // with no separate resume round-trip to record one.
    if (proposedBy === undefined) {
      try {
        proposedBy = agentProvenance(runner, cwd);
      } catch (error) {
        throw new Error(
          `nightly proposal provenance unavailable: ${error instanceof Error ? error.message : String(error)}; rerun unblock-check from an agent host session with ghb runtime attestation available`,
          { cause: error },
        );
      }
    }
  }
  if (git(runner, worktree, ["rev-parse", "HEAD"], true) !== checkedHead)
    throw new Error("HEAD changed after the installed-tree check");
  report = preserveRecordDecisions({
    ...report,
    stage: "checked",
    installedHead: checkedHead,
    // A repair moves the lane head the apply publishes, so the record's head and stack size bind
    // that head. The gate compares them against the checkout, and the fork series is still
    // exactly what the replay proved: `## Repair commits` names everything appended after it.
    ...(repaired.length === 0 && additiveCommit === undefined && budget.commit === undefined
      ? {}
      : {
          rebasedHead: checkedHead,
          stackSize: Number(
            git(
              runner,
              worktree,
              ["rev-list", "--count", `${report.target?.sha ?? ""}..HEAD`],
              true,
            ),
          ),
        }),
    ...(ciHead === undefined ? {} : { ciHead }),
    ...(proposedBy === undefined ? {} : { proposedBy }),
    verification,
    walk: {
      ...(report.walk ?? {}),
      repairs: verification,
      ...(repairCommits.length === 0 ? {} : { repairCommits }),
    },
    silentSeams: uniqueSilentSeams([...(report.silentSeams ?? []), ...silentSeams]),
  });
  writeReport(report);
  writeRecord(report);
  const leaseSha = report.source?.expectedOld ?? report.rewrite?.originSha;
  const leaseLine =
    leaseSha === undefined
      ? "Freeze: report holds no lease — rerun unblock-list."
      : `Freeze: walk lease \`${leaseSha}\` beside the candidate above — hyprws takes no landing until unblock-apply or an explicit void; see the walk freeze in docs/operations/fork-sync.md.`;
  process.stdout.write(
    `${report.reportPath}\n${decisionSurface(NodeFS.readFileSync(report.recordPath, "utf8"))}${leaseLine}\n`,
  );
  return report;
};

export const decisionSurface = (record: string): string => {
  const rows = record.split("\n").filter((line) => {
    if (!/^\| `.+` \|/.test(line)) return false;
    const classSummary = splitTableCells(line)?.[2] ?? "";
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
    rows.some((row) => (splitTableCells(row)?.[4] ?? "") !== NO_GROUNDING_CLAIM);
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
    const cells = splitTableCells(line) ?? [];
    if (!["keep", ...DECISION_ACTIONS, "retire", "partial"].includes(cells[3] ?? ""))
      throw new Error(`decision row has no keep/retire/partial action: ${line}`);
    // An inherited verdict carries a human's prior answer forward but is visibly distinct:
    // `inherited (<tag>)` never silently becomes `human`. It still counts as a signed row for
    // Gate 4 so only genuinely new or changed candidates block landing.
    const decider = cells[5] ?? "";
    const isInherited = decider.startsWith("inherited (") && decider.endsWith(")");
    if (!["human", "agent"].includes(decider) && !isInherited)
      throw new Error(`decision row records no decider: ${line}`);
  }
  if (report.installedHead === undefined) throw new Error("report has no checked installed head");
};

const nightlyReviewSection = /\n?## Nightly review\n[\s\S]*?(?=\n## Grounding\n)/;

/** Hash the proposal surface the reviewer signed: header bindings (heads,
 * lease, target), verdict rows, silent seams, and verification lines.
 * Free prose — grounding claims, orientation text, citations — never
 * enters the digest, so wrapping a bare reference in backticks keeps the
 * sign-off while any binding or verdict change still voids it. */
export const nightlyProposalDigest = (record: string): string =>
  NodeCrypto.createHash("sha256").update(reviewBoundRows(record)).digest("hex");

const writeNightlyReviewRecord = (report: SyncReport, record: string): void => {
  const section = renderNightlyReview(report).join("\n");
  if (!nightlyReviewSection.test(record)) throw new Error("nightly record has no review section");
  NodeFS.writeFileSync(report.recordPath, record.replace(nightlyReviewSection, `\n${section}`), {
    mode: 0o600,
  });
};

export const agentProvenance = (
  runner: CommandRunner = new SystemRunner(),
  cwd = process.cwd(),
): AgentProvenance => {
  const raw = requireSuccess(runner, "ghb", ["attest", "handoff"], cwd);
  let handoff: unknown;
  try {
    handoff = JSON.parse(raw);
  } catch {
    throw new Error("agent provenance received invalid ghb handoff JSON");
  }
  if (typeof handoff !== "object" || handoff === null)
    throw new Error("agent provenance received invalid ghb handoff");
  const envelope = handoff as Record<string, unknown>;
  if (envelope.schema !== "ghb.host-handoff.v1")
    throw new Error("agent provenance received unsupported ghb handoff schema");
  if (typeof envelope.host !== "object" || envelope.host === null)
    throw new Error("agent provenance ghb handoff has no host identity");
  const host = envelope.host as Record<string, unknown>;
  if (host.role !== "host") throw new Error("agent provenance ghb handoff has invalid host role");
  return requireAgentProvenance(host, "agent provenance");
};

const nightlyReviewEvidence = (report: SyncReport, record: string): NightlyReviewEvidence => {
  if (
    report.target === undefined ||
    report.source === undefined ||
    report.lane === undefined ||
    report.installedHead === undefined ||
    report.ciHead === undefined
  )
    throw new Error("nightly review evidence is incomplete");
  if (report.ciHead !== report.installedHead)
    throw new Error("nightly review evidence has no CI verdict for the installed head");
  if (
    report.verification.length === 0 ||
    report.verification.some(({ result }) => result !== "passed")
  )
    throw new Error("nightly review evidence contains a missing or failed verification");
  if (nightlyProposalDigest(record) !== nightlyProposalDigest(renderRecord(report)))
    throw new Error("nightly review evidence is stale against the report");
  return {
    target: report.target.tag,
    targetSha: report.target.sha,
    blockingSha: report.issue.blockingSha,
    expectedOld: report.source.expectedOld,
    installedHead: report.installedHead,
    ciHead: report.ciHead,
    laneBranch: report.lane.branch,
    recordDigest: nightlyProposalDigest(record),
    inspected: NIGHTLY_REVIEW_EVIDENCE,
  };
};

const recordTarget = (
  record: string,
): { readonly tag: string; readonly sha: string } | undefined => {
  const match = /^- Target: `([^@`]+)@([^`]+)`$/m.exec(record);
  return match === null ? undefined : { tag: match[1] ?? "", sha: match[2] ?? "" };
};

/** #531 apply guard: no nightly apply without a fresh review sign-off. */
export const validateNightlyReview = (record: string, report: SyncReport): void => {
  const recordBinding = recordTarget(record);
  const reportIsNightly = report.target !== undefined && isNightlyUpstreamTag(report.target.tag);
  const recordIsNightly = recordBinding !== undefined && isNightlyUpstreamTag(recordBinding.tag);
  if (reportIsNightly || recordIsNightly) {
    if (
      report.target === undefined ||
      recordBinding === undefined ||
      report.target.tag !== recordBinding.tag ||
      report.target.sha !== recordBinding.sha
    )
      throw new Error("nightly apply refused: record target binding is stale");
  } else return;
  // A bot-carried walk has no agent judgement verdict to review. Any conflict or judgement
  // stops that workflow before apply and must be restarted as a host-owned proposal.
  if (report.botCarried === true) return;
  if (report.nightlyReview === undefined)
    throw new Error("nightly apply refused: review is missing");
  const review = requireNightlyReview(report.nightlyReview);
  if (review.status === "withheld")
    throw new Error(`nightly apply refused: review was withheld: ${review.reason}`);
  if (report.proposedBy === undefined)
    throw new Error("nightly apply refused: proposer provenance is stale");
  const proposer = requireAgentProvenance(report.proposedBy, "nightly proposer");
  if (JSON.stringify(proposer) !== JSON.stringify(review.proposer))
    throw new Error("nightly apply refused: proposer provenance is stale");
  if (review.proposer.session === review.reviewer.session)
    throw new Error("nightly apply refused: reviewer shares the proposer's session");
  const evidence = nightlyReviewEvidence(report, record);
  if (JSON.stringify(review.evidence) !== JSON.stringify(evidence))
    throw new Error("nightly apply refused: review is stale");
  const rendered = renderNightlyReview(report).join("\n").trim();
  const carried = nightlyReviewSection.exec(record)?.[0].trim();
  if (carried !== rendered)
    throw new Error("nightly apply refused: record does not carry the reviewed provenance");
};

const unblockReview = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report", "--sign-off", "--withhold"]);
  const signOff = values.has("--sign-off");
  const withheld = oneValue(values, "--withhold", false);
  if (signOff === (withheld !== null))
    throw new UsageError("choose exactly one of --sign-off or --withhold <reason>");
  let report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage !== "checked")
    throw new Error(`unblock-review requires checked state, got ${report.stage}`);
  if (report.target === undefined || !isNightlyUpstreamTag(report.target.tag))
    throw new Error("unblock-review is only for a nightly upstream target");
  // The unblock walk applies in one shot and carries its own verdict; the series rewrite is the
  // only proposal left that a second agent signs.
  if (report.kind !== "rewrite")
    throw new Error("unblock-review is only for a series rewrite proposal");
  if (report.botCarried === true)
    throw new Error("unblock-review is not used for an objective bot-carried walk");
  if (report.proposedBy === undefined)
    throw new Error("nightly review has no walking-agent proposer; rerun unblock-check first");
  const proposer = requireAgentProvenance(report.proposedBy, "nightly proposer");
  if (report.nightlyReview !== undefined)
    throw new Error(
      "nightly review is already recorded; restart the proposal instead of replacing it",
    );
  const reviewer = agentProvenance(runner, cwd);
  if (reviewer.session === proposer.session)
    throw new Error("nightly review refuses a verdict from the proposing session");
  const record = NodeFS.readFileSync(report.recordPath, "utf8");

  if (withheld !== null) {
    const reason = withheld.trim();
    if (reason.length === 0) throw new UsageError("--withhold requires a reason");
    report = {
      ...report,
      nightlyReview: {
        status: "withheld",
        proposer,
        reviewer,
        reviewedAt: new Date().toISOString(),
        reason,
      },
    };
  } else {
    validateSignedRecord(record, report);
    ensureLeaseCurrent(report, runner);
    const liveIssue = readIssue(runner, report.repositoryRoot);
    if (
      liveIssue.number !== report.issue.number ||
      extractBlockingSha(liveIssue.body) !== report.issue.blockingSha
    )
      throw new Error("nightly review blocking marker is stale");
    if (!orientationCoheres(report, runner)) throw new Error("nightly review orientation is stale");
    validateAutoLane(report, runner);
    if (git(runner, report.lane!.worktree, ["rev-parse", "HEAD"], true) !== report.installedHead)
      throw new Error("nightly review rehearsal head moved");
    if (remoteLaneHead(runner, report.lane!.worktree, report.lane!.branch, true) !== report.ciHead)
      throw new Error("nightly review pushed lane moved after CI");
    report = {
      ...report,
      nightlyReview: {
        status: "signed-off",
        proposer,
        reviewer,
        reviewedAt: new Date().toISOString(),
        evidence: nightlyReviewEvidence(report, record),
      },
    };
  }
  writeReport(report);
  writeNightlyReviewRecord(report, record);
  process.stdout.write(
    `${report.reportPath}\nnightly review: ${report.nightlyReview?.status}\nnext: node scripts/fork-sync.ts unblock-apply --report ${report.reportPath} --record ${report.recordPath}\n`,
  );
  return report;
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
  validateAutoLaneClean(report, runner);
};

/**
 * Paths a `status --porcelain -z` report names, NUL-split so git's path quoting never enters the
 * picture. A rename or copy pairs its new path with the original in a second record; the original
 * is not lane dirt of its own, so it is consumed and dropped.
 */
const porcelainPaths = (status: string): ReadonlyArray<string> => {
  const paths: Array<string> = [];
  const fields = status.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry === undefined || entry.length < 4) continue;
    paths.push(entry.slice(3));
    const xystatus = entry.slice(0, 2);
    if (xystatus.includes("R") || xystatus.includes("C")) index += 1;
  }
  return paths;
};

/**
 * A conflict stop leaves the lane dirty on purpose: the staged resolutions are the human's
 * answer, so a resumed walk at that stop may carry dirt on exactly the paths the stop named —
 * every conflict row the stopped report records, whether its decision cells are still `TODO`
 * (the resume asks for them, via unblock-rehearse's record check) or already filled
 * (fill-then-resume), plus the paths of an additive finding no mechanical fix cleared.
 *
 * The stop reason is what earns the allowance, not the stage it was recorded at: a conflict stop
 * the repair or additive phase raises sits at a later stage than `conflicts` and its lane is dirty
 * for the same reason (RSI-Software/t3code-hyprws#748). A lane with no conflict stop on its report
 * is fresh or finished and stays strictly clean; dirt outside the stopped rows refuses and names
 * it.
 */
export const conflictStopDirtAllowance = (report: SyncReport): ReadonlySet<string> => {
  if (report.walk?.stop?.reason !== "conflict") return new Set();
  return new Set([
    ...report.conflicts.map(({ path }) => path),
    ...(report.walk.additive?.findings ?? []).map(({ path }) => path),
  ]);
};

export const validateAutoLaneClean = (report: SyncReport, runner: CommandRunner): void => {
  if (report.lane === undefined) throw new Error("rehearsal lane is missing");
  const status = git(runner, report.lane.worktree, ["status", "--porcelain", "-z"], true);
  if (status === "") return;
  const allowed = conflictStopDirtAllowance(report);
  const offenders = porcelainPaths(status).filter((path) => !allowed.has(path));
  if (offenders.length > 0)
    throw new Error(`rehearsal lane worktree is not clean: ${[...new Set(offenders)].join(", ")}`);
};

export const baseReleaseTag = (runner: CommandRunner, root: string, baseSha: string): string => {
  const tag = lines(git(runner, root, ["tag", "--points-at", baseSha]))
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "" && parseUpstreamReleaseTag(candidate) !== null);
  if (tag === undefined)
    throw new Error(`no upstream release tag points at the rewrite base ${baseSha}`);
  return tag;
};

/**
 * Every apply teaches rerere how a seam resolves, so the cache joins its bot-owned
 * ref for the next walk. The apply already landed; a failed publish is reported and
 * never voids it (RSI-Software/t3code-hyprws#444).
 */
export const resumeRererePublication = (
  report: SyncReport,
  publish: typeof publishRerereSnapshot = publishRerereSnapshot,
): SyncReport => {
  if (report.stage !== "applied") throw new Error("rerere recovery requires an applied report");
  if (report.rererePublication?.state === "published") return report;
  if (report.lane === undefined || report.installedHead === undefined)
    throw new Error("rerere recovery has no applied lane binding");
  let pending = report;
  try {
    const snapshot =
      report.rererePublication?.snapshot === undefined
        ? saveRerereCache(report.lane.worktree, `rerere: applied ${report.installedHead}`)
        : report.rererePublication.snapshot;
    pending = { ...report, rererePublication: { state: "pending", snapshot } };
    writeReport(pending);
    const commit = snapshot === null ? null : publish(report.lane.worktree, snapshot);
    const completed: SyncReport = {
      ...pending,
      rererePublication: { state: "published", snapshot, ...(commit === null ? {} : { commit }) },
    };
    writeReport(completed);
    process.stdout.write(
      commit === null ? "rerere: no cache additions\n" : `${RERERE_REF} at ${commit}\n`,
    );
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeReport({
      ...pending,
      rererePublication: { ...pending.rererePublication, state: "pending", error: message },
    });
    throw new Error(
      `trunk already applied; ${RERERE_REF} publication pending: ${message}. Resume with unblock-apply --report ${report.reportPath} --record ${report.recordPath}`,
      { cause: error },
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
  // A subject that left the replay takes its row with it, which is the only sanctioned way a
  // filled cell disappears. Say which ones, so the loss is a line the operator reads rather than a
  // `TODO` they rediscover at apply time.
  const surviving = baseDecisionRows(refreshed);
  const filled = refreshed.recordDecisions ?? [];
  const dropped = filled.filter(({ subject }) => !surviving.has(subject));
  process.stdout.write(
    `${refreshed.reportPath}\n` +
      `Rebased head refreshed to ${refreshed.rebasedHead ?? "absent"}\n` +
      `Decision cells preserved: ${filled.length - dropped.length}\n` +
      (dropped.length === 0
        ? ""
        : `Decision cells dropped, subject no longer in the replay:\n${dropped
            .map(({ subject, decidedBy }) => `  - ${subject} (${decidedBy})`)
            .join("\n")}\n`),
  );
  return refreshed;
};

/**
 * The trunk has moved and the ledger has not. Everything the walk knows is in the report it
 * already wrote, so the stop names the applied trunk and the row that is missing rather than the
 * command that refused (RSI-Software/t3code-hyprws#664).
 */
class LedgerUnpublished extends Error {
  readonly report: SyncReport;
  constructor(message: string, report: SyncReport) {
    super(message);
    this.report = report;
  }
}

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n", 1)[0] ?? "unknown failure";

/**
 * One ledger write, retried once. A refused expected-old lease restores the local ref before it
 * reports, so the retry re-reads what origin publishes now and appends to that. A second refusal
 * is the environment, not a race: the walk stops and says which row `refs/fork/churn` is missing.
 */
const ledgerWrite = (report: SyncReport, label: string, write: () => void): SyncReport => {
  let failure = "";
  for (const attempt of [0, 1]) {
    try {
      write();
      return report;
    } catch (error) {
      failure = `${label}: ${firstLine(error)}`;
      if (attempt === 0)
        process.stderr.write(`warning: ${failure}; retrying the ${CHURN_REF} lease once\n`);
    }
  }
  const tag = report.target?.tag ?? "unknown";
  const stopped: SyncReport = {
    ...report,
    walk: { ...(report.walk ?? {}), ledger: { state: "unpublished", tag, reason: failure } },
  };
  writeReport(stopped);
  throw new LedgerUnpublished(
    `hyprws is applied at ${report.installedHead ?? "unknown"} and ${CHURN_REF} carries no row for ${tag}: ${failure}`,
    stopped,
  );
};

/**
 * The row the applied walk owes the ledger. It binds the record comment the apply just posted,
 * so it can only be written after the trunk push, and it is written before the invocation
 * reports `applied` so no outcome survives only in a runner file.
 */
const publishChurnRow = (report: SyncReport, tag: string): SyncReport => {
  // The leased push moved the trunk from the lane, so the fork root may not yet have the applied
  // head's objects; the row's repair scan cites the applied range (`before..after`), so fetch the
  // trunk into the root first (#700). A failed fetch is absorbed: the scan degrades to an empty
  // listing rather than failing the append, and the row shows the absence instead of dying.
  runCommand("git", ["fetch", "--quiet", "origin", HYPRWS_REF], { cwd: report.repositoryRoot });
  return ledgerWrite(report, "churn row", () =>
    appendChurnRow(
      [
        "--record",
        report.recordPath,
        "--issue",
        String(report.issue.number),
        "--tag",
        tag,
        "--before",
        report.source?.expectedOld ?? "",
        "--after",
        report.installedHead ?? "",
        "--push",
      ],
      report.repositoryRoot,
    ),
  );
};

/** The retained outcome receipts for the same walk, from the report this invocation just wrote. */
const publishWalkOutcomes = (report: SyncReport): SyncReport =>
  ledgerWrite(report, "outcome record", () => {
    runOutcome(["--sync-report", report.reportPath, "--push"], report.repositoryRoot);
  });

/**
 * The stopped walk's ledger row: pending until the walk completes, so census and hot seams skip
 * it, and the upgrade on the applied append carries the recorded decisions forward (#662).
 */
const publishPendingDecisionRow = (report: SyncReport, tag: string): SyncReport =>
  ledgerWrite(report, "pending decision row", () =>
    appendChurnRow(
      [
        "--record",
        report.recordPath,
        "--issue",
        String(report.issue.number),
        "--tag",
        tag,
        "--before",
        report.source?.expectedOld ?? "",
        "--after",
        report.source?.sha ?? "",
        "--pending",
        "--push",
      ],
      report.repositoryRoot,
    ),
  );

/**
 * Export a stopped walk's human resolutions so the next tag resolves without a stop
 * (RSI-Software/t3code-hyprws#662). Run in the lane after resolving and staging every declined
 * path: it flushes rerere's recorded resolutions to the shared ref and writes the decisions to
 * the record and a pending ledger row, each published under its own lease.
 */
export const recordDecisions = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report", "--tag"]);
  const reportPath = oneValue(values, "--report", true);
  const tag = oneValue(values, "--tag", true);
  if (reportPath === null || tag === null) throw new UsageError("--report and --tag are required");
  const report = readReport(reportPath);
  if (report.stage !== "conflicts" || report.walk?.stop?.reason !== "conflict")
    throw new UsageError("record-decisions requires a conflict-stop report");
  if (report.target === undefined || report.target.tag !== tag)
    throw new UsageError(`--tag ${tag} does not match the stopped walk's target`);
  if (report.lane === undefined) throw new UsageError("the stopped report has no lane");
  const worktree = report.lane.worktree;
  const declined = pendingAutoConflictRows(report);
  if (declined.length === 0)
    throw new UsageError("the stopped report names no rows a human has to resolve");
  void cwd;
  // Stage the recorded resolutions: the human resolved the worktree and staged it; this makes
  // rerere write each path's postimage so the shared ref can carry the resolution forward.
  git(runner, worktree, ["-c", "rerere.enabled=true", "rerere"], true);
  const remaining = new Set(lines(git(runner, worktree, ["rerere", "status"], true)));
  for (const row of declined)
    if (remaining.has(row.path) || !rererePathIsClean(row, remaining, worktree, runner))
      throw new UsageError(
        `${row.path} still has an unresolved conflict; resolve it, stage it, and rerun record-decisions`,
      );
  const snapshot = saveRerereCache(worktree, `rerere: recorded ${tag}`);
  if (snapshot !== null) {
    try {
      const commit = publishRerereSnapshot(worktree, snapshot);
      process.stdout.write(`${RERERE_REF} at ${commit}\n`);
    } catch (error) {
      throw new Error(
        `environment: publishing ${RERERE_REF} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  // One manual record per declined row, keyed by the seam the walk captured at decline time.
  const stamp = decisionStamp(report);
  let decisions: ReadonlyArray<WalkDecision> = report.decisions ?? [];
  for (const row of declined) {
    const key = row.seamKey ?? null;
    decisions = appendDecision(decisions, {
      kind: "conflict",
      subject: key ?? row.path,
      path: row.path,
      outcome: "manual",
      decidedBy: "human",
      ...stamp,
    });
  }
  const recorded: SyncReport = { ...report, decisions };
  writeReport(recorded);
  writeRecord(recorded);
  // The record must be on the issue before the ledger row names it: recordUrl is the pointer a
  // maintainer follows from the ledger to the human's own words.
  const recordUrl = requireSuccess(
    runner,
    "gh",
    [
      "issue",
      "comment",
      String(recorded.issue.number),
      "-R",
      REPOSITORY,
      "--body-file",
      recorded.recordPath,
    ],
    worktree,
  ).trim();
  process.stdout.write(`record: ${recordUrl}\n`);
  publishPendingDecisionRow(recorded, tag);
  for (const row of declined)
    process.stdout.write(`recorded: ${row.path} (${row.seamKey ?? "no seam key"}) by hand\n`);
  return recorded;
};

const unblockApply = (
  values: ReadonlyMap<string, string>,
  _cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--report", "--record"]);
  let report = readReport(oneValue(values, "--report") ?? "");
  if (report.stage === "applied") {
    if (
      NodePath.resolve(oneValue(values, "--record") ?? "") !== NodePath.resolve(report.recordPath)
    )
      throw new Error("record path does not match the report binding");
    return resumeRererePublication(report);
  }
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
  if (report.lane === undefined || report.source === undefined)
    throw new Error("apply binding is incomplete");
  // Prose hygiene first: the digest in the review gate below binds objective
  // rows only, so a refs fix on the same bindings never costs a second
  // review — only a prose edit and a re-apply.
  requireSuccess(
    runner,
    "vp",
    ["run", "fork:upstream-refs", recordPath],
    report.lane.worktree,
    undefined,
    laneEnv(report.lane.worktree),
  );
  const isRewrite = report.kind === "rewrite";
  // The review gate belongs to the series rewrite, the one proposal a human still owns end to end.
  // The unblock walk resolves, repairs and applies in one shot, so a second agent's sign-off would
  // be a human stop in the middle of an unattended run.
  if (isRewrite) {
    validateNightlyReview(record, report);
    if (report.target !== undefined && isNightlyUpstreamTag(report.target.tag)) {
      const liveIssue = readIssue(runner, report.repositoryRoot);
      if (
        liveIssue.number !== report.issue.number ||
        extractBlockingSha(liveIssue.body) !== report.issue.blockingSha
      )
        throw new Error("nightly apply refused: review blocking marker is stale");
    }
  }
  if (isRewrite && !orientationCoheres(report, runner))
    throw new Error(
      "rewrite construction, source, or blocking marker changed; restart the proposal",
    );
  if (isRewrite ? report.rewrite === undefined : report.target === undefined)
    throw new Error("apply binding is incomplete");
  if (isRewrite && report.rewrite?.archive === undefined)
    throw new Error(
      "rewrite apply has no pre-rewrite archive binding; restart with rewrite-rehearse",
    );
  const lane = report.lane;
  const source = report.source;
  const worktree = lane.worktree;
  if (git(runner, worktree, ["rev-parse", "HEAD"], true) !== report.installedHead)
    throw new Error("checked rehearsal head moved; rerun unblock-check");
  if (isRewrite) {
    if (report.ciHead === undefined || report.ciHead !== report.installedHead)
      throw new Error("checked report has no CI verdict for the installed head");
    if (remoteLaneHead(runner, worktree, lane.branch, true) !== report.ciHead)
      throw new Error("pushed rehearsal lane moved after the CI verdict; rerun unblock-check");
  }
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
  // Freeze the reusable resolutions before publication. Recovery must not depend
  // on a mutable rr-cache which a later walk may have already changed.
  const rerereSnapshot = saveRerereCache(worktree, `rerere: applied ${report.installedHead}`);
  if (isRewrite) {
    if (rewrite?.archive === undefined)
      throw new Error("rewrite apply lost its pre-rewrite archive binding");
    const archive = rewrite.archive;
    report = {
      ...report,
      rewrite: {
        ...rewrite,
        archive: { ...archive, verification: retainRewriteArchive(runner, worktree, archive) },
      },
    };
    // Persist the verified archive before any later publication can fail. The reviewed record
    // renders only the immutable ref/SHA binding, so this readback does not change its digest.
    writeReport(report);
  }
  const recordCommentUrl =
    report.recordCommentUrl ??
    requireSuccess(
      runner,
      "gh",
      [
        "issue",
        "comment",
        String(report.issue.number),
        "-R",
        REPOSITORY,
        "--body-file",
        recordPath,
      ],
      worktree,
    ).trim();
  if (isRewrite && report.recordCommentUrl === undefined) {
    report = { ...report, recordCommentUrl };
    writeReport(report);
  }
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
  if (push.status !== 0 || push.error !== undefined) {
    const pushFailure = push.error?.message ?? (push.stderr.trim() || push.stdout.trim());
    if (isRewrite && report.rewrite?.archive?.verification !== undefined) {
      const archive = report.rewrite.archive;
      const verification = archive.verification;
      if (verification === undefined)
        throw new Error("rewrite archive lost its verified remote readback");
      report = {
        ...report,
        rewrite: {
          ...report.rewrite,
          archive: {
            ...archive,
            verification: { ...verification, trunkOutcome: "failed" },
          },
        },
      };
      writeReport(report);
      throw new Error(
        `leased apply refused; rewrite archive ${archive.ref}@${archive.sha} retained as failed-attempt evidence; this report cannot be refreshed: ${pushFailure}`,
      );
    }
    throw new Error(`leased apply refused; this report cannot be refreshed: ${pushFailure}`);
  }
  const appliedRewrite =
    isRewrite && report.rewrite?.archive?.verification !== undefined
      ? {
          ...report.rewrite,
          archive: {
            ...report.rewrite.archive,
            verification: {
              ...report.rewrite.archive.verification,
              trunkOutcome: "applied" as const,
            },
          },
        }
      : report.rewrite;
  report = {
    ...report,
    stage: "applied",
    recordCommentUrl,
    ...(appliedRewrite === undefined ? {} : { rewrite: appliedRewrite }),
    rererePublication: {
      state: "pending",
      snapshot: rerereSnapshot,
    },
  };
  writeReport(report);
  // The trunk has moved, so the row is owed now. Everything after this line can fail without
  // losing the walk from the ledger; a step that runs after this invocation cannot
  // (RSI-Software/t3code-hyprws#664). A rewrite keeps the fork's current base, so it has no new
  // tag to record and would only collide with the row that base already carries.
  if (!isRewrite) report = publishChurnRow(report, gateTag);
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
  // Only the rewrite lane ever pushed its rehearsal branch, so only it has one to retire.
  if (isRewrite) git(runner, worktree, ["push", "origin", "--delete", lane.branch], true);
  report = resumeRererePublication(report);
  // Collected after the cache publication so the retained receipts carry its result, and before
  // `applied` so the invocation never reports a walk the ledger cannot show.
  if (!isRewrite) {
    report = publishWalkOutcomes(report);
    report = {
      ...report,
      walk: { ...(report.walk ?? {}), ledger: { state: "published", tag: gateTag } },
    };
    writeReport(report);
    process.stdout.write(`ledger: ${gateTag} row and outcomes on ${CHURN_REF}\n`);
  }
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

class AutoStop extends Error {
  readonly reportPath: string;
  constructor(reportPath: string) {
    super("walk stopped at a retained conflict");
    this.reportPath = reportPath;
  }
}
class AutoBotRefusal extends Error {
  readonly reportPath: string;

  constructor(message: string, reportPath: string) {
    super(message);
    this.reportPath = reportPath;
  }
}
class AutoFailure extends Error {
  readonly reportPath: string;
  readonly phase: "unblock-auto" | "unblock-rehearse" | "unblock-check" | "unblock-apply";

  constructor(message: string, reportPath: string, phase: AutoFailure["phase"]) {
    super(message);
    this.reportPath = reportPath;
    this.phase = phase;
  }
}

/**
 * The walk has exactly two legal stops, and each one leaves the same three things behind: the
 * reason on the report, the reason on stdout for the notification issue, and exit code 2. Anything
 * else that halts a walk is a defect, not a handoff.
 */
class RepairStop extends Error {
  readonly failure: RepairFailure;
  readonly reportPath: string;

  constructor(failure: RepairFailure, reportPath: string) {
    super(`${failure.kind === "environment" ? "environment" : "repair"}: ${failure.command}`);
    this.failure = failure;
    this.reportPath = reportPath;
  }
}

/**
 * The purely-additive check found something no mechanical fix may clear — a shrunk upstream test,
 * an unremovable re-added block, a migration the registry cannot give up its number for. The
 * findings are the walk's confession: only a maintainer decides them.
 */
class AdditiveStop extends Error {
  readonly findings: ReadonlyArray<AdditiveFinding>;
  readonly reportPath: string;

  constructor(findings: ReadonlyArray<AdditiveFinding>, reportPath: string) {
    super("walk stopped at a replay that is not purely additive");
    this.findings = findings;
    this.reportPath = reportPath;
  }
}

/**
 * The rehearsal resumed on a handoff nobody finished: a record row still on `TODO`, a conflict
 * still unmerged, or a resolution nobody staged. Every one of those rows belongs to a human, which
 * is the `conflict` stop the walk already owns — so it leaves the walk as that stop and never as
 * an unclassified crash (RSI-Software/t3code-hyprws#747).
 */
class HandoffIncomplete extends Error {
  readonly gaps: ReadonlyArray<string>;

  constructor(gaps: ReadonlyArray<string>) {
    super(`the conflict handoff is incomplete:\n${gaps.map((gap) => `  - ${gap}`).join("\n")}`);
    this.gaps = gaps;
  }
}

/**
 * `hyprws` moved under the walk, so every binding it holds is void. The walk re-lists and re-reads
 * the moved trunk itself: a restart is mechanical, and asking a human to type it was never a
 * decision anyone made.
 */
class WalkStale extends Error {}

const STALE_TRUNK =
  /staleness: origin\/hyprws moved|voided the walk lease|lease .* is no longer live/;

export const isStaleTrunk = (error: unknown): boolean =>
  error instanceof WalkStale ||
  (error instanceof Error && STALE_TRUNK.test(error.message)) ||
  (error instanceof AutoFailure && STALE_TRUNK.test(error.message));

/**
 * Orientation stops cohering for two different reasons, and they are not the same stop. The trunk
 * moving is the walk's own race: it re-lists and walks again. Anything else — a stale mirror, a tag
 * that moved, a block the target no longer contains — is the environment the walk was handed, and
 * the walk cannot fix it from inside the lane.
 */
/** The environment stop the walk takes when the refs moved under it and the trunk did not. */
const unreplayableLane = (reason: string): string =>
  `Orientation does not cohere with the live refs and the trunk did not move, so the walk was handed a lane it cannot replay: ${reason}.`;

const trunkMoved = (report: SyncReport, runner: CommandRunner): boolean => {
  const leased = report.source?.expectedOld;
  if (leased === undefined) return false;
  const live = runner.run("git", ["rev-parse", "origin/hyprws^{commit}"], report.repositoryRoot);
  return live.status === 0 && live.stdout.trim().length > 0 && live.stdout.trim() !== leased;
};

const stopAuto = (surface: string, reportPath: string): never => {
  process.stdout.write(`${surface.trimEnd()}\n`);
  throw new AutoStop(reportPath);
};

/**
 * Record the stop before raising it, so the report the workflow uploads and the issue body it
 * posts carry the same sentence.
 */
const stopWalk = (
  report: SyncReport,
  reason: WalkStopReason,
  detail: string,
  started: number,
): never => {
  const stopped: SyncReport = {
    ...report,
    walk: { ...(report.walk ?? {}), elapsedMs: Date.now() - started, stop: { reason, detail } },
  };
  writeReport(stopped);
  return stopAuto(
    `${stopped.reportPath}\nStop (${reason}). ${detail}\n${walkSummary(stopped)}`,
    stopped.reportPath,
  );
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
  if (report.kind === "rewrite" && head !== report.rewrite?.build?.result)
    throw new Error("rewrite refresh cannot replace its constructed head; rebuild a new proposal");
  // The head and the stack size are one binding: the gate reads both from the record and compares
  // them against the same checkout, so refreshing one and not the other publishes a record that
  // disagrees with itself and blocks the apply for a lane that is entirely healthy.
  const next = {
    ...report,
    stage: "replayed" as const,
    rebasedHead: head,
    stackSize: Number(
      git(runner, report.lane.worktree, [
        "rev-list",
        "--count",
        `${report.target?.sha ?? ""}..HEAD`,
      ]),
    ),
    verification: [],
    conflicts: report.conflicts.map((row) =>
      row.class === "generated" && row.agentSafe === "yes — regenerated by unblock-rehearse"
        ? completeGeneratedConflictRegeneration(row)
        : row,
    ),
  };
  delete next.installedHead;
  delete next.ciHead;
  delete next.proposedBy;
  delete next.nightlyReview;
  // A refresh rebinds the head and the stack size; it is not a second opinion about a decision.
  // `unblock-check` already keeps a cell the operator filled, and the refresh has to keep it too:
  // without this the rebind re-mints every `Decided by` cell back to `TODO`, and `unblock-apply`
  // then refuses one verb later on answers nobody withdrew (RSI-Software/t3code-hyprws#695).
  const preserved = preserveRecordDecisions(next);
  writeReport(preserved);
  writeRecord(preserved);
  return preserved;
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

export const rewriteBindingMatches = (
  report: SyncReport,
  receipt: RewriteBuildReceipt,
): boolean => {
  const rewrite = report.rewrite;
  return (
    report.kind === "rewrite" &&
    report.botCarried !== true &&
    rewrite?.build !== undefined &&
    rewrite.allowExtra === 0 &&
    rewrite.allowPaths.length === 0 &&
    rewrite.baseToOriginCount === receipt.slots.length &&
    rewrite.baseToFromCount === receipt.slots.length &&
    report.originalCount === receipt.slots.length &&
    rewrite.build.manifestSha256 === receipt.manifestSha256 &&
    rewrite.build.result === receipt.result &&
    rewrite.fromSha === receipt.result &&
    rewrite.originSha === receipt.source &&
    rewrite.base === receipt.base &&
    rewrite.baseTag === receipt.baseTag &&
    report.source?.sha === receipt.source &&
    report.source.expectedOld === receipt.source &&
    report.source.sharedBase === receipt.base &&
    report.target?.sha === receipt.base &&
    report.target.tag === receipt.baseTag &&
    report.rebasedHead === receipt.result &&
    (report.installedHead === undefined || report.installedHead === receipt.result) &&
    (report.ciHead === undefined || report.ciHead === receipt.result) &&
    rewrite.outcomeTarget?.target.sha === receipt.base &&
    rewrite.outcomeTarget.target.tag === receipt.baseTag
  );
};

/**
 * Why the report's bindings no longer match the live refs, or `null` when they still do. The walk
 * needs the reason, not just the verdict: an incoherence that the trunk moving explains is a
 * restart, and one it does not is the environment stop a human has to read.
 */
const orientationIncoherence = (report: SyncReport, runner: CommandRunner): string | null => {
  if (report.kind === "rewrite") {
    const build = report.rewrite?.build;
    if (build === undefined) return "the report carries no rewrite build receipt";
    const receipt = verifyRewriteBuild(
      report.repositoryRoot,
      build.manifestPath,
      build.receiptPath,
    );
    if (!rewriteBindingMatches(report, receipt))
      return "the rewrite build receipt no longer matches the report";
    const live = readIssue(runner, report.repositoryRoot);
    return live.number === report.issue.number &&
      extractBlockingSha(live.body) === report.issue.blockingSha
      ? null
      : "the blocking issue moved under the rewrite";
  }
  if (
    report.target === undefined ||
    report.source === undefined ||
    report.orientation === undefined
  )
    return "the report has no target, source, or orientation to cohere with";
  const root = report.repositoryRoot;
  const source = git(runner, root, ["rev-parse", "origin/hyprws^{commit}"]);
  const liveTarget = git(runner, root, ["rev-parse", `refs/tags/${report.target.tag}^{commit}`]);
  const sharedBase = git(runner, root, ["merge-base", source, liveTarget]);
  const reasons: Array<string> = [];
  if (
    runner.run(
      "git",
      ["merge-base", "--is-ancestor", report.issue.blockingSha, report.target.sha],
      root,
    ).status !== 0
  )
    reasons.push(
      `${report.target.tag} does not contain blocking commit ${report.issue.blockingSha}`,
    );
  if (report.target.sha !== liveTarget)
    reasons.push(`${report.target.tag} now resolves to ${liveTarget}, not ${report.target.sha}`);
  if (report.source.sha !== source || report.source.expectedOld !== source)
    reasons.push(`origin/hyprws is at ${source}, leased at ${report.source.expectedOld}`);
  if (report.source.sharedBase !== sharedBase)
    reasons.push(`the shared base is ${sharedBase}, oriented at ${report.source.sharedBase}`);
  if (
    !/^mirror:\s+origin\/main matches upstream\/main at [0-9a-f]{7,64}$/m.test(report.orientation)
  )
    reasons.push("origin/main does not mirror upstream/main");
  return reasons.length === 0 ? null : reasons.join("; ");
};

const orientationCoheres = (report: SyncReport, runner: CommandRunner): boolean =>
  orientationIncoherence(report, runner) === null;

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

export type AutoConflictResolution =
  | { readonly kind: "resolved"; readonly report: SyncReport }
  | {
      readonly kind: "unresolved";
      readonly rows: ReadonlyArray<
        UnresolvedOutcome & { readonly subject: string; readonly seamKey: string | null }
      >;
      /** The report's conflict rows with the executor's decisions applied: only the declined rows
       * remain for a human, and they carry the seam keys captured while the stages existed. */
      readonly conflicts: ReadonlyArray<ConflictRow>;
      /** Records the walk already made before it stopped: the executor's outcomes. */
      readonly decisions: ReadonlyArray<WalkDecision>;
    };

/** The walk tag and stamp every decision this walk records carries. */
const decisionStamp = (
  report: SyncReport,
): { readonly tag: string; readonly recordedAt: string } => ({
  tag: report.target?.tag ?? "unknown",
  recordedAt: report.walk?.startedAt ?? new Date().toISOString(),
});

/** The outcome a conflict decision records, in the walk's own vocabulary. */
const decisionOutcome = (take: "ours" | "theirs" | "merge" | "union"): string =>
  take === "ours" || take === "theirs" ? take : "keep-both";

/** Seam key for a conflicted path while its index stages still exist; `null` otherwise. */
const seamKeyFor = (runner: CommandRunner, worktree: string, path: string): string | null => {
  const stages = readConflictStages(runner, worktree, path);
  return stages === null ? null : seamKey(runner, worktree, { path, ...stages });
};

/**
 * What earlier walks recorded per seam key, so a rerere replay names the walk and the outcome it
 * resolved from instead of silently re-deciding (RSI-Software/t3code-hyprws#662). A missing or
 * unreadable ledger means no prior record, never a stop.
 */
const priorDecisionLookup = (root: string): ((key: string) => WalkDecision | null) => {
  let prior = new Map<string, WalkDecision>();
  try {
    prior = new Map(
      readChurnLedger(root)
        .flatMap((row) => row.walkDecisions ?? [])
        .filter(
          (row) =>
            row.kind === "conflict" &&
            row.decidedBy !== "machine" &&
            /^[0-9a-f]{64}$/.test(row.subject),
        )
        .map((row) => [row.subject, row]),
    );
  } catch {
    return () => null;
  }
  return (key: string) => prior.get(key) ?? null;
};

/**
 * Machine conflict ownership, in two passes. rerere replays what a previous walk already decided;
 * the outcome executor decides the remainder from fork doctrine. Only a row the executor declines
 * reaches a human, and it arrives with the reason attached.
 */
export const autoResolveConflicts = (
  report: SyncReport,
  runner: CommandRunner,
): AutoConflictResolution => {
  if (report.lane === undefined) throw new Error("rehearsal lane is missing");
  const worktree = report.lane.worktree;
  const pending = pendingAutoConflictRows(report);
  const candidates = pending.filter((row) => row.class !== "generated");
  let remaining: ReadonlySet<string>;
  try {
    remaining = new Set(
      lines(git(runner, worktree, ["-c", "rerere.enabled=true", "rerere", "remaining"], true)),
    );
  } catch {
    // No rerere verdict means no reusable resolution, not a stop: every row falls to the executor.
    remaining = new Set(candidates.map(({ path }) => path));
  }
  const stamp = decisionStamp(report);
  const priorDecision = priorDecisionLookup(report.repositoryRoot);
  const keys = new Map<ConflictRow, string>();
  const decisions: Array<WalkDecision> = [];
  const decided = new Map<ConflictRow, Pick<ConflictRow, "class" | "resolution">>();
  const unresolved: Array<
    UnresolvedOutcome & { readonly subject: string; readonly seamKey: string | null }
  > = [];
  for (const row of candidates) {
    // The seam key is only computable while the index still carries the conflict stages: once the
    // row is resolved or staged they are gone, and this key is what ties the row to a record.
    const key = seamKeyFor(runner, worktree, row.path);
    if (key !== null) keys.set(row, key);
    if (isRerereRow(row) && rererePathIsClean(row, remaining, worktree, runner)) {
      const prior = key === null ? null : priorDecision(key);
      decided.set(row, {
        class: "mechanical",
        resolution:
          prior === null
            ? "rerere replay"
            : `rerere replay: ${prior.tag} resolved ${prior.outcome}`,
      });
      decisions.push({
        kind: "conflict",
        subject: key ?? row.path,
        path: row.path,
        outcome: prior?.outcome ?? "rerere replay",
        decidedBy: "rerere",
        ...stamp,
        ...(prior === null ? {} : { from: prior.tag }),
      });
      continue;
    }
    // Supersession evidence deliberately plays no part here: gate 4 keeps the commit, so taking
    // the upstream side of its files would keep the commit and drop the behaviour it carries.
    const outcome = executeConflictOutcome(runner, worktree, row.path);
    if (isUnresolved(outcome)) {
      unresolved.push({ ...outcome, subject: row.subject, seamKey: key });
      continue;
    }
    decided.set(row, { class: outcome.conflictClass, resolution: outcome.resolution });
    decisions.push({
      kind: "conflict",
      subject: key ?? row.path,
      path: row.path,
      outcome: decisionOutcome(outcome.take),
      decidedBy: "machine",
      ...stamp,
    });
  }
  if (unresolved.length > 0)
    return {
      kind: "unresolved",
      rows: unresolved,
      decisions,
      conflicts: report.conflicts.map((row) => {
        const outcome = decided.get(row);
        if (outcome === undefined) return row;
        const key = keys.get(row);
        return {
          ...row,
          ...outcome,
          agentSafe: "true",
          decidedBy: "agent",
          ...(key === undefined ? {} : { seamKey: key }),
        };
      }),
    };
  // Format the resolutions here, inside the conflict, so the fix is part of the replayed commit.
  const format = formatCommand([...new Set(candidates.map(({ path }) => path))]);
  if (format !== null) {
    const outcome = runRepairs(runner, worktree, [format], laneEnv(worktree));
    if (outcome.failure !== undefined) throw new RepairStop(outcome.failure, report.reportPath);
  }
  const next: SyncReport = {
    ...report,
    ...(decisions.length === 0 ? {} : { decisions: [...(report.decisions ?? []), ...decisions] }),
    conflicts: report.conflicts.map((row) => {
      if (!pending.includes(row)) return row;
      if (row.class === "generated") return { ...row, decidedBy: "agent" };
      const outcome = decided.get(row);
      if (outcome === undefined) return row;
      const key = keys.get(row);
      return {
        ...row,
        ...outcome,
        agentSafe: "true",
        decidedBy: "agent",
        ...(key === undefined ? {} : { seamKey: key }),
      };
    }),
  };
  writeReport(next);
  writeRecord(next);
  for (const path of new Set(pending.map(({ path }) => path)))
    git(runner, worktree, ["add", "--", path], true);
  return { kind: "resolved", report: next };
};

const MINIMUM_LITERAL_LENGTH = 12;
const IDENTIFIER_LIMIT = 40;

/** A settings key is only distinctive once it looks namespaced; `name` matches every tree. */
const isDistinctiveKey = (key: string): boolean => key.length >= 6 && /[.\-A-Z]/.test(key);

/**
 * The names a fork commit introduces: exported bindings, test titles, settings keys, and long
 * string literals. Conflicting near upstream work is not evidence that upstream implemented the
 * fork behaviour; finding one of these names in the target tree is. A module specifier and a
 * fixture literal are neither name nor behaviour, so neither reaches the probe
 * (RSI-Software/t3code-hyprws#750).
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
    if (isModuleSpecifierLine(added)) continue;
    for (const match of added.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const literal = match[2] ?? "";
      if (literal.length < MINIMUM_LITERAL_LENGTH || literal.includes("${")) continue;
      if (isFixtureLiteral(literal)) continue;
      found.add(literal);
    }
  }
  return [...found].filter((value) => value.trim().length > 0).slice(0, IDENTIFIER_LIMIT);
};

/**
 * Greps the target tag's tree for identifiers the fork commit introduced, over product source only
 * and counting a hit only where the name is defined or imported in a file type the commit itself
 * changed. Proximity is not evidence, and neither is prose (RSI-Software/t3code-hyprws#688).
 */
export const retireCandidateMatches = (
  runner: CommandRunner,
  root: string,
  targetSha: string,
  identifiers: ReadonlyArray<string>,
  extensions: ReadonlySet<string>,
): RetireEvidence["matches"] => {
  if (identifiers.length === 0 || extensions.size === 0) return [];
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
      "--",
      ...RETIRE_PROBE_EXCLUSIONS,
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
    const path = parsed[1] ?? "";
    const text = parsed[3] ?? "";
    // A rejected hit never marks its identifier seen: the first line that names it is often the
    // mention, and the definition that would prove the retirement comes later in the same tree.
    const identifier = identifiers.find(
      (value) =>
        !seen.has(value) &&
        text.includes(value) &&
        isRetireEvidenceSite(value, path, text, extensions),
    );
    if (identifier === undefined) continue;
    seen.add(identifier);
    matches.push({ identifier, location: `${path}:${parsed[2] ?? ""}` });
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
    const diff = gitRaw(runner, root, ["show", "--format=", "--unified=0", "--no-color", commit]);
    const identifiers = forkCommitIdentifiers(diff);
    if (identifiers.length === 0) return [];
    return [
      {
        subject: row.subject,
        commit,
        identifiers,
        matches: retireCandidateMatches(
          runner,
          root,
          targetSha,
          identifiers,
          forkCommitSourceExtensions(diff),
        ),
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
 * Gate 4 is the machine's own decision pass. Every candidate is kept and every kept row names the
 * evidence that earned it, because a walk that removes fork behaviour on its own is a product
 * decision no unattended run is entitled to make. A candidate upstream appears to carry already is
 * still kept, and the report says so, so a maintainer can retire it deliberately later.
 */
export const autoGateFour = (report: SyncReport): SyncReport => {
  const evidence = retireEvidenceFor(report);
  return {
    ...report,
    orientationDecisions: (report.orientationDecisions ?? []).map((row) => ({
      ...row,
      ...(row.verdict === "candidate"
        ? {
            action: (evidence.get(row.subject)?.matches.length
              ? "keep (target tree present)"
              : evidence.has(row.subject)
                ? "keep (target tree absent)"
                : "keep (mechanical seam)") as DecisionAction,
          }
        : {}),
      // A keep/retire/partial verdict was read from the human-owned retirement ledger in
      // `docs/internals/fork-delta.md`, so it stays the human's decision, and an inherited verdict
      // keeps saying which walk it came from. Only a candidate the machine kept is the machine's.
      decidedBy:
        row.decidedBy !== "TODO" ? row.decidedBy : row.verdict === "candidate" ? "agent" : "human",
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

/**
 * The unattended walk: one invocation carries an eligible tag from selection to trunk.
 *
 * Every stage below runs without a prompt. Conflicts belong to rerere and the outcome executor,
 * decisions belong to the machine, and verification is the in-lane repair pass plus the existing
 * guards. Trunk CI confirms the applied stack afterwards; it is not consulted mid-walk, because a
 * verdict the walk cannot act on is only a round trip.
 */
const walkOnce = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
  started: number,
  relist: boolean,
): SyncReport => {
  const botCarried = values.has("--bot-carried");
  const reportPath = oneValue(values, "--report", false);

  // A report already on disk is a walk in flight — an earlier invocation that a moved trunk, a
  // crashed runner or a stop left standing. The walk picks it up from the stage it reached; it
  // never asks to be told to. A restart after the trunk moved is the one case that throws the
  // in-flight report away, because everything in it was measured against a base that is gone.
  const carried = !relist && reportPath !== null && NodeFS.existsSync(reportPath);
  let report: SyncReport;
  if (carried) {
    report = readReport(reportPath);
    if (botCarried && report.botCarried !== true)
      throw new UsageError("--bot-carried cannot continue a report the human lane started");
  } else {
    const listValues = new Map<string, string>();
    if (reportPath !== null) listValues.set("--output", reportPath);
    report = captureStdout(() =>
      unblockList(listValues, cwd, runner, values.has("--target")),
    ).value;
  }
  report = {
    ...report,
    ...(botCarried ? { botCarried: true } : {}),
    walk: {
      ...(report.walk ?? {}),
      startedAt: report.walk?.startedAt ?? new Date(started).toISOString(),
    },
  };
  writeReport(report);

  let executingPhase: AutoFailure["phase"] = "unblock-auto";
  try {
    if (report.stage !== "applied") {
      if (carried) {
        // Time passed between the invocation that wrote this report and this one, so every
        // binding it carries is re-read against the live trunk before the walk trusts it.
        ensureLeaseCurrent(report, runner);
        report = refreshAutoBotSnapshot(report, runner);
        const carriedIncoherence =
          report.target === undefined ? null : orientationIncoherence(report, runner);
        if (carriedIncoherence !== null) {
          if (trunkMoved(report, runner))
            throw new WalkStale(`${report.reportPath}\n${carriedIncoherence}`);
          return stopWalk(report, "environment", unreplayableLane(carriedIncoherence), started);
        }
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
      const orientedIncoherence = orientationIncoherence(report, runner);
      if (orientedIncoherence !== null) {
        if (trunkMoved(report, runner))
          throw new WalkStale(`orientation is stale against the trunk\n${orientedIncoherence}`);
        return stopWalk(report, "environment", unreplayableLane(orientedIncoherence), started);
      }
      report = {
        ...report,
        walk: {
          ...(report.walk ?? {}),
          baseMove: {
            from: report.source?.sharedBase ?? "unknown",
            to: `${selected.target.tag}@${selected.target.sha}`,
          },
        },
      };
      writeReport(report);
    }

    while (report.stage === "oriented" || report.stage === "conflicts") {
      executingPhase = "unblock-rehearse";
      const rehearsal = captureStdout(() =>
        unblockRehearse(new Map([["--report", report.reportPath]]), cwd, runner),
      );
      report = rehearsal.value;
      executingPhase = "unblock-auto";
      if (report.stage !== "conflicts") continue;
      const resolution = autoResolveConflicts(report, runner);
      if (resolution.kind === "unresolved") {
        // The stop itself is a record: the declined rows are the human's to decide, and
        // record-decisions upgrades this stopped row once the maintainer resolves (#662).
        const stamp = decisionStamp(report);
        const stopDecisions: ReadonlyArray<WalkDecision> = resolution.rows.map(({ path }) => ({
          kind: "stop",
          subject: path,
          path,
          outcome: "conflict",
          decidedBy: "human",
          ...stamp,
        }));
        // The keys were computed while the stages existed; they must survive onto the stopped
        // report or record-decisions could no longer name the seam the human resolved. Rows the
        // executor already decided carry their outcome, so only declined rows reach the human.
        const seamKeys = new Map(
          resolution.rows
            .filter((row) => row.seamKey !== null)
            .map((row) => [row.path, row.seamKey as string]),
        );
        return stopWalk(
          {
            ...report,
            decisions: [...(report.decisions ?? []), ...resolution.decisions, ...stopDecisions],
            conflicts: resolution.conflicts.map((row) => {
              const key = seamKeys.get(row.path);
              return key === undefined || row.seamKey !== undefined
                ? row
                : { ...row, seamKey: key };
            }),
          },
          "conflict",
          [
            "The outcome executor cannot produce a result for:",
            ...resolution.rows.map(
              ({ path, subject, reason }) => `  - ${path} (${subject}): ${reason}`,
            ),
          ].join("\n"),
          started,
        );
      }
      report = resolution.report;
    }

    if (report.stage === "replayed") {
      const silentSeamEntries = values.has("--silent-seam")
        ? values.get("--silent-seam")!.split("\n").filter(Boolean)
        : [];
      const checkArgs = new Map<string, string>([["--report", report.reportPath]]);
      // parseVerbArgs joins repeated --silent-seam with newline; unblockCheck splits again
      if (silentSeamEntries.length > 0)
        checkArgs.set("--silent-seam", silentSeamEntries.join("\n"));
      executingPhase = "unblock-check";
      report = captureStdout(() => unblockCheck(checkArgs, cwd, runner)).value;
      executingPhase = "unblock-auto";
    }

    if (report.stage === "checked") {
      report = autoGateFour(report);
      writeReport(report);
      writeRecord(report);
      report = refreshAutoBotSnapshot(report, runner);
      const preApplyIncoherence = orientationIncoherence(report, runner);
      if (preApplyIncoherence !== null) {
        if (trunkMoved(report, runner))
          throw new WalkStale("orientation is stale against the trunk before apply");
        return stopWalk(report, "environment", unreplayableLane(preApplyIncoherence), started);
      }
      validateAutoLane(report, runner);
      executingPhase = "unblock-apply";
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
      executingPhase = "unblock-auto";
      // The apply's own output is captured, so the walk restates the ledger state it reached.
      process.stdout.write(
        `ledger: ${report.walk?.ledger?.state ?? "unknown"} on ${CHURN_REF}\napplied: ${report.target?.tag ?? "unknown"}\n`,
      );
    }

    if (report.stage === "applied" && report.rererePublication?.state === "pending")
      report = resumeRererePublication(report);

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

    report = { ...report, walk: { ...(report.walk ?? {}), elapsedMs: Date.now() - started } };
    writeReport(report);
    // The stop surface leads with the report path; so does the applied surface, so a caller can
    // always find the full report the summary summarizes.
    process.stdout.write(`${report.reportPath}\n`);
    process.stdout.write(walkSummary(report));
    return report;
  } catch (error) {
    // The trunk moved and the ledger did not, so the walk owns the stop: it is the only lane
    // that still knows which row is missing (RSI-Software/t3code-hyprws#664).
    if (error instanceof LedgerUnpublished)
      return stopWalk(error.report, "environment", error.message, started);
    if (error instanceof RepairStop)
      return stopWalk(
        report,
        error.failure.kind === "environment" ? "environment" : "conflict",
        error.failure.kind === "environment"
          ? `The lane cannot test: ${error.failure.command}\n${error.failure.detail}`
          : `The replayed resolutions do not hold: ${error.failure.command}\n${error.failure.detail}`,
        started,
      );
    if (error instanceof AdditiveStop) {
      // The check wrote its findings to the report before stopping, so the retained report — not
      // this invocation's older copy — is what the stop summary must speak from.
      let stopped = report;
      try {
        stopped = readReport(error.reportPath);
      } catch {
        // Fall back to the in-memory report; the stop reason still names the findings.
      }
      return stopWalk(
        stopped,
        "conflict",
        [
          "The replayed tree is not purely additive; no mechanical fix makes it pass:",
          ...error.findings.map(({ check, path, detail }) => `  - ${check} ${path}: ${detail}`),
        ].join("\n"),
        started,
      );
    }
    if (error instanceof HandoffIncomplete)
      return stopWalk(
        report,
        "conflict",
        ["The conflict handoff is incomplete:", ...error.gaps.map((gap) => `  - ${gap}`)].join(
          "\n",
        ),
        started,
      );
    if (error instanceof AutoStop || error instanceof AutoBotRefusal || error instanceof WalkStale)
      throw error;
    if (isStaleTrunk(error))
      throw new WalkStale(error instanceof Error ? error.message : String(error));
    throw new AutoFailure(
      error instanceof Error ? error.message : String(error),
      report.reportPath,
      executingPhase,
    );
  }
};

/**
 * A walk that applied before this one and lost its ledger write left the trunk it moved with no
 * row. The retained report is the only place that binding still exists, so the next walk pays the
 * debt before it moves the trunk again. Only the tag the trunk currently carries: an older gap is
 * a backfill against objects and issue threads this lane cannot re-derive
 * (RSI-Software/t3code-hyprws#666).
 */
const healCurrentTrunkRow = (values: ReadonlyMap<string, string>, runner: CommandRunner): void => {
  const reportPath = oneValue(values, "--report", false);
  if (reportPath === null || !NodeFS.existsSync(reportPath)) return;
  let report: SyncReport;
  try {
    report = readReport(reportPath);
  } catch {
    return;
  }
  const tag = report.target?.tag;
  if (
    report.stage !== "applied" ||
    report.kind === "rewrite" ||
    tag === undefined ||
    report.installedHead === undefined ||
    report.source === undefined
  )
    return;
  const root = report.repositoryRoot;
  const live = runner.run("git", ["rev-parse", "origin/hyprws^{commit}"], root);
  if (live.status !== 0 || live.stdout.trim() !== report.installedHead) return;
  fetchBotRef(root, CHURN_REF);
  const existing = readChurnLedger(root).find((entry) => entry.tag === tag);
  // A pending row is a stopped walk's decision record; the applied trunk's append upgrades it.
  if (existing !== undefined && existing.pending !== true) return;
  if (!NodeFS.existsSync(report.recordPath)) {
    process.stderr.write(
      `warning: ${CHURN_REF} has no row for the applied trunk tag ${tag} and ${report.recordPath} is gone; the row needs a backfill\n`,
    );
    return;
  }
  publishWalkOutcomes(publishChurnRow(report, tag));
  process.stdout.write(`ledger: appended the missing ${tag} row to ${CHURN_REF}\n`);
};

const unblockAuto = (
  values: ReadonlyMap<string, string>,
  cwd: string,
  runner: CommandRunner,
): SyncReport => {
  assertOnly(values, ["--target", "--report", "--bot-carried", "--silent-seam"]);
  const started = Date.now();
  try {
    healCurrentTrunkRow(values, runner);
  } catch (error) {
    if (!(error instanceof LedgerUnpublished)) throw error;
    stopWalk(error.report, "environment", error.message, started);
  }
  // One restart, because a trunk that moves twice inside a single walk is a second walk running,
  // not a race worth retrying against.
  for (const attempt of [0, 1]) {
    try {
      return walkOnce(values, cwd, runner, started, attempt === 1);
    } catch (error) {
      if (attempt === 1 || !isStaleTrunk(error)) throw error;
      process.stdout.write(
        `restart: hyprws moved under the walk; re-listing from the moved trunk\n${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  throw new Error("unreachable walk restart");
};

/** The additive outcome rows, shaped the same whether the walk passed on the first pass, fixed on
 * the retry, or stopped: one row per finding, with the drop's coexistence note on `readded`. */
const additiveSummaryRows = (
  additive: NonNullable<WalkRecord["additive"]>,
): ReadonlyArray<string> => {
  const rows = additive.findings.map(
    ({ check, path, detail }) =>
      `  - ${check} ${path}: ${detail}${check === "readded" ? " — consider keeping ours" : ""}`,
  );
  if (!additive.pass) return ["- additive: failed", ...rows];
  if (additive.attempts === 1) return ["- additive: pass (4 checks)"];
  return ["- additive: fixed on retry", ...rows];
};

/** One block the notification issue can carry verbatim. */
const decisionSummaryLine = (decision: WalkDecision): string =>
  `  - \`${decision.subject}\` (${decision.outcome}, ${decision.decidedBy}${
    decision.from === undefined ? "" : `, from ${decision.from}`
  })`;

export const walkSummary = (report: SyncReport): string => {
  const walk = report.walk ?? {};
  const rows = report.conflicts.filter(({ class: klass }) => klass !== "generated");
  return [
    "## Walk",
    `- target: ${report.target === undefined ? "none" : `\`${report.target.tag}@${report.target.sha}\``}`,
    `- base move: ${walk.baseMove === undefined ? "none" : `\`${walk.baseMove.from}\` to \`${walk.baseMove.to}\``}`,
    `- elapsed: ${walk.elapsedMs === undefined ? "unknown" : `${Math.round(walk.elapsedMs / 1000)}s`}`,
    ...(walk.size === undefined
      ? []
      : [
          `- size: ${walk.size.commits} fork commits across ${walk.size.domains.length} domains, ${walk.size.sharedFiles} shared file attributions`,
          ...walk.size.domains.map(
            (row) =>
              `  - ${row.domain}: ${row.commits} commits, +${row.added}/-${row.deleted}, ${row.shared} shared`,
          ),
        ]),
    rows.length === 0
      ? "- conflicts: none"
      : [
          "- conflicts:",
          ...rows.map((row) => `  - \`${row.path}\` [${row.class}]: ${row.resolution}`),
        ].join("\n"),
    ...(() => {
      const decisions = walkDecisionsOf(report);
      return decisions.length === 0
        ? "- decisions: none"
        : ["- decisions:", ...decisions.map(decisionSummaryLine)];
    })(),
    (walk.repairs ?? []).length === 0
      ? "- repairs: none"
      : [
          "- repairs:",
          ...(walk.repairs ?? []).map((row) => `  - \`${row.command}\`: ${row.result}`),
          // The commits the repair left behind, named so the reader can tell the walk's own work
          // from the fork series it replayed.
          ...((walk.repairCommits ?? []).length === 0
            ? ["  - commits: none"]
            : (walk.repairCommits ?? []).map(
                (commit) => `  - commit \`${commit.sha}\`: ${commit.subject}`,
              )),
        ].join("\n"),
    ...(walk.additive === undefined ? [] : additiveSummaryRows(walk.additive)),
    ...(walk.ledger === undefined
      ? []
      : [
          walk.ledger.state === "published"
            ? `- ledger: published (\`${walk.ledger.tag}\`)`
            : `- ledger: unpublished (${walk.ledger.reason ?? "unknown"})`,
        ]),
    walk.stop === undefined ? "- stop: none" : `- stop (${walk.stop.reason}): ${walk.stop.detail}`,
    "",
  ].join("\n");
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
  const manifestArg = values.get("--manifest");
  const allowedFlags = new Set([
    "--from",
    "--issue",
    "--allow-extra",
    "--allow-paths",
    "--dry-run",
    "--manifest",
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
  if (!dryRun && manifestArg === undefined)
    throw new UsageError("rewrite publication requires --manifest from rewrite-build");
  const manifestPath = manifestArg === undefined ? undefined : NodePath.resolve(root, manifestArg);
  const receiptPath = manifestPath === undefined ? undefined : `${manifestPath}.receipt.json`;
  const build =
    manifestPath === undefined || receiptPath === undefined
      ? undefined
      : verifyRewriteBuild(root, manifestPath, receiptPath);
  if (build !== undefined && (allowExtra !== 0 || allowPaths.length !== 0))
    throw new UsageError("constructed rewrites forbid --allow-extra and --allow-paths");
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
  if (build !== undefined && (build.source !== expectedOld || build.result !== fromSha))
    throw new Error("rewrite build source/candidate does not match this proposal");
  const baseOrigin = git(runner, root, ["merge-base", "upstream/main", "origin/hyprws"]);
  const baseFrom = git(runner, root, ["merge-base", "upstream/main", fromSha]);
  if (build !== undefined && build.base !== baseOrigin)
    throw new Error("rewrite manifest base differs from the current upstream shared base");
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
  let outcomeTarget: import("./lib/fork-sync-outcomes.ts").OutcomeTarget | undefined;
  if (build !== undefined) {
    const live = readIssue(runner, root);
    if (issueArg !== undefined && Number(issueArg) !== live.number)
      throw new Error("rewrite issue must match the live blocking issue");
    issueNumber = live.number;
    issueTitle = live.title;
    const marker = extractBlockingSha(live.body);
    if (marker === null) throw new Error("rewrite issue has no blocking marker");
    blockingSha = marker;
    outcomeTarget = readChurnState(root).outcomes.find(
      (row): row is import("./lib/fork-sync-outcomes.ts").OutcomeTarget =>
        row.kind === "target" && row.target.sha === build.base && row.target.tag === build.baseTag,
    );
    if (outcomeTarget === undefined)
      throw new Error(
        "rewrite base has no retained outcome declaration; reconcile reviewed evidence before publication",
      );
  } else if (issueArg !== undefined) {
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
    ...(build === undefined ? {} : { target: { tag: build.baseTag, sha: build.base } }),
    lane: { branch: laneBranch, worktree },
    originalMessages: "",
    originalCount: countFrom,
    conflicts: [],
    verification: [],
    rebasedHead: fromSha,
    stackSize: countFrom,
    rewrite: {
      ...(build === undefined || manifestPath === undefined || receiptPath === undefined
        ? {}
        : {
            build: {
              manifestPath,
              receiptPath,
              manifestSha256: build.manifestSha256,
              result: build.result,
            },
            ...(outcomeTarget === undefined ? {} : { outcomeTarget }),
          }),
      archive: rewriteArchiveBinding(expectedOld),
      from: fromArg,
      fromSha,
      fromShort,
      originSha: expectedOld,
      originShort: originHeadShort,
      base: baseOrigin,
      baseTag: build?.baseTag ?? baseReleaseTag(runner, root, baseOrigin),
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
  if (verb === "unblock-review") return unblockReview(values, cwd, runner);
  if (verb === "unblock-refresh") return unblockRefresh(values, cwd, runner);
  if (verb === "unblock-apply") return unblockApply(values, cwd, runner);
  if (verb === "record-decisions") return recordDecisions(values, cwd, runner);
  if (verb === "rewrite-rehearse")
    return rewriteRehearse(values, cwd, runner) as unknown as SyncReport;
  throw new UsageError(`unknown verb: ${verb}`);
};

// Every refusal states its reason on the first line, so only that line votes. A gate failure that
// quotes CI or Git output must never be reclassified as a refusal by a phrase inside the evidence.
const isPreconditionRefusal = (error: unknown): boolean =>
  (typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>).isPrecondition === true) ||
  (error instanceof Error &&
    /proof failed|same base|commit count|message digest|non-test diff|bot.*paused|bot run is in progress/i.test(
      error.message.split("\n", 1)[0] ?? "",
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
  if (argv[0] === "rewrite-build")
    return runRewriteBuild(argv.slice(1), () => rootFor(runner, cwd));
  let completedReport: SyncReport | null = null;
  let outcomeFailure: string | undefined;
  let outcomePhase = argv[0];
  let outcomeReportPath = argv[argv.indexOf("--report") + 1];
  if (!argv.includes("--report")) outcomeReportPath = undefined;
  try {
    completedReport = execute(argv, cwd, runner);
    return 0;
  } catch (error) {
    outcomeFailure = error instanceof Error ? error.message : String(error);
    if (error instanceof AutoFailure) outcomePhase = error.phase;
    if (
      error instanceof AutoFailure ||
      error instanceof AutoBotRefusal ||
      error instanceof AutoStop
    )
      outcomeReportPath = error.reportPath;
    if (error instanceof AutoStop) return 2;
    if (error instanceof AutoBotRefusal) {
      process.stderr.write(`${error.message}\nreport: ${error.reportPath}\n`);
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
      process.stderr.write(`failed: ${error.message}\nreport: ${error.reportPath}\n`);
      return 1;
    }
    if (error instanceof UsageError) {
      process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    process.stderr.write(`failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (
      ["unblock-auto", "unblock-rehearse", "unblock-check", "unblock-apply"].includes(argv[0] ?? "")
    ) {
      const path = completedReport?.reportPath ?? outcomeReportPath;
      if (path && NodeFS.existsSync(path)) {
        try {
          captureSyncOutcome(readReport(path), outcomePhase, outcomeFailure);
        } catch (error) {
          process.stderr.write(
            `outcome capture failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
