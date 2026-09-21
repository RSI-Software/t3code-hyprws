#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off - The churn ledger is standalone fork operator state.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  acquireBotRefLease,
  CHURN_REF,
  publishBotRefLease,
  pushBotRef,
  resolveBotRef,
} from "./lib/fork-bot-refs.ts";
import { runCommand, runCommandText } from "./lib/fork-command.ts";
import {
  censusChurn,
  enrichCensusSubjects,
  hotSeams,
  parseCensusFiles,
  parseCensusTag,
  parseLedger,
  parseChurnState,
  parseRepairCommits,
  parseSilentSeams,
  readChurnLedger,
  readChurnState,
  writeChurnState,
  writeChurnLedger,
  type CensusFile,
  type CensusSnapshot,
  type ChurnConflict,
  type ChurnEntry,
  type RepairCommit,
} from "./fork-churn-ledger.ts";
import { composeSeamBundle } from "./lib/fork-churn-compose.ts";
import {
  bridgedLegacy,
  censusFilesFromEvidence,
  requireSeamRecords,
} from "./lib/fork-churn-seams.ts";
import { UsageError } from "./lib/fork-cli.ts";
import { FORK_REPOSITORY } from "./lib/fork-policy.ts";
import { parseRecord, type ConflictClass } from "./fork-sync-state.ts";
import { appendDecision, parseDecisionRecords, type WalkDecision } from "./lib/fork-decisions.ts";
import { isToolingRepair } from "./lib/fork-repairs.ts";
import {
  parseSequentialCensusEvidence,
  requireSequentialCensusEvidence,
  type BlockedIssue,
  type RebaseStopCensus,
} from "./lib/fork-rebase-issues.ts";
import { forkLogArguments, parseForkLog } from "./lib/fork-trailers.ts";
import { canonicalizeOutcomeReceiptsForRoot, runOutcome } from "./fork-churn-outcomes.ts";
import {
  readLessonEvidence,
  lessonAssessmentUnavailable,
  resolveLessonSource,
} from "./fork-lesson-guidance.ts";

/**
 * Three seam states block the walk's next step; the report verb turns them into the
 * `report-policy: failed` receipt the outcome ledger retains.
 */
export const blockingSeamLines = (churn: ReturnType<typeof censusChurn>): ReadonlyArray<string> =>
  churn.seams
    .filter((seam) => seam.blocking)
    .map(
      (seam) =>
        `${seam.status}${seam.bridged === "legacy" ? " (bridged: legacy)" : ""}: ${seam.path} / ${seam.subject} (${seam.domain}): ${seam.reason}`,
    );

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

const SHA = /^[0-9a-f]{7,64}$/;

/**
 * The walk's repairs by their trunk SHA, read from the applied range (`before..after`, every
 * commit carrying a `Fork-Repair` trailer — RSI-Software/t3code-hyprws#700). The record's own
 * `## Repair commits` section names lane commits, which die with the lane, so a published row
 * never cites them: a recorded SHA must stay reachable from `hyprws`, and a hand repair made
 * directly on trunk is in the range just like a lane replay append. A repair that only touches
 * walk tooling is marked as such, so the row records it under `fork-meta` without a retroactive
 * trailer (RSI-Software/t3code-hyprws#690).
 */
export const trunkRepairCommits = (
  root: string,
  before: string,
  after: string,
): ReadonlyArray<RepairCommit> => {
  // A recorded SHA the repository no longer resolves must not abort the append: the row degrades
  // to no repair listing rather than citing lane SHAs (#700) or failing the apply. A row that
  // cites nothing is a visible absence a reviewer can question; a throw kills the whole walk.
  for (const endpoint of [before, after]) {
    try {
      runCommandText("git", ["rev-parse", "--verify", "--quiet", `${endpoint}^{commit}`], {
        cwd: root,
      });
    } catch {
      return [];
    }
  }
  return parseForkLog(runCommandText("git", forkLogArguments(before, after), { cwd: root }))
    .filter((commit) => commit.repair !== undefined)
    .map((commit) => {
      const paths = runCommandText("git", ["show", "--name-only", "--format=", commit.sha], {
        cwd: root,
      })
        .split("\n")
        .filter((path) => path.length > 0);
      return isToolingRepair(paths)
        ? { sha: commit.sha, subject: commit.subject, tooling: true as const }
        : { sha: commit.sha, subject: commit.subject };
    });
};

