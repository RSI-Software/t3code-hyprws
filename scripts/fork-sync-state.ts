// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Sync records are standalone operator state.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { UsageError } from "./lib/fork-cli.ts";
import {
  requireCommandSuccess,
  type CwdCommandRunner as CommandRunner,
} from "./lib/fork-command.ts";
import { FORK_REPOSITORY, isNightlyUpstreamTag } from "./lib/fork-policy.ts";

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

/** Runtime identity recorded for each side of the nightly two-agent control. */
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

/** Accept concrete Claude Opus 4+ model IDs, not legacy or descriptive aliases. */
export const isClaudeOpusModel = (model: string): boolean => {
  const match = /^claude-(?:(\d+(?:[-.]\d+)*)-)?opus(?:[-.](\d+(?:[-.]\d+)*))(?:-\d{8})?$/i.exec(
    model,
  );
  const version = match?.[1] ?? match?.[2];
  return version !== undefined && Number.parseInt(version.split(/[.-]/)[0] ?? "", 10) >= 4;
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

export type DecisionAction = "keep (mechanical seam)" | "keep (target tree absent)";

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
  /**
   * The walk is being carried by the auto-rebase workflow itself, so the bot is
   * on by construction and the lane is minted with plain Git
   * (RSI-Software/t3code-hyprws#444).
   */
  readonly botCarried?: boolean;
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
  readonly retireEvidence?: ReadonlyArray<RetireEvidence>;
  readonly recordDecisions?: ReadonlyArray<RecordDecision>;
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
  readonly reconciliation?: {
    readonly state: "dispatched" | "ambiguous";
    readonly runUrl?: string;
    readonly baselineRunId?: number;
  };
}

export const SYNC_HELP = `Usage: vp run fork:sync <verb> [options]

Unblock verbs:
  unblock-auto [--target <tag@sha>] [--report <external-json>] [--resume] [--bot-carried] [--silent-seam <path>=<summary>:behaviour|type ...]
  unblock-list [--output <external-json>] [--all]
  unblock-orient --report <json> --target <release-tag>
  unblock-rehearse --report <json>
  unblock-check --report <json> [--silent-seam <path>=<summary>:behaviour|type ...]
  unblock-review --report <json> (--sign-off | --withhold <reason>)
  unblock-refresh --report <json>
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
    if (values.has(flag) && flag !== "--silent-seam")
      throw new UsageError(`duplicate option: ${flag}`);
    if (
      flag === "--resume" ||
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
    if (flag === "--silent-seam" && values.has(flag)) {
      values.set(flag, `${values.get(flag)}\n${value}`);
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
    "## Nightly independent review",
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
      readonly decidedBy: DecidedBy;
    }
  >();
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
    const existing = decisions.get(row.subject);
    decisions.set(row.subject, {
      subject: row.subject,
      domain: row.domain,
      classSummary: existing === undefined ? row.class : `${existing.classSummary}; ${row.class}`,
      action: existing?.action ?? "TODO",
      decidedBy: existing?.decidedBy ?? row.decidedBy,
    });
  }
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
  const decisionRows = [...decisions.values()].map((row) => {
    const inherited = inheritedBySubject.get(row.subject);
    const decidedCell =
      inherited !== undefined &&
      row.decidedBy === (`inherited (${inherited.sourceTag})` as DecidedBy)
        ? row.decidedBy
        : row.decidedBy;
    return `| \`${escapeCell(row.subject)}\` | ${row.domain} | ${row.classSummary} | ${row.action} | ${NO_GROUNDING_CLAIM} | ${decidedCell} |`;
  });
  const leaseBoundary =
    source?.expectedOld === undefined
      ? "Lease: report has no expected_old — rerun unblock-list"
      : `Lease: report leased at \`${source.expectedOld}\` (origin/hyprws) — any movement of \`origin/hyprws\` voids this rehearsal; restart at \`vp run fork:sync unblock-list\``;
  const leaseGate =
    report.stage === "checked" && source?.expectedOld !== undefined
      ? "Stop. Lease boundary: any movement of `origin/hyprws` past the lease above voids this green rehearsal."
      : undefined;
  return [
    "## Header",
    "",
    `- Source: \`origin/hyprws@${source?.expectedOld ?? "absent"}\``,
    `- Target: \`${target?.tag ?? "absent"}@${target?.sha ?? "absent"}\``,
    `- \`expected_old\`: \`${source?.expectedOld ?? "absent"}\``,
    `- ${leaseBoundary}`,
    ...(leaseGate === undefined ? [] : [`- ${leaseGate}`]),
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

export const isInheritedDecidedBy = (cell: string): boolean =>
  cell.startsWith("inherited (") && cell.endsWith(")");

export const inheritedTarget = (decidedBy: string): string | null => {
  if (!isInheritedDecidedBy(decidedBy)) return null;
  return decidedBy.slice("inherited (".length, -1);
};

/** An absent column is a record written before provenance existed, so it carries none. */
const readDecidedBy = (cell: string | undefined, invalid: (detail: string) => Error): DecidedBy => {
  if (cell === undefined || cell === "TODO") return "TODO";
  if (cell === "human" || cell === "agent") return cell;
  if (cell !== undefined && isInheritedDecidedBy(cell)) return cell as DecidedBy;
  throw invalid(cell);
};

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
      decidedBy: readDecidedBy(cells[6], (detail) => invalidConflictCell("Decided by", detail)),
    });
  }
  return rows;
};

