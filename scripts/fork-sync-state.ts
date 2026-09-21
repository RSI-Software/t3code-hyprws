// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Sync records are standalone operator state.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import { UsageError } from "./lib/fork-cli.ts";
import {
  requireCommandSuccess,
  type CwdCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";
import { FORK_REPOSITORY, isNightlyUpstreamTag } from "./lib/fork-policy.ts";
import { decisionLine, type WalkDecision } from "./lib/fork-decisions.ts";
import type { StableCandidate } from "./lib/fork-rebase-issues.ts";
import {
  rewriteArchiveRef,
  validateRewriteArchiveBinding,
  type RewriteArchiveBinding,
} from "./lib/fork-rewrite-archive.ts";
import {
  renderFoldHeader,
  renderFoldSection,
  requireFoldSegment,
  type ActiveFold,
  type FoldPublication,
  type FoldSegment,
} from "./lib/fork-sync-fold-types.ts";

export {
  foldMessagesDigest,
  renderFoldHeader,
  renderFoldSection,
  requireFoldSegment,
  type ActiveFold,
  type FoldPublication,
  type FoldSegment,
} from "./lib/fork-sync-fold-types.ts";

export const REPOSITORY = FORK_REPOSITORY;
export const BLOCK_LABEL = "rebase-blocked";
const FULL_SHA = /^[0-9a-f]{40,64}$/;
export const COMMENT_CONFIG = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.commentChar",
  GIT_CONFIG_VALUE_0: "auto",
} as const;

/**
 * The identity every commit the walk writes itself carries, mirroring the one the sync workflow
 * configures before it moves the trunk. Forcing it through the environment means a repair the
 * human lane produces is attributed to the walk too, rather than to whoever ran the command.
 */
export const FORK_BOT_IDENTITY = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
} as const;

export const BOT_COMMIT_CONFIG = {
  GIT_AUTHOR_NAME: FORK_BOT_IDENTITY.name,
  GIT_AUTHOR_EMAIL: FORK_BOT_IDENTITY.email,
  GIT_COMMITTER_NAME: FORK_BOT_IDENTITY.name,
  GIT_COMMITTER_EMAIL: FORK_BOT_IDENTITY.email,
} as const;

export type SyncStage =
  | "listed"
  | "oriented"
  | "conflicts"
  | "replayed"
  | "checked"
  | "folding"
  | "applied";
export type SyncKind = "unblock" | "rewrite";

export interface RewriteProof {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
  readonly detail?: string;
}