/** Resolve each census commit's subject from the repository while its objects are available. */
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

/**
 * The applied walk's row. `unblock-apply` calls this in the invocation that moved the trunk
 * (RSI-Software/t3code-hyprws#664), so it throws its own failure rather than reporting an exit
 * status a caller would have to translate back into a cause.
 */
export const appendChurnRow = (args: ReadonlyArray<string>, root: string): void => {
  const [push, rest] = takeFlag(args, "--push");
  const [pending, restAfterPending] = takeFlag(rest, "--pending");
  const options = parseOptions(restAfterPending);
  const allowed = new Set(["--record", "--issue", "--tag", "--before", "--after"]);
  for (const option of options.keys())
    if (!allowed.has(option)) throw new UsageError(`unknown option: ${option}`);
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
  // Start from what origin publishes so a checkout that has not seen the newest walk
  // appends to it instead of rebuilding a stale ledger (#631).
  const lease = acquireBotRefLease(root, CHURN_REF, push);
  const entries = readDurableLedger(root);
  if (entries.some((entry) => entry.tag === tag && entry.pending !== true))
    throw new Error(`duplicate tag: ${tag}`);
  const pendingEntry = entries.find((entry) => entry.tag === tag && entry.pending === true);

  const record = NodeFS.readFileSync(recordPath, "utf8");
  const parsed = parseRecord(record, { allowIncomplete: pending });
  interface IssueView {
    readonly body: string;
    readonly url: string;
    readonly comments: ReadonlyArray<{ readonly body: string; readonly url: string }>;
  }
  const issueView = JSON.parse(
    runCommandText(
      "gh",
      ["issue", "view", String(issue), "--repo", FORK_REPOSITORY, "--json", "body,comments,url"],
      { cwd: root },
    ),
  ) as IssueView;
  // A stopped walk is a walk, but its record is not on the issue yet: the stop writes the row
  // before any record is posted, so a pending append without a verbatim match binds the block
  // issue itself and names the record `record-decisions` posts later; the `record-decisions`
  // rewrite then upgrades the URL to the posted comment because the record matches by then
  // (RSI-Software/t3code-hyprws#1057). The applied row keeps the strict pointer: the apply
  // posted the record (or republishes it in place) before the row.
  const recordUrl =
    issueView.comments.find((comment) => comment.body.trim() === record.trim())?.url ??
    (issueView.body.trim() === record.trim() ? issueView.url : undefined) ??
    (pending ? issueView.url : undefined);
  if (recordUrl === undefined)
    throw new Error(`record does not match issue ${issue} body or comments`);
  // The census is provenance for the row, not permission to write it. The block issue's census is
  // live: the sync bot refreshes it whenever a newer upstream tag lands, which can happen while a
  // walk is still replaying the tag it selected. A census about a different tag is not evidence for
  // this row, so it is dropped — refusing instead would lose the ledger row for a walk that landed.
  const liveCensus = parseSequentialCensusEvidence(issueView.body);
  const censusEvidence = liveCensus !== null && liveCensus.targetTag === tag ? liveCensus : null;
  if (liveCensus !== null && censusEvidence === null)
    process.stderr.write(
      `warning: census on issue ${issue} is for ${liveCensus.targetTag}, not ${tag}; ` +
        `the row is written without census evidence\n`,
    );
  const conflicts = parsed.conflicts.map(
    ({ path, commit, subject, domain, class: klass, resolution, decidedBy }) => ({
      path,
      commit,
      subject,
      domain,
      // A pending row keeps its declined rows: the walk stopped them for a human, so the ledger
      // names them human until the applied row records how the walk resolved (#662).
      class: (klass === "TODO" ? "human" : klass) as ConflictClass,
      resolution,
      decidedBy: decidedBy === "TODO" ? "human" : decidedBy,
    }),
  );
  const silentSeams = parseSilentSeams(record);
  // Applied rows cite the applied trunk range, never the lane (#700). A pending row is written
  // from a stopped lane that has not moved trunk, so it keeps the record's lane listing.
  const repairCommits = pending
    ? parseRepairCommits(record)
    : trunkRepairCommits(root, before, after);
  // Every decision the walk recorded, carried from the record's own decision lines. A rewrite
  // keeps both sides: the existing pending row's decisions merged with the new record's — and
  // the sharper pointer wins, so a `record-decisions` rewrite upgrades the stop's issue-URL
  // binding to the posted comment URL once the record matches (#662, RSI-Software/t3code-hyprws#1057).
  let walkDecisions: ReadonlyArray<WalkDecision> = parseDecisionRecords(record);
  if (pendingEntry !== undefined)
    for (const decision of pendingEntry.walkDecisions ?? [])
      walkDecisions = appendDecision(walkDecisions, decision);
  const row: ChurnEntry = {
    tag,
    before,
    after,
    recordUrl,
    conflicts,
    // A pending record legitimately carries fork-commit rows whose Action cell is still TODO
    // (#876). Such a row is not a decision: the applied row's real verdicts and the walkDecisions
    // carry the substance, so the TODO rows are dropped instead of widening the ledger schema.
    decisions: pending
      ? parsed.decisions.filter((row) => (row.verdict as string) !== "TODO")
      : parsed.decisions,
    censusFiles: parseCensusFiles(issueView.body),
    ...(censusEvidence === null ? {} : { censusEvidence }),
    ...(silentSeams.length === 0 ? {} : { silentSeams }),
    ...(repairCommits.length === 0 ? {} : { repairCommits }),
    ...(parsed.additive === undefined ? {} : { additive: parsed.additive }),
    ...(walkDecisions.length === 0 ? {} : { walkDecisions }),
    ...(pending ? { pending: true as const } : {}),
    ...(parsed.nightlyReview === undefined ? {} : { nightlyReview: parsed.nightlyReview }),
  };
  const next =
    pendingEntry === undefined
      ? [...entries, row]
      : entries.map((entry) => (entry.tag === tag ? row : entry));
  const commit = writeChurnLedger(root, next, `churn: ${tag}${pending ? " (decisions)" : ""}`);
  // A null lease only happens on a never-seeded ref, which readDurableLedger already refused.
  if (push && lease !== null) publishBotRefLease(root, lease, commit);
  process.stdout.write(
    `appended ${tag}: ${conflicts.length} conflict(s) on ${CHURN_REF}${push ? " (pushed)" : ""}\n`,
  );
};