/** Keep actions an agent may record on its own, each naming the proof that earned it. */
export const DECISION_ACTIONS = [
  "keep (mechanical seam)",
  "keep (target tree absent)",
] as const satisfies ReadonlyArray<DecisionAction>;

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
    const qualified = DECISION_ACTIONS.includes(action as DecisionAction);
    const verdict = qualified ? "keep" : action;
    if (!["keep", "retire", "partial"].includes(verdict)) {
      throw invalidDecisionCell(
        "Action",
        `expected keep, ${DECISION_ACTIONS.join(", ")}, retire, or partial; found ${action}`,
      );
    }
    rows.push({
      subject: unescapeCell(subject[1] ?? "", "Exact subject"),
      domain,
      verdict: verdict as OrientationDecisionRow["verdict"],
      ...(qualified ? { action: action as DecisionAction } : {}),
      decidedBy: readDecidedBy(cells[5], (detail) => invalidDecisionCell("Decided by", detail)),
    });
  }
  return rows;
};

/**
 * Decision cells an operator already filled, read without demanding a complete record. A row still
 * showing `TODO` carries no decision, so it is not returned.
 */
export const filledDecisionCells = (record: string): ReadonlyArray<RecordDecision> => {
  const section = recordSection(record, "## Fork commits");
  const rows: Array<RecordDecision> = [];
  for (const line of section.split("\n")) {
    const cells = splitTableCells(line);
    if (cells === null || cells[0] === "Exact subject") continue;
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    if (cells.length !== 5 && cells.length !== 6) continue;
    const subject = /^`([^`]*)`$/.exec(cells[0] ?? "");
    const action = cells[3] ?? "";
    if (subject === null || !["keep", ...DECISION_ACTIONS, "retire", "partial"].includes(action))
      continue;
    const decidedBy = readDecidedBy(cells[5], (detail) =>
      invalidDecisionCell("Decided by", detail),
    );
    if (decidedBy === "TODO") continue;
    // Inherited verdicts never read back as live operator input; they are the carry-form.
    if (isInheritedDecidedBy(decidedBy)) continue;
    rows.push({
      subject: unescapeCell(subject[1] ?? "", "Exact subject"),
      action,
      // Inherited cells were already guarded above.
      decidedBy: decidedBy as Exclude<DecidedBy, "TODO">,
    });
  }
  return rows;
};

export const inheritedDecisionCells = (
  record: string,
): ReadonlyArray<InheritedVerdict & { readonly sourceTag: string }> => {
  const section = recordSection(record, "## Fork commits");
  const rows: Array<InheritedVerdict & { readonly sourceTag: string }> = [];
  for (const line of section.split("\n")) {
    const cells = splitTableCells(line);
    if (cells === null || cells[0] === "Exact subject") continue;
    if (cells.every((cell) => /^-+$/.test(cell))) continue;
    if (cells.length !== 5 && cells.length !== 6) continue;
    const subject = /^`([^`]*)`$/.exec(cells[0] ?? "");
    const domain = cells[1] ?? "";
    const action = cells[3] ?? "";
    if (subject === null || !["keep", ...DECISION_ACTIONS, "retire", "partial"].includes(action))
      continue;
    const decidedBy = readDecidedBy(cells[5], (detail) =>
      invalidDecisionCell("Decided by", detail),
    );
    const sourceTag = inheritedTarget(decidedBy);
    if (sourceTag === null) continue;
    rows.push({
      subject: unescapeCell(subject[1] ?? "", "Exact subject"),
      domain,
      action,
      decidedBy: decidedBy as Exclude<DecidedBy, "TODO">,
      sourceTag,
    });
  }
  return rows;
};