export interface RewriteBinding {
  readonly build?: {
    readonly manifestPath: string;
    readonly receiptPath: string;
    readonly manifestSha256: string;
    readonly result: string;
  };
  readonly outcomeTarget?: import("./lib/fork-sync-outcomes.ts").OutcomeTarget;
  /** Immutable old-trunk retention bound into the reviewed rewrite record. */
  readonly archive?: RewriteArchiveBinding;
  readonly from: string;
  readonly fromSha: string;
  readonly fromShort: string;
  readonly originSha: string;
  readonly originShort: string;
  readonly base: string;
  /** Upstream release tag at `base`; the tag-pinned apply gate needs it. */
  readonly baseTag?: string;
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

/** Who signed a row. `TODO` is the absence of provenance, not a third decider. */
export type DecidedBy = "human" | "agent" | "TODO" | `inherited (${string})`;

/** Runtime identity recorded for each side of the nightly review control.
 * No model family is privileged; the gate records identity as evidence and
 * refuses only a verdict from the proposing session. */
export interface AgentProvenance {
  readonly iface: string;
  readonly provider: string;
  readonly model: string;
  readonly session: string;
}

export const NIGHTLY_REVIEW_EVIDENCE = [
  "generated target",
  "blocking marker",
  "every non-mechanical verdict",
  "rehearsal evidence",
  "pushed-lane CI",
  "silent seams",
  "live expected-old lease",
] as const;

export const NIGHTLY_WITHHOLD_RULES = [
  "undefined fork intent",
  "non-equivalent retire",
  "user-visible behaviour change",
  "fork domain or tier topology change",
  "bypass of a gate",
  "evidence cannot be verified",
] as const;

export interface NightlyReviewEvidence {
  readonly target: string;
  readonly targetSha: string;
  readonly blockingSha: string;
  readonly expectedOld: string;
  readonly installedHead: string;
  readonly ciHead: string;
  readonly laneBranch: string;
  readonly recordDigest: string;
  readonly inspected: typeof NIGHTLY_REVIEW_EVIDENCE;
}

export interface NightlyReview {
  readonly status: "signed-off" | "withheld";
  readonly proposer: AgentProvenance;
  readonly reviewer: AgentProvenance;
  readonly reviewedAt: string;
  readonly evidence?: NightlyReviewEvidence;
  readonly reason?: string;
}

const PROVENANCE_PART = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

const requireNonemptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${field}`);
  return value;
};

/** Parse the markdown-safe identity shape emitted by the agent runtime. */
export const requireAgentProvenance = (value: unknown, field: string): AgentProvenance => {
  if (typeof value !== "object" || value === null) throw new Error(`invalid ${field}`);
  const identity = value as Record<string, unknown>;
  const iface = requireNonemptyString(identity.iface, `${field} interface`);
  const provider = requireNonemptyString(identity.provider, `${field} provider`);
  const model = requireNonemptyString(identity.model, `${field} model`);
  const session = requireNonemptyString(identity.session, `${field} session`);
  if (![iface, provider, model, session].every((part) => PROVENANCE_PART.test(part)))
    throw new Error(`invalid ${field}: identity contains unsupported characters`);
  return { iface, provider, model, session };
};

const requireFullSha = (value: unknown, field: string): string => {
  const sha = requireNonemptyString(value, field);
  if (!FULL_SHA.test(sha)) throw new Error(`invalid ${field}`);
  return sha;
};

const requireReviewedAt = (value: unknown, field: string): string => {
  const timestamp = requireNonemptyString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp))
    throw new Error(`invalid ${field}`);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp)
    throw new Error(`invalid ${field}`);
  return timestamp;
};

/** Validate the durable nightly-review union used by reports, records, and the churn ledger. */
export const requireNightlyReview = (value: unknown, field = "nightly review"): NightlyReview => {
  if (typeof value !== "object" || value === null) throw new Error(`invalid ${field}`);
  const review = value as Record<string, unknown>;
  if (review.status !== "signed-off" && review.status !== "withheld")
    throw new Error(`invalid ${field} status`);
  const proposer = requireAgentProvenance(review.proposer, `${field} proposer`);
  const reviewer = requireAgentProvenance(review.reviewer, `${field} reviewer`);
  const reviewedAt = requireReviewedAt(review.reviewedAt, `${field} reviewedAt`);
  if (review.status === "withheld") {
    if (review.evidence !== undefined)
      throw new Error(`invalid ${field}: withheld review has evidence`);
    return {
      status: "withheld",
      proposer,
      reviewer,
      reviewedAt,
      reason: requireNonemptyString(review.reason, `${field} withheld reason`),
    };
  }
  if (review.reason !== undefined)
    throw new Error(`invalid ${field}: signed-off review has a withheld reason`);
  if (typeof review.evidence !== "object" || review.evidence === null)
    throw new Error(`invalid ${field} evidence`);
  const evidence = review.evidence as Record<string, unknown>;
  const target = requireNonemptyString(evidence.target, `${field} evidence target`);
  if (!isNightlyUpstreamTag(target)) throw new Error(`invalid ${field} evidence target`);
  if (
    !Array.isArray(evidence.inspected) ||
    JSON.stringify(evidence.inspected) !== JSON.stringify(NIGHTLY_REVIEW_EVIDENCE)
  )
    throw new Error(`invalid ${field} evidence set`);
  const recordDigest = requireNonemptyString(
    evidence.recordDigest,
    `${field} evidence recordDigest`,
  );
  if (!SHA256.test(recordDigest)) throw new Error(`invalid ${field} evidence recordDigest`);
  return {
    status: "signed-off",
    proposer,
    reviewer,
    reviewedAt,
    evidence: {
      target,
      targetSha: requireFullSha(evidence.targetSha, `${field} evidence targetSha`),
      blockingSha: requireFullSha(evidence.blockingSha, `${field} evidence blockingSha`),
      expectedOld: requireFullSha(evidence.expectedOld, `${field} evidence expectedOld`),
      installedHead: requireFullSha(evidence.installedHead, `${field} evidence installedHead`),
      ciHead: requireFullSha(evidence.ciHead, `${field} evidence ciHead`),
      laneBranch: requireNonemptyString(evidence.laneBranch, `${field} evidence laneBranch`),
      recordDigest,
      inspected: NIGHTLY_REVIEW_EVIDENCE,
    },
  };
};

export interface ConflictRow {
  readonly commit: string;
  readonly subject: string;
  readonly domain: string;
  readonly path: string;
  readonly class: ConflictClass | "TODO";
  readonly resolution: string;
  readonly agentSafe: string;
  readonly decidedBy: DecidedBy;
  /** Content key of the conflicted seam, set while the index still holds the conflict stages. */
  readonly seamKey?: string;
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

export type DecisionAction =
  | "keep (mechanical seam)"
  | "keep (target tree absent)"
  | "keep (target tree present)";

export interface OrientationDecisionRow {
  readonly subject: string;
  readonly domain: string;
  readonly verdict: OrientationVerdict;
  readonly decidedBy: DecidedBy;
  readonly action?: DecisionAction;
}

/** A decision cell an operator filled in the record by hand, carried across regeneration. */
export interface RecordDecision {
  readonly subject: string;
  readonly action: string;
  readonly decidedBy: Exclude<DecidedBy, "TODO">;
}

/** A human verdict that survived a previous walk via `refs/fork/churn`, carried into the next render. */
export interface InheritedVerdict {
  readonly subject: string;
  readonly domain: string;
  readonly action: string;
  readonly decidedBy: Exclude<DecidedBy, "TODO">;
  readonly sourceTag: string;
  readonly sourceSha?: string;
}

/**
 * What the target tag's tree says about one retire candidate. `identifiers` are the names the fork
 * commit introduces; an empty `matches` means none of them exist upstream, so the candidate is a
 * proximity artefact rather than a real retirement.
 */
export interface RetireEvidence {
  readonly subject: string;
  readonly commit: string;
  readonly identifiers: ReadonlyArray<string>;
  readonly matches: ReadonlyArray<{ readonly identifier: string; readonly location: string }>;
}

export interface SilentSeam {
  readonly path: string;
  readonly summary: string;
  readonly touchesBehaviour: boolean;
}

/** Rechecking an observation retains its first evidence object and arrival order. */
export const uniqueSilentSeams = (
  observations: ReadonlyArray<SilentSeam>,
): ReadonlyArray<SilentSeam> => {
  const seen = new Set<string>();
  return observations.filter((observation) => {
    const identity = JSON.stringify([
      observation.path,
      observation.summary,
      observation.touchesBehaviour,
    ]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

export interface SyncReport {
  /** Bumped to 2 when the report became the walk's only authority and the record went inert. */
  readonly schemaVersion: 2;
  readonly stage: SyncStage;
  readonly kind?: SyncKind;
  readonly repositoryRoot: string;
  readonly reportPath: string;
  readonly recordPath: string;
  readonly issue: { readonly number: number; readonly blockingSha: string; readonly title: string };
  readonly candidates: ReadonlyArray<{ readonly tag: string; readonly sha: string }>;
  readonly bot?: BotSnapshot;
  /**
   * The walk is being carried by the auto-rebase workflow itself, so the bot is
   * on by construction and the lane is minted with plain Git
   * (RSI-Software/t3code-hyprws#444).
   */
  readonly botCarried?: boolean;
  readonly target?: { readonly tag: string; readonly sha: string };
  readonly source?: {
    /** Immutable original orientation (T): the trunk tip this walk first oriented at. */
    readonly sha: string;
    /** Immutable merge base of T and the target tag; never advances during folds. */
    readonly sharedBase: string;
    /**
     * Incorporated trunk frontier (B): the latest trunk tip already contained in the candidate.
     * With no folds this equals `sha`; a fold advances only after the new segment is proved
     * (RSI-Software/t3code-hyprws#920).
     */
    readonly expectedOld: string;
  };
  /** Ordered fold segments; empty or absent for a walk that has never folded. */
  readonly folds?: ReadonlyArray<FoldSegment>;
  /** The fold operation a stopped or resumed walk is mid-way through, set before Git mutation. */
  readonly activeFold?: ActiveFold;
  /** The verified candidate head the first fold replayed onto (H₀, after its own verification). */
  readonly baseCheckedHead?: string;
  /** A pending or resolved leased push of a folded candidate, for interrupted-push recovery. */
  readonly publication?: FoldPublication;
  /**
   * The stable-tag snapshots this apply created before the trunk push, bound so the
   * applied-resume announces exactly these — re-creating the list would drop branches that
   * already exist on `origin` and silently skip the announcement (RSI-Software/t3code-hyprws#922).
   */
  readonly stableCandidates?: ReadonlyArray<StableCandidate>;
  readonly rewrite?: RewriteBinding;
  readonly lane?: { readonly branch: string; readonly worktree: string };
  readonly originalMessages?: string;
  readonly originalCount?: number;
  readonly conflicts: ReadonlyArray<ConflictRow>;
  /**
   * One record per decision this walk made so far (RSI-Software/t3code-hyprws#662): conflicts the
   * executor or a replay resolved, rows the walk stopped on, retire verdicts. Rendered into the
   * record and carried onto the ledger row.
   */
  readonly decisions?: ReadonlyArray<WalkDecision>;
  readonly orientation?: string;
  readonly orientationDecisions?: ReadonlyArray<OrientationDecisionRow>;
  readonly retireEvidence?: ReadonlyArray<RetireEvidence>;
  readonly recordDecisions?: ReadonlyArray<RecordDecision>;
  /**
   * What a human or agent claimed about product grounding for a decision subject, or the claim
   * still owed. Gate 4 reads this, never the rendered record (RSI-Software/t3code-hyprws#1144).
   */
  readonly grounding?: ReadonlyArray<{
    readonly subject: string;
    readonly claim?: string;
    readonly pending?: string;
  }>;
  readonly inheritedVerdicts?: ReadonlyArray<InheritedVerdict>;
  readonly touchedPaths?: ReadonlyArray<string>;
  readonly silentSeams?: ReadonlyArray<SilentSeam>;
  readonly behaviourSeamStopPresented?: boolean;
  /** Walking agent that proposed the nightly record; never inferred from the reviewer process. */
  readonly proposedBy?: AgentProvenance;
  readonly nightlyReview?: NightlyReview;
  readonly verification: ReadonlyArray<{ readonly command: string; readonly result: string }>;
  readonly rebasedHead?: string;
  readonly stackSize?: number;
  readonly installedHead?: string;
  readonly ciHead?: string;
  readonly recordCommentUrl?: string;
  /** The applied-walk announcement comment on the issue; set once, so a resume never reposts. */
  readonly announcementUrl?: string;
  /** Trunk apply is durable even when its independently resumable cache push fails. */
  readonly rererePublication?: {
    readonly state: "pending" | "published";
    readonly snapshot?: string | null;
    readonly commit?: string;
    readonly error?: string;
  };
  /** The leased apply's push to `hyprws` starts the next workflow run; the report records that
   * trigger rather than a second dispatched run. */
  readonly reconciliation?: { readonly trigger: "push"; readonly sha: string };
  readonly walk?: WalkRecord;
}

/**
 * A walk stops for exactly two reasons: the lane cannot test, or the outcome executor cannot
 * produce a result for a conflict row. Every other halt is a defect.
 */
export type WalkStopReason = "environment" | "conflict";

/** The per-domain half of a walk's size record (RSI-Software/t3code-hyprws#672): the same
 * numbers `fork:delta --inventory` measures, captured per cycle. */
export interface WalkSizeDomain {
  readonly domain: string;
  readonly commits: number;
  readonly added: number;
  readonly deleted: number;
  readonly shared: number;
}

/** What the walk's replayed stack measured: total fork commits, the per-domain table, and the
 * shared-file count. Recorded at replay completion, before any repair commit is appended. */
export interface WalkSize {
  readonly commits: number;
  readonly domains: ReadonlyArray<WalkSizeDomain>;
  readonly sharedFiles: number;
}

/** What one unattended walk did, in the terms the notification issue and the ledger need. */
export interface WalkRecord {
  readonly startedAt?: string;
  readonly elapsedMs?: number;
  /** The base the stack sat on before the walk, and the tag it moved to. */
  readonly baseMove?: { readonly from: string; readonly to: string };
  readonly repairs?: ReadonlyArray<{ readonly command: string; readonly result: string }>;
  /**
   * The commits the walk appended for what its repairs rewrote. Every one is the walk's own; a
   * replayed fork commit is never amended, so this list is also the difference between the fork
   * series and the head the apply publishes.
   */
  readonly repairCommits?: ReadonlyArray<{ readonly sha: string; readonly subject: string }>;
  /**
   * The purely-additive check the walk runs on its own replayed tree, between the replay and the
   * repair battery (RSI-Software/t3code-hyprws#661). `findings` lists what the check found: the
   * first-pass findings when the retry made the tree additive again, the remaining ones on a
   * stop. `commit` is the `additive` repair commit when the machine rewrote the tree.
   */
  readonly additive?: {
    readonly pass: boolean;
    readonly attempts: 1 | 2;
    readonly findings: ReadonlyArray<import("./lib/fork-additive.ts").AdditiveFinding>;
    readonly fixed: ReadonlyArray<import("./lib/fork-additive.ts").AdditiveFinding>;
    readonly commit?: string;
  };
  readonly decisions?: ReadonlyArray<WalkDecision>;
  /** The stack the walk replayed, measured at replay completion (RSI-Software/t3code-hyprws#672). */
  readonly size?: WalkSize;
  readonly stop?: {
    readonly reason: WalkStopReason;
    readonly detail: string;
    /**
     * Lane paths the stop leaves dirty on purpose: a resumed walk may carry dirt on exactly
     * these paths, the way it may on the conflict rows' paths
     * (RSI-Software/t3code-hyprws#1071).
     */
    readonly paths?: ReadonlyArray<string>;
  };
  /**
   * Where the walk's row and outcome record ended up. The apply invocation publishes both, so
   * an unpublished ledger is a stop the walk reports, never a later step's silent omission
   * (RSI-Software/t3code-hyprws#664).
   */
  readonly ledger?: {
    readonly state: "published" | "unpublished";
    readonly tag: string;
    readonly reason?: string;
  };
}

/**
 * The retire half of a walk's decision record, derived from the orientation table both the record
 * and the walk summary render. Conflict and stop decisions are recorded at the moment they happen;
 * retire verdicts only exist as table rows, so they are derived at render time. Inherited verdicts
 * are skipped — the previous walk that answered them already owns that record.
 */
export const walkDecisionsOf = (report: SyncReport): ReadonlyArray<WalkDecision> => {
  const stamp = report.walk?.startedAt ?? new Date().toISOString();
  const tag = report.target?.tag ?? "unknown";
  const derived = (report.orientationDecisions ?? [])
    .filter((row) => row.verdict !== "candidate")
    .map((row) => ({
      kind: "retire" as const,
      subject: row.subject,
      outcome: row.verdict === "keep" ? "kept" : row.verdict === "retire" ? "retired" : "partial",
      decidedBy: row.decidedBy === "human" ? ("human" as const) : ("machine" as const),
      tag,
      recordedAt: stamp,
    }));
  return [...(report.decisions ?? []), ...derived];
};

export const SYNC_HELP = `Usage: vp run fork:sync <verb> [options]

Unblock verbs:
  unblock-auto [--target <tag@sha>] [--report <external-json>] [--bot-carried] [--silent-seam <path>=<summary>:behaviour|type ...]
  unblock-list [--output <external-json>] [--all]
  unblock-orient --report <json> --target <release-tag>
  unblock-rehearse --report <json>
  unblock-check --report <json> [--silent-seam <path>=<summary>:behaviour|type ...] [--seam-owner <path>=<full owner sha> ...]
  unblock-fold --report <json>                            folds linear trunk movement into the candidate
  unblock-review --report <json> (--sign-off | --withhold <reason>)   (series rewrite only)
  unblock-refresh --report <json>
  unblock-apply --report <json> --record <markdown>
  record-decisions --report <json> --tag <release-tag>       (stopped lane, human resolutions in the index)
  rewrite-rehearse --from <branch-or-sha> [--manifest <reviewed-json>] [--issue N] [--dry-run]
  rewrite-build --manifest <reviewed-json> [--json]
  fold-reshape --reshape <sha>[,<sha>…] [--base <tag>] [--out <path>] [--attribute <path>=<sha>…] [--leave <path>…] [--json]

Rewrite publication requires rewrite-rehearse --manifest <reviewed-json>.
Build writes unreferenced objects and <manifest>.receipt.json, never refs or an index.
Build exits: 0 verified; 1 runtime; 2 usage/schema; 3 stale/unsupported proof.

fold-reshape's --reshape list order is the fold order, not commit history order: a reshape folds
before every name after it in the list. A later reshape's hunk may chain to an earlier name in the
list (blame lands on it instead of a real fork commit, a shared seam like a registry file's last
row) and resolves through that reshape's own settled origin; a hunk chaining to a later name still
refuses, by name.

Stable verbs:
  stable-list [--output <external-json>]
  stable-prepare --report <json> --issue <human-selected-issue>
  stable-publish --report <json> --go <exact-candidate>

unblock-auto runs the whole walk in one invocation. It stops for exactly two reasons: the lane
cannot test, or the outcome executor cannot resolve a conflict. Both exit 2 with the reason on the
report and on stdout. An applied unblock-apply report resumes only pending rerere publication.
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
  stream?: boolean,
  timeout?: number,
): string => {
  const result = runner.run(command, args, cwd, input, env, stream, timeout);
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
  for (let index = 1; index < argv.length;) {
    const flag = argv[index];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new UsageError(`invalid arguments after ${verb}`);
    }
    if (values.has(flag) && flag !== "--silent-seam" && flag !== "--seam-owner")
      throw new UsageError(`duplicate option: ${flag}`);
    if (
      flag === "--dry-run" ||
      flag === "--all" ||
      flag === "--bot-carried" ||
      flag === "--sign-off"
    ) {
      values.set(flag, "true");
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`invalid arguments after ${verb}`);
    }
    if (flag === "--silent-seam" || flag === "--seam-owner") {
      if (values.has(flag)) values.set(flag, `${values.get(flag)}\n${value}`);
      else values.set(flag, value);
    } else {
      values.set(flag, value);
    }
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