/**
 * Assess this walk's lessons without publishing anything: no issue is read, no comment is
 * written, and the receipt the outcome step retains always says `publication:
 * "not-attempted"`. The verdict — unavailable or blocking seams — lands in the outcome
 * ledger, and `fork:scan` remains the seam view agents read.
 */
const report = (args: ReadonlyArray<string>, root: string): number => {
  const options = parseOptions(args);
  for (const option of options.keys())
    if (option !== "--receipt" && option !== "--census")
      throw new UsageError(`unknown option: ${option}`);
  const receiptPath = options.get("--receipt");
  const receipt = (
    policy: string,
    reason?: "lesson-unavailable" | "blocking-seams" | "census-unavailable",
  ) => {
    if (receiptPath === undefined) return;
    const path = NodePath.resolve(root, receiptPath);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(
      path,
      `${JSON.stringify({
        publication: "not-attempted",
        policy,
        ...(reason ? { reason } : {}),
      })}\n`,
    );
  };
  receipt("not-attempted");
  // The live census comes from the rebase job's auto-result artifact (a typed
  // `AutoRebaseResult` on disk), passed explicitly with --census. It is a local file:
  // the report still reads nothing from GitHub. Without the flag the assessment
  // runs on the ledger's landed snapshots only, and the run says so. With it, a
  // live census the artifact cannot provide is a non-passing verdict, never a
  // quiet fall-back to history: the same hole the publication removal closed.
  const censusPath = options.get("--census");
  let currentCensus: CensusSnapshot | null = null;
  let censusUnavailable: string | null = null;
  if (censusPath !== undefined) {
    const resolved = NodePath.resolve(root, censusPath);
    if (!NodeFS.existsSync(resolved))
      throw new Error(`--census file does not exist: ${censusPath}`);
    const malformed = (): Error =>
      new Error(`--census artifact is not a recognizable auto result: ${censusPath}`);
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(resolved, "utf8"));
    const record = (value: unknown): Record<string, unknown> | null =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const envelope = record(parsed);
    const decision = record(envelope?.decision);
    if (envelope === null || envelope.schemaVersion !== 1 || decision === null) throw malformed();
    const stopRecord = record(decision.census);
    if (decision.census !== null && stopRecord === null) throw malformed();
    const blockedRecord = record(envelope.blocked);
    if (envelope.blocked !== null && envelope.blocked !== undefined && blockedRecord === null)
      throw malformed();
    const stop = stopRecord as unknown as RebaseStopCensus | null;
    const blocked = blockedRecord as unknown as BlockedIssue | null;
    // Evidence provenance is validated by the shared census validator - the one
    // base reached through parseSequentialCensusEvidence - so method, version,
    // SHAs, and rows are checked exactly once, where the ledger checks them.
    const evidence =
      stop === null || stop.evidence === undefined
        ? undefined
        : requireSequentialCensusEvidence(stop.evidence);
    if (stop !== null && evidence !== undefined && evidence.targetTag !== stop.targetTag)
      throw new Error(
        `--census evidence targets ${evidence.targetTag} but the stop census targets ${stop.targetTag}: ${censusPath}`,
      );
    // The feasibility overlap conflicts are the structured fallback the block
    // issue body always carried, independent of sequential stop counts: count-only
    // and census-unavailable attempts still assess live evidence through it.
    const fallbackFiles = (): CensusSnapshot | null => {
      const conflicts = blocked?.conflicts;
      if (conflicts === undefined || conflicts.length === 0) return null;
      return {
        tag: blocked?.newestUpstreamTagBeyondWindow ?? stop?.targetTag ?? "unknown",
        fixedAt: null,
        files: conflicts.map((conflict) => ({
          path: conflict.path,
          hunks: conflict.hunks,
          commit: conflict.forkCommitShort,
          subject: conflict.forkSubject,
          domain: conflict.domain ?? "?",
        })),
      };
    };
    if (stop === null) {
      currentCensus = fallbackFiles();
      if (currentCensus === null)
        censusUnavailable =
          (typeof decision.censusUnavailableReason === "string"
            ? decision.censusUnavailableReason
            : null) ?? "the artifact records no blocked conflicts";
    } else if (evidence === undefined) {
      // A legacy count-only measurement retained no stop rows; the overlap
      // conflicts are its live evidence, under the legacy identity basis.
      currentCensus = fallbackFiles();
      if (currentCensus === null)
        censusUnavailable =
          "count-only census carries no typed rows and the artifact records no blocked conflicts";
    } else if (evidence.rows.length === 0 && !evidence.complete) {
      // Truncation to zero rows says nothing about presence; a complete-empty
      // census below is real live absence and stays an observation.
      censusUnavailable = "partial census was truncated to zero rows";
    } else {
      currentCensus = {
        tag: stop.targetTag,
        fixedAt: null,
        files: censusFilesFromEvidence(evidence),
        censusEvidence: evidence,
      } as const;
    }
  } else {
    process.stderr.write("No --census passed; the assessment reads landed history only.\n");
  }
  // A report reads one immutable snapshot; fetching current guidance must not move
  // the retained ref used by local append/record writers.
  const source = resolveLessonSource(root, CHURN_REF, false);
  if (source.raw === null)
    throw new Error(`${CHURN_REF} lesson evidence is unavailable: ${source.detail}`);
  const lessons = readLessonEvidence(source.raw);
  const entries = readDurableLedger(root, lessons.walks);
  const unavailable = lessonAssessmentUnavailable(lessons, source);
  const churn =
    unavailable === null ? censusChurn(entries, currentCensus, lessons.seamRecords) : null;
  if (churn === null) {
    // A missing lesson is a warning, not a job failure: the run already selected a
    // target and the outcome step still records it (RSI-Software/t3code-hyprws#860).
    receipt("failed", "lesson-unavailable");
    process.stdout.write(
      `Lesson assessment unavailable: ${unavailable}; no policy pass is inferred.\n`,
    );
    return 0;
  }
  const failures = blockingSeamLines(churn);
  if (censusUnavailable !== null) {
    process.stderr.write(
      `Live census unavailable: ${censusUnavailable}; the verdict cannot rest on live evidence.\n`,
    );
    if (failures.length === 0) {
      // Live evidence was requested but could not be assessed: that is never a
      // pass, by the same rule as a missing lesson (RSI-Software/t3code-hyprws#860).
      receipt("failed", "census-unavailable");
      process.stdout.write(
        "lesson assessment: live census unavailable; no policy pass is inferred\n",
      );
      return 0;
    }
  }
  receipt(
    failures.length === 0 ? "succeeded" : "failed",
    failures.length === 0 ? undefined : "blocking-seams",
  );
  if (failures.length === 0) {
    process.stdout.write("lesson assessment: no unresolved blocking seam\n");
    return 0;
  }
  // The verdict stays recorded but never fails the job: the carried unblock walk
  // owns seam resolution and the outcome ledger keeps `report-policy: failed`
  // visible (RSI-Software/t3code-hyprws#869).
  process.stderr.write(
    `${failures.length} unresolved blocking seam(s):\n${failures.slice(0, 10).join("\n")}\n`,
  );
  return 0;
};
/**
 * A bridged legacy→sequential verification must prove the repair landed before the frozen after
 * head; `comparable()` alone cannot check ancestry, and non-bridged verifications keep today's
 * behaviour (no ancestry check). Guard binding and exit codes are already validated by
 * `requireSeamRecords` before this runs.
 */