export interface ParsedRecord {
  readonly conflicts: ReadonlyArray<ConflictRow>;
  readonly decisions: ReadonlyArray<OrientationDecisionRow>;
  readonly nightlyReview?: NightlyReview;
}

const reviewIdentity = (section: string, label: string): AgentProvenance | undefined => {
  const line = section.split("\n").find((value) => value.startsWith(`- ${label}: `));
  const match =
    /^- (?:Proposer|Reviewer): agent `([^/]+)\/([^/]+)\/([^`]+)`, session `([^`]+)`$/.exec(
      line ?? "",
    );
  return match === null
    ? undefined
    : requireAgentProvenance(
        {
          iface: match[1] ?? "",
          provider: match[2] ?? "",
          model: match[3] ?? "",
          session: match[4] ?? "",
        },
        `nightly ${label.toLowerCase()}`,
      );
};

const reviewList = (
  section: string,
  label: string,
  nextLabel: string | null,
): ReadonlyArray<string> => {
  const start = section.indexOf(`- ${label}:\n`);
  if (start === -1) return [];
  const rest = section.slice(start + label.length + 4);
  const end = nextLabel === null ? rest.length : rest.indexOf(`\n- ${nextLabel}:\n`);
  return (end === -1 ? rest : rest.slice(0, end))
    .split("\n")
    .filter((line) => line.startsWith("  - "))
    .map((line) => line.slice(4));
};

/** Parse the durable nightly reviewer provenance from a rendered record. */
export const parseNightlyReview = (record: string): NightlyReview | undefined => {
  const review = recordSection(record, "## Nightly independent review");
  const status = /^- Verdict: (signed-off|withheld)$/m.exec(review)?.[1] as
    | NightlyReview["status"]
    | undefined;
  if (status === undefined) return undefined;
  if (
    JSON.stringify(reviewList(review, "Review evidence set", "Withhold on")) !==
      JSON.stringify(NIGHTLY_REVIEW_EVIDENCE) ||
    JSON.stringify(reviewList(review, "Withhold on", null)) !==
      JSON.stringify(NIGHTLY_WITHHOLD_RULES)
  )
    throw new Error("nightly review declarations are incomplete");
  const proposer = reviewIdentity(review, "Proposer");
  const reviewer = reviewIdentity(review, "Reviewer");
  if (proposer === undefined || reviewer === undefined)
    throw new Error("nightly review provenance is incomplete");
  const binding =
    /^- Evidence binding: target `([^@`]+)@([^`]+)`; blocking `([^`]+)`; expected-old `([^`]+)`; installed `([^`]+)`; CI `([^`]+)`; lane `([^`]+)`; record `([^`]+)`$/m.exec(
      review,
    );
  const reviewedAt = /^- Reviewed at: (.+)$/m.exec(review)?.[1];
  if (reviewedAt === undefined) throw new Error("nightly review timestamp is missing");
  const reason = /^- Withheld reason: (.+)$/m.exec(review)?.[1];
  return requireNightlyReview({
    status,
    proposer,
    reviewer,
    reviewedAt,
    ...(binding === null
      ? {}
      : {
          evidence: {
            target: binding[1] ?? "",
            targetSha: binding[2] ?? "",
            blockingSha: binding[3] ?? "",
            expectedOld: binding[4] ?? "",
            installedHead: binding[5] ?? "",
            ciHead: binding[6] ?? "",
            laneBranch: binding[7] ?? "",
            recordDigest: binding[8] ?? "",
            inspected: NIGHTLY_REVIEW_EVIDENCE,
          },
        }),
    ...(reason === undefined ? {} : { reason }),
  });
};

/** Reads the decision tables and independent-review provenance for a landed walk. */
export const parseRecord = (record: string): ParsedRecord => {
  const conflicts = parseConflictRows(record);
  const incomplete = conflicts.find((row) => row.class === "TODO");
  if (incomplete !== undefined)
    throw new Error(`conflict row remains incomplete for ${incomplete.path}`);
  const nightlyReview = parseNightlyReview(record);
  return {
    conflicts,
    decisions: parseDecisionRows(record),
    ...(nightlyReview === undefined ? {} : { nightlyReview }),
  };
};

export const orientationReviewSection = (orientation: string): string => {
  const raw = orientation.trimEnd();
  const stopIndex = raw.search(/\n## Stop\n/);
  return stopIndex === -1 ? raw : raw.slice(0, stopIndex).trimEnd();
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
      decidedBy: "TODO",
    }),
  );