export { externalPath } from "./lib/fork-external-path.ts";

export const validateReport = (value: unknown): SyncReport => {
  if (typeof value !== "object" || value === null) throw new Error("report is not an object");
  const report = value as Partial<SyncReport>;
  if ((report.schemaVersion as number) === 1)
    throw new Error(
      "report is schema 1, written before the typed report became the only authority; " +
        "finish or abandon that walk on the older build and start a fresh walk here",
    );
  if (report.schemaVersion !== 2 || typeof report.stage !== "string")
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
  const publication = report.rererePublication;
  if (
    publication !== undefined &&
    ((publication.state !== "pending" && publication.state !== "published") ||
      (publication.snapshot != null && !FULL_SHA.test(publication.snapshot)) ||
      (publication.commit !== undefined && !FULL_SHA.test(publication.commit)))
  )
    throw new Error("report rerere publication is invalid");
  const reconciliation = report.reconciliation;
  if (
    reconciliation !== undefined &&
    (reconciliation.trigger !== "push" || !FULL_SHA.test(reconciliation.sha))
  )
    throw new Error("report reconciliation is invalid");
  const rewrite = report.rewrite;
  const archive = rewrite?.archive;
  if (archive !== undefined) {
    if (report.kind !== "rewrite" || report.source === undefined || rewrite === undefined)
      throw new Error("rewrite archive has no rewrite source binding");
    validateRewriteArchiveBinding(archive, report.source.expectedOld);
    if (archive.ref !== rewriteArchiveRef(rewrite.originSha))
      throw new Error("rewrite archive does not match rewrite origin");
  }
  const folds = report.folds ?? [];
  for (const fold of folds) requireFoldSegment(fold);
  const activeFold = report.activeFold;
  if (
    activeFold !== undefined &&
    ((activeFold.operation !== "replay" && activeFold.operation !== "check") ||
      !Number.isSafeInteger(activeFold.index) ||
      activeFold.index < 0 ||
      activeFold.index >= folds.length)
  )
    throw new Error("report active fold is invalid");
  // `folding` is only ever a transient persisted stage; without the active fold that names the
  // in-progress operation, a resumed walk could not continue it (RSI-Software/t3code-hyprws#922).
  if (report.stage === "folding" && activeFold === undefined)
    throw new Error("report stage folding without an active fold is invalid");
  const foldPublication = report.publication;
  if (
    foldPublication !== undefined &&
    (!FULL_SHA.test(foldPublication.expectedOld) ||
      !FULL_SHA.test(foldPublication.head) ||
      !SHA256.test(foldPublication.recordDigest))
  )
    throw new Error("report fold publication is invalid");
  const stableCandidates = report.stableCandidates;
  if (
    stableCandidates !== undefined &&
    (!Array.isArray(stableCandidates) ||
      stableCandidates.some(
        (candidate) =>
          typeof candidate.tag !== "string" ||
          typeof candidate.branch !== "string" ||
          !FULL_SHA.test(candidate.sha),
      ))
  )
    throw new Error("report stable candidates are invalid");
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
  const archive = rw.archive;
  const lane = report.lane;
  const rewriteLease = `Lease: report leased at \`${rw.originSha}\` (origin/hyprws) — any movement of \`origin/hyprws\` voids this rehearsal; restart at \`vp run fork:sync unblock-list\``;
  const rewriteGate =
    report.stage === "checked"
      ? "Stop. Lease boundary: any movement of `origin/hyprws` past the lease above voids this green rehearsal."
      : undefined;
  return [
    "## Header",
    "",
    `- \`from\`: \`${rw.from}@${rw.fromSha}\``,
    `- Target: \`${rw.baseTag ?? "absent"}@${rw.base}\``,
    `- \`expected_old\`: \`${rw.originSha}\``,
    `- ${rewriteLease}`,
    ...(rewriteGate === undefined ? [] : [`- ${rewriteGate}`]),
    `- Rehearsal branch: \`${lane?.branch ?? "absent"}\``,
    `- Rebased head: \`${report.rebasedHead ?? report.rewrite?.fromSha ?? "absent"}\``,
    `- Stack size: \`${report.stackSize ?? 0}\` fork commits`,
    "",
    "## Pre-rewrite archive",
    "",
    ...(archive === undefined
      ? ["Missing. Restart with `rewrite-rehearse` before publication."]
      : [
          `- Ref: \`${archive.ref}\``,
          `- SHA: \`${archive.sha}\``,
          "- Verification: `unblock-apply` creates this ref with a missing-ref lease (or accepts the same SHA on retry) and reads the exact SHA back before publishing this record.",
          "- Failure retention: if the later trunk lease fails, this archive remains as failed-attempt evidence.",
        ]),
    "",
    ...renderRewriteProofs(rw),
    ...(rw.build === undefined
      ? []
      : [
          `- Build manifest SHA-256: \`${rw.build.manifestSha256}\``,
          `- Constructed head: \`${rw.build.result}\``,
          `- Retained outcome SHA-256: \`${NodeCrypto.createHash("sha256")
            .update(JSON.stringify(rw.outcomeTarget ?? null))
            .digest("hex")}\``,
        ]),
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
    ...renderNightlyReview(report),
    "## Grounding",
    "",
    "None.",
    "",
    report.stage === "checked" ? "land" : "do-not-land",
    "",
  ].join("\n");
};