const proveBridgedAncestry = (
  root: string,
  records: ReturnType<typeof requireSeamRecords>,
): void => {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    if (record.kind !== "verification" || record.guardProof.exitCode !== 0) continue;
    const repair = byId.get(record.repair);
    const after = byId.get(record.after);
    if (repair?.kind !== "repair" || after?.kind !== "observation") continue;
    const before = byId.get(repair.before.observation);
    if (before?.kind !== "observation") continue;
    if (!bridgedLegacy(before, after) || after.evidence === null) continue;
    const result = runCommand(
      "git",
      ["merge-base", "--is-ancestor", repair.changeSha, after.evidence.sourceSha],
      { cwd: root },
    );
    if (result.status !== 0)
      throw new Error(
        `bridged verification refuses: repair ${repair.changeSha} is not an ancestor of the frozen after head ${after.evidence.sourceSha}`,
      );
  }
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
  const lease = acquireBotRefLease(root, CHURN_REF, push);
  if (lease === null) throw new Error("seed the churn ledger before recording seam evidence");
  const state = readChurnState(root);
  const seamRecords = requireSeamRecords([...state.seamRecords, ...input.records]);
  proveBridgedAncestry(root, seamRecords);
  const added = seamRecords.length - state.seamRecords.length;
  const commit =
    added === 0
      ? lease.base
      : writeChurnState(root, { ...state, seamRecords }, "churn: record seam evidence");
  if (push) publishBotRefLease(root, lease, commit);
  process.stdout.write(
    `recorded ${added} seam record(s) on ${CHURN_REF} at ${commit}${push ? " (pushed with expected-old lease)" : ""}; guard results are maintainer attestations\n`,
  );
  return 0;
};