/**
 * The class summary carries the target-tree verdict so a reader sees why a candidate was kept
 * without rerunning the grep. No evidence means the tree was never queried for that subject.
 */
export const retireEvidenceNote = (evidence: RetireEvidence | undefined): string => {
  if (evidence === undefined || evidence.identifiers.length === 0) return "";
  const match = evidence.matches[0];
  return match === undefined
    ? "; target-tree: absent"
    : `; target-tree: ${escapeCell(match.identifier)} at ${escapeCell(match.location)}`;
};

const isNightlyTarget = (report: SyncReport): boolean =>
  report.target !== undefined && isNightlyUpstreamTag(report.target.tag);

export const renderNightlyReview = (report: SyncReport): ReadonlyArray<string> => {
  if (!isNightlyTarget(report)) return [];
  const review = report.nightlyReview;
  const proposer = review?.proposer ?? report.proposedBy;
  const identity = (value: AgentProvenance | undefined): string =>
    value === undefined
      ? "TODO"
      : `agent \`${escapeCell(value.iface)}/${escapeCell(value.provider)}/${escapeCell(value.model)}\`, session \`${escapeCell(value.session)}\``;
  return [
    "## Nightly review",
    "",
    `- Proposer: ${identity(proposer)}`,
    `- Reviewer: ${identity(review?.reviewer)}`,
    `- Verdict: ${review?.status ?? "TODO"}`,
    ...(review === undefined ? [] : [`- Reviewed at: ${escapeCell(review.reviewedAt)}`]),
    ...(review?.reason === undefined ? [] : [`- Withheld reason: ${escapeCell(review.reason)}`]),
    ...(review?.evidence === undefined
      ? []
      : [
          `- Evidence binding: target \`${review.evidence.target}@${review.evidence.targetSha}\`; blocking \`${review.evidence.blockingSha}\`; expected-old \`${review.evidence.expectedOld}\`; installed \`${review.evidence.installedHead}\`; CI \`${review.evidence.ciHead}\`; lane \`${review.evidence.laneBranch}\`; record \`${review.evidence.recordDigest}\``,
        ]),
    "- Review evidence set:",
    ...NIGHTLY_REVIEW_EVIDENCE.map((item) => `  - ${item}`),
    "- Withhold on:",
    ...NIGHTLY_WITHHOLD_RULES.map((item) => `  - ${item}`),
    "",
  ];
};

/** One row of the record's `## Decisions` table, before any filled cell is merged into it. */
export interface DecisionTableRow {
  readonly subject: string;
  readonly domain: string;
  readonly classSummary: string;
  readonly action: string;
  readonly decidedBy: DecidedBy;
}

/**
 * Every subject the record's `## Decisions` table can carry, derived from the replay alone: one row
 * per orientation verdict, plus every conflict row a human has to answer. A filled cell only
 * survives regeneration by attaching to a row here, so this is also the test for whether a subject
 * has left the replay — `unblock-refresh` reads it to name the cells it drops instead of letting
 * them disappear without a word (RSI-Software/t3code-hyprws#695).
 */
export const baseDecisionRows = (report: SyncReport): ReadonlyMap<string, DecisionTableRow> => {
  const decisions = new Map<string, DecisionTableRow>();
  const evidence = new Map((report.retireEvidence ?? []).map((row) => [row.subject, row]));
  for (const row of report.orientationDecisions ?? []) {
    decisions.set(row.subject, {
      subject: row.subject,
      domain: row.domain,
      classSummary:
        row.verdict === "candidate"
          ? `orientation: candidate; retire-candidate${retireEvidenceNote(evidence.get(row.subject))}`
          : `orientation: ${row.verdict}`,
      action: row.action ?? (row.verdict === "candidate" ? "TODO" : row.verdict),
      decidedBy: row.decidedBy,
    });
  }
  for (const row of report.conflicts) {
    if (row.class !== "retire-candidate" && row.class !== "human") continue;
    // A conflict stop the human resolved and published is a keep decision by that human
    // (RSI-Software/t3code-hyprws#1069): the row carries it as keep decided by human with the
    // stop as its evidence, so Gate 4 asks only for a decision no stop has already collected.
    // A still-open stop row (agentSafe TODO) keeps TODO and stays the human's question. Rows
    // the executor already decided (mechanical, seam-moved, retire-candidate) never count as
    // hand resolutions: only the published `human` stop class carries the keep.
    const resolvedByHand =
      row.class === "human" &&
      row.decidedBy === "human" &&
      row.resolution === "resolved by hand in the lane" &&
      row.agentSafe !== "TODO" &&
      row.agentSafe !== "pending regeneration";
    const existing = decisions.get(row.subject);
    decisions.set(row.subject, {
      subject: row.subject,
      domain: row.domain,
      classSummary:
        existing === undefined
          ? row.class
          : resolvedByHand
            ? existing.classSummary
            : `${existing.classSummary}; ${row.class}`,
      action: resolvedByHand ? "keep" : (existing?.action ?? "TODO"),
      decidedBy: resolvedByHand ? ("human" as const) : (existing?.decidedBy ?? row.decidedBy),
    });
  }
  return decisions;
};