/**
 * Builds the reviewed bundle `record --input` imports, from local sequential census artifacts and
 * a plan that references their rows. This is the only producer of evidence-bearing seam records;
 * before it existed nothing but the test file called `freezeObservation`, so every recorded
 * observation carried `evidence: null` and no seam could ever be proven repaired.
 *
 * It writes a file rather than the ledger: the bundle is reviewed, then imported through the one
 * import path, and no guard command runs here.
 */
const composeSeams = (args: ReadonlyArray<string>, root: string): number => {
  const options = parseOptions(args);
  for (const option of options.keys())
    if (option !== "--plan" && option !== "--out")
      throw new UsageError(`unknown option: ${option}`);
  const planPath = options.get("--plan");
  const outPath = options.get("--out");
  if (planPath === undefined || outPath === undefined)
    throw new UsageError("usage: fork-churn compose --plan <plan.json> --out <bundle.json>");
  const plan: unknown = JSON.parse(NodeFS.readFileSync(NodePath.resolve(root, planPath), "utf8"));
  const existing = resolveBotRef(root, CHURN_REF) === null ? [] : readChurnState(root).seamRecords;
  const bundle = composeSeamBundle(
    plan,
    (reference) => JSON.parse(NodeFS.readFileSync(NodePath.resolve(root, reference), "utf8")),
    existing,
  );
  const resolved = NodePath.resolve(root, outPath);
  NodeFS.writeFileSync(resolved, `${JSON.stringify(bundle, null, 2)}\n`);
  process.stdout.write(
    `composed ${bundle.records.length} seam record(s) into ${NodePath.relative(root, resolved)}; review it, then import with fork-churn record --input\n`,
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
  const outcomes = canonicalizeOutcomeReceiptsForRoot(root, source.outcomes);
  const commit = writeChurnState(
    root,
    { ...source, walks: entries, outcomes },
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
  const lease = acquireBotRefLease(root, CHURN_REF, push);
  if (lease === null)
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
  if (push) publishBotRefLease(root, lease, commit);
  process.stdout.write(
    `migrated ${missing.length} census commit(s) on ${CHURN_REF} at ${commit}${push ? " (pushed with expected-old lease)" : ""}\n`,
  );
  return 0;
};

const USAGE =
  "usage: fork-churn append <options> | compose --plan <json> --out <json> | record --input <json> [--push] | outcome --input <json> [--push] | migrate-subjects [--push] | report [--receipt <json>] [--census <auto-result.json>] | seed [--from <json>] [--push]";

const HELP = `Record fork rebase evidence and target outcomes through distribution.
${USAGE}

outcome imports immutable {version:1, receipts:[...]} evidence. Alternatively,
--auto-report PATH collects planner/result evidence with optional --report-receipt PATH;
--sync-report PATH collects a retained sync report and its local outcome sidecar.
--release collects FORK_RELEASE_NEEDS job results and verifies GitHub tag/assets.
FORK_OUTCOME_EXPORT retains an importable bundle before ledger publication.
Eligibility is declared independently of bot mode. Missing stages never imply success.
Output is JSON with retained outcomes and the resume action.

compose --plan PATH --out PATH builds that bundle from local sequential census
artifacts, freezing each census as an evidence-bearing observation and resolving
mapping/repair/verification references by census row. It writes a file for review
and never touches the ledger; guard results stay maintainer attestations.

record --input PATH imports a reviewed {version:1, records:[...]} bundle.
It validates content digests and frozen evidence; it does not execute guard commands.
--push publishes the bot-owned ref with an expected-old lease.
report assesses the walk's lessons without publishing: receipt publication is always
not-attempted, the verdict (lesson unavailable, blocking seams, or clear) goes to the
receipt the outcome step retains, and unresolved seams are named on stderr.
--census PATH assesses the live census from the rebase job's auto-result artifact
(a typed AutoRebaseResult on disk); without it the assessment reads landed history
only and says so on stderr. A live census the artifact cannot provide - count-only
with no conflicts, or a truncated-to-zero partial - is a non-passing
census-unavailable verdict, never a pass inferred from history; a malformed
artifact or census provenance is an error.
seed initializes the ledger; append records a completed walk.
Exit: 0 complete, 1 runtime/evidence failure, 2 invalid arguments.
Output: compact receipts on stdout; failures on stderr. -h / --help writes nothing.
`;

export const run = (argv: ReadonlyArray<string>, root = process.cwd()): number => {
  try {
    if (
      (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) ||
      (argv.length === 2 &&
        ["record", "compose", "outcome"].includes(argv[0]!) &&
        ["--help", "-h"].includes(argv[1]!))
    ) {
      process.stdout.write(HELP);
      return 0;
    }
    const [verb, ...args] = argv;
    if (verb === "record") return recordSeams(args, root);
    if (verb === "compose") return composeSeams(args, root);
    if (verb === "append") {
      appendChurnRow(args, root);
      return 0;
    }
    if (verb === "outcome") return runOutcome(args, root);
    if (verb === "report") return report(args, root);
    if (verb === "seed") return seed(args, root);
    if (verb === "migrate-subjects") return migrateSubjects(args, root);
    throw new UsageError(USAGE);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