/**
 * The decision table as the record renders it and the ledger stores it: the replay's base rows,
 * then the operator cells `record-decisions` persisted, then the inherited carry. The record is a
 * rendering of this map, never its source (RSI-Software/t3code-hyprws#1144).
 */
export const decisionTableRows = (report: SyncReport): ReadonlyMap<string, DecisionTableRow> => {
  const decisions = new Map(baseDecisionRows(report));
  // A cell an operator filled by hand outlives regeneration; the report is otherwise the only truth
  // and would reset the decision to TODO.
  for (const filled of report.recordDecisions ?? []) {
    const existing = decisions.get(filled.subject);
    if (existing === undefined) continue;
    decisions.set(filled.subject, {
      ...existing,
      action: filled.action,
      decidedBy: filled.decidedBy,
    });
  }
  // A human verdict that survived a previous walk via `refs/fork/churn` carries forward, marked
  // inherited. Only candidates that are still candidates and have not been answered in this record
  // receive the carry; a fresh human or agent signature always wins.
  const inheritedBySubject = new Map(
    (report.inheritedVerdicts ?? []).map((row) => [row.subject, row]),
  );
  for (const inherited of report.inheritedVerdicts ?? []) {
    const existing = decisions.get(inherited.subject);
    if (existing === undefined) continue;
    if (!existing.classSummary.includes("retire-candidate")) continue;
    if (existing.action !== "TODO") continue;
    decisions.set(inherited.subject, {
      ...existing,
      classSummary: `${existing.classSummary}; inherited from ${inherited.sourceTag}`,
      action: inherited.action,
      decidedBy: `inherited (${inherited.sourceTag})` as DecidedBy,
    });
  }
  return decisions;
};

/** The ledger's view of the same table: one orientation row per decided subject. */
export const recordDecisionRows = (report: SyncReport): ReadonlyArray<OrientationDecisionRow> =>
  [...decisionTableRows(report).values()].map((row) => {
    const qualified = DECISION_ACTIONS.includes(row.action as DecisionAction);
    return {
      subject: row.subject,
      domain: row.domain,
      verdict: (qualified ? "keep" : row.action) as OrientationDecisionRow["verdict"],
      ...(qualified ? { action: row.action as DecisionAction } : {}),
      decidedBy: row.decidedBy,
    };
  });

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
  const decisionRows = [...decisionTableRows(report).values()].map(
    (row) =>
      `| \`${escapeCell(row.subject)}\` | ${row.domain} | ${row.classSummary} | ${row.action} | ${NO_GROUNDING_CLAIM} | ${row.decidedBy} |`,
  );
  const folds = report.folds ?? [];
  const leaseBoundary =
    source?.expectedOld === undefined
      ? "Lease: report has no expected_old — rerun unblock-list"
      : `Lease: report leased at \`${source.expectedOld}\` (origin/hyprws) — a linear landing folds at \`vp run fork:sync unblock-fold\`; movement that cannot fold voids this rehearsal`;
  const leaseGate =
    report.stage === "checked" && source?.expectedOld !== undefined
      ? "Stop. Lease boundary: a linear landing folds at `unblock-fold`; movement that cannot fold past the lease above voids this green rehearsal."
      : undefined;
  return [
    "## Header",
    "",
    ...(folds.length === 0
      ? [`- Source: \`origin/hyprws@${source?.expectedOld ?? "absent"}\``]
      : renderFoldHeader({
          ...(source === undefined
            ? {}
            : { source: { sha: source.sha, expectedOld: source.expectedOld } }),
          ...(report.baseCheckedHead === undefined
            ? {}
            : { baseCheckedHead: report.baseCheckedHead }),
          ...(report.rebasedHead === undefined ? {} : { rebasedHead: report.rebasedHead }),
          folds,
        })),
    `- Target: \`${target?.tag ?? "absent"}@${target?.sha ?? "absent"}\``,
    `- \`expected_old\`: \`${source?.expectedOld ?? "absent"}\``,
    `- ${leaseBoundary}`,
    ...(leaseGate === undefined ? [] : [`- ${leaseGate}`]),
    `- Rehearsal branch: \`${lane?.branch ?? "absent"}\``,
    `- Rebased head: \`${head}\``,
    `- Stack size: \`${report.stackSize ?? report.originalCount ?? 0}\` fork commits`,
    "",
    ...(folds.length === 0 ? [] : [renderFoldSection(folds)]),
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
    report.orientation === undefined
      ? "See orientation in the JSON report."
      : orientationReviewSection(report.orientation),
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
    "## Decisions",
    "",
    ...(() => {
      const rows = walkDecisionsOf(report);
      return rows.length === 0 ? ["None."] : rows.map(decisionLine);
    })(),
    "",
    "## Repair commits",
    "",
    ...((report.walk?.repairCommits ?? []).length === 0
      ? ["None."]
      : (report.walk?.repairCommits ?? []).map(
          (commit) => `- \`${commit.sha}\` \`${escapeCell(commit.subject)}\``,
        )),
    "",
    ...(report.walk?.additive === undefined
      ? []
      : [
          "## Additive",
          "",
          `- pass: ${report.walk.additive.pass}`,
          `- attempts: ${report.walk.additive.attempts}`,
          `- findings: ${report.walk.additive.findings.length}`,
          `- fixed: ${report.walk.additive.fixed.length}`,
          ...(report.walk.additive.commit === undefined
            ? []
            : [`- commit: \`${report.walk.additive.commit}\``]),
          "",
        ]),
    "## Verification",
    "",
    ...report.verification.map((row) => `- \`${row.command}\`: ${row.result}`),
    "",
    ...renderNightlyReview(report),
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

export const isInheritedDecidedBy = (cell: string): boolean =>
  cell.startsWith("inherited (") && cell.endsWith(")");

export const inheritedTarget = (decidedBy: string): string | null => {
  if (!isInheritedDecidedBy(decidedBy)) return null;
  return decidedBy.slice("inherited (".length, -1);
};

/** Keep actions an agent may record on its own, each naming the proof that earned it. */
export const DECISION_ACTIONS = [
  "keep (mechanical seam)",
  "keep (target tree absent)",
  // Upstream carries something the fork commit also carries. Keeping is still the machine's answer:
  // retiring a fork commit removes fork behaviour, and no walk does that without a human.
  "keep (target tree present)",
] as const satisfies ReadonlyArray<DecisionAction>;

/** The additive outcome a walk record or a churn ledger row carries, counts only. */
export interface AdditiveRecordRow {
  readonly pass: boolean;
  readonly attempts: 1 | 2;
  readonly findings: number;
}

export const requireAdditiveRecordRow = (
  value: unknown,
  field = "additive record row",
): AdditiveRecordRow => {
  if (typeof value !== "object" || value === null) throw new Error(`invalid ${field}`);
  const row = value as Record<string, unknown>;
  if (typeof row.pass !== "boolean") throw new Error(`invalid ${field} pass`);
  if (row.attempts !== 1 && row.attempts !== 2) throw new Error(`invalid ${field} attempts`);
  if (!Number.isSafeInteger(row.findings) || (row.findings as number) < 0)
    throw new Error(`invalid ${field} findings`);
  return { pass: row.pass, attempts: row.attempts, findings: row.findings as number };
};

export const orientationReviewSection = (orientation: string): string => {
  const raw = orientation.trimEnd();
  const stopIndex = raw.search(/\n## Stop\n/);
  return stopIndex === -1 ? raw : raw.slice(0, stopIndex).trimEnd();
};
