#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone Git bot runs before an Effect runtime exists.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";

import { UsageError } from "./lib/fork-cli.ts";
import {
  buildAutoRebasePlan,
  commandResult,
  createRebasedStack,
  lines,
  requireSuccess,
  selectNewestTag,
  selectVerificationDependencySetup,
  verifyReplay,
  type AutoRebasePlan,
  type PositionedTag,
  type FeasibilitySource,
  type ReplayVerifier,
  type VerificationDependencySetup,
} from "./fork-auto-rebase-plan.ts";

export {
  buildAutoRebasePlan,
  createRebasedStack,
  selectNewestTag,
  selectVerificationDependencySetup,
  verificationLauncher,
  verifyReplay,
  verifyReplayMetadata,
  type AutoRebasePlan,
  type PositionedTag,
  type ReplayVerifier,
  type VerificationDependencySetup,
} from "./fork-auto-rebase-plan.ts";
import { SystemGit } from "./lib/fork-command.ts";

export { SystemGit } from "./lib/fork-command.ts";
import {
  buildFeasibility,
  type FeasibilityGit,
  type GitCommandResult,
} from "./lib/fork-rebase-feasibility.ts";
import {
  readFeasibilityArtifact,
  type FeasibilityArtifact,
} from "./lib/fork-feasibility-artifact.ts";
import { pushResult, remoteBranchSha, restoreRemoteBranch } from "./lib/fork-rebase-push.ts";
import {
  buildBlockedIssue,
  censusTotals,
  inlineCode,
  type BlockedIssue,
  type RebaseStopCensus,
  type SequentialCensusEvidence,
  type StableCandidate,
} from "./lib/fork-rebase-issues.ts";
import { parseForkTrailers } from "./lib/fork-trailers.ts";
import {
  HYPRWS_REF,
  positionUpstreamReleaseTags,
  stableSnapshotBranch,
} from "./lib/fork-policy.ts";
import { createStableSnapshots, stableCrossingCandidate } from "./fork-stable-crossing.ts";

export type RebaseMode = "off" | "candidate" | "on";

export interface AutoRebaseOptions {
  readonly mode: RebaseMode;
  readonly fetch: boolean;
  readonly target: string | null;
  readonly dryRun: boolean;
  readonly githubOutput: boolean;
  readonly summary: string | null;
  readonly issueJson: string | null;
  readonly feasibility: string | null;
}

export interface AutoRebaseResult {
  readonly schemaVersion: 1;
  readonly mode: RebaseMode;
  readonly dryRun: boolean;
  readonly status: "off" | "no-op" | "advanced";
  readonly oldSha: string;
  readonly baseSha: string;
  readonly target: { readonly tag: string; readonly sha: string } | null;
  readonly newSha: string | null;
  readonly stableCandidates: ReadonlyArray<StableCandidate>;
  readonly verificationDependencySetup: ReadonlyArray<VerificationDependencySetup>;
  readonly decision: {
    readonly pairwiseFirstConflict: {
      readonly sha: string;
      readonly shortSha: string;
      readonly subject: string;
    } | null;
    readonly census: RebaseStopCensus | null;
    readonly censusUnavailableReason: string | null;
  };
  readonly blocked: BlockedIssue | null;
}

export { UsageError } from "./lib/fork-cli.ts";

const HELP = `Usage: vp run fork:auto-rebase [options]

Rebase the fork stack onto the newest clean upstream release tag.

Options:
  --mode <off|candidate|on>  Mutation mode (default: candidate)
  --fetch                    Fetch origin and upstream refs first
  --target <ref>             Override the selected clean-window target
  --dry-run                  Rehearse and verify without pushing
  --github-output            Write result fields to $GITHUB_OUTPUT
  --summary <path>           Write a Markdown run summary
  --issue-json <path>        Write blocked and stable-candidate issue data
  --feasibility <path>       Carry a feasibility artifact from the report job
  -h, --help                 Show help
`;

const defaultOptions = (): AutoRebaseOptions => ({
  mode: "candidate",
  fetch: false,
  target: null,
  dryRun: false,
  githubOutput: false,
  summary: null,
  issueJson: null,
  feasibility: null,
});

export const parseAutoRebaseArgs = (argv: ReadonlyArray<string>): AutoRebaseOptions => {
  const options = { ...defaultOptions() };
  const seen = new Set<string>();
  const booleans = new Set(["--fetch", "--dry-run", "--github-output"]);
  const values = new Set(["--mode", "--target", "--summary", "--issue-json", "--feasibility"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "-h" || argument === "--help") continue;
    if (seen.has(argument)) throw new UsageError(`duplicate option: ${argument}`);
    if (booleans.has(argument)) {
      seen.add(argument);
      if (argument === "--fetch") options.fetch = true;
      else if (argument === "--dry-run") options.dryRun = true;
      else options.githubOutput = true;
      continue;
    }
    if (!values.has(argument)) throw new UsageError(`unknown option: ${argument}`);
    seen.add(argument);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new UsageError(`missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--mode") {
      if (value !== "off" && value !== "candidate" && value !== "on") {
        throw new UsageError(`mode must be off, candidate, or on: ${value}`);
      }
      options.mode = value;
    } else if (argument === "--target") options.target = value;
    else if (argument === "--summary") options.summary = value;
    else if (argument === "--feasibility") options.feasibility = value;
    else options.issueJson = value;
  }
  return options;
};

const trackingBranchExists = (git: Pick<FeasibilityGit, "runResult">, branch: string): boolean =>
  git.runResult(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).status === 0;

/**
 * A carried artifact is an optimization, never a dependency: a missing or malformed
 * one is reported and the walk runs, because recomputing is always correct.
 */
const carriedArtifact = (path: string | null): FeasibilityArtifact | null => {
  if (path === null) return null;
  try {
    return readFeasibilityArtifact(path);
  } catch (error) {
    if (process.env.FORK_QUIET !== "1") {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`auto-rebase: carried feasibility unusable (${message})\n`);
    }
    return null;
  }
};

const reportFeasibilitySource = (source: FeasibilitySource): void => {
  if (process.env.FORK_QUIET === "1") return;
  const rewalked =
    source.mergesRewalked === 0
      ? ""
      : `, ${String(source.mergesRewalked)} re-walked for an unreadable tree`;
  const merges = `${String(source.mergesCarried)} merges carried, ${String(source.mergesComputed)} computed${rewalked}`;
  process.stderr.write(
    source.carried
      ? `auto-rebase: feasibility carried from the report job (${merges})\n`
      : `auto-rebase: feasibility walked${source.refusal === null ? "" : ` (carried walk refused: ${source.refusal})`} (${merges})\n`,
  );
};

/**
 * The bounded failure reason for a failed auto-rebase attempt receipt
 * (RSI-Software/t3code-hyprws#1018). Machine-dependent text (absolute paths, temporary
 * worktrees, pids) would make the stored detail environment-dependent, so it is stripped
 * the way censusUnavailableReason strips its own — the ledger keeps the reason, never the
 * free text (RSI-Software/t3code-hyprws#1012).
 */
export const autoFailureReason = (root: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message
    .replaceAll(root, "<repository>")
    .replace(/\/(?:private\/)?tmp\/[^\s/:]+(?:-files)?/g, "<temporary-worktree>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return normalized || "unknown auto-rebase failure";
};

/** The phase that owned the throw, so the receipt names where the walk died. */
export type AutoFailurePhase = "plan" | "execute";

/**
 * Leave the failure receipt the retain step reads: the rebase wrote its outcome declarations
 * before executing, so a throw after that point still leaves an attempt identity plus this
 * bounded reason, and the always() retain step records a failed stage instead of silence.
 */
export const writeAutoFailure = (
  root: string,
  issueJson: string,
  phase: AutoFailurePhase,
  error: unknown,
): void => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.resolve(root, issueJson)), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.resolve(root, `${issueJson}.failure.json`),
    `${JSON.stringify({ version: 1, phase, reason: autoFailureReason(root, error) })}\n`,
  );
};

const blockedReport = (
  plan: Pick<AutoRebasePlan, "target" | "newestTagBeyondWindow" | "feasibility">,
  census: RebaseStopCensus | null,
  censusUnavailable: string | null,
): BlockedIssue | null => {
  if (plan.feasibility.ffBoundary.firstConflict === null) return null;
  if (census?.conflictingForkCommitCount === 0 && !census.truncated) return null;
  return buildBlockedIssue(plan, census, censusUnavailable);
};

const postAdvanceBlockedPlan = (
  git: FeasibilityGit,
  plan: AutoRebasePlan,
  newSha: string,
): Pick<
  AutoRebasePlan,
  "target" | "newestTagBeyondWindow" | "feasibility" | "oldSha" | "baseSha" | "horizon"
> => {
  if (plan.target === null) throw new Error("cannot refresh a blocked plan without a target");
  const baseSha = plan.target.sha;
  if (plan.censusTarget === null) {
    throw new Error("cannot refresh a blocked plan without a census target");
  }
  const feasibility = buildFeasibility(git, newSha, plan.censusTarget.sha, baseSha);
  const upstreamCommits = lines(
    git.run(["rev-list", "--first-parent", "--reverse", `${baseSha}..${plan.censusTarget.sha}`]),
  );
  return {
    oldSha: newSha,
    baseSha,
    horizon: plan.censusTarget,
    target: plan.target,
    newestTagBeyondWindow: selectNewestTag(
      positionUpstreamReleaseTags(git, [baseSha, ...upstreamCommits]).filter(
        (tag) => tag.position > feasibility.ffBoundary.cleanCommitCount,
      ),
    ),
    feasibility,
  };
};

export interface AutoRebaseHooks {
  readonly beforeHyprwsPush?: () => void;
}

export const executeAutoRebase = (
  root: string,
  options: AutoRebaseOptions,
  plan: AutoRebasePlan,
  verify: ReplayVerifier = verifyReplay,
  hooks: AutoRebaseHooks = {},
): AutoRebaseResult => {
  const git = new SystemGit(root);
  const stableCandidates: Array<StableCandidate> = [];
  const dependencySetups = new Set<VerificationDependencySetup>();
  const pairwiseFirstConflict = plan.feasibility.ffBoundary.firstConflict;
  const census: RebaseStopCensus | null = null;
  const censusUnavailableReason: string | null = null;
  const censusConflictCount: number | null = null;
  const target = censusConflictCount === 0 ? plan.censusTarget : plan.target;
  const decidedPlan = { ...plan, target };
  const decision = { pairwiseFirstConflict, census, censusUnavailableReason };
  if (options.mode === "off") {
    const blocked = blockedReport(decidedPlan, census, censusUnavailableReason);
    return {
      schemaVersion: 1,
      mode: options.mode,
      dryRun: options.dryRun,
      status: "off",
      oldSha: plan.oldSha,
      baseSha: plan.baseSha,
      target: target === null ? null : { tag: target.tag, sha: target.sha },
      newSha: null,
      stableCandidates,
      verificationDependencySetup: [],
      decision,
      blocked,
    };
  }
  for (const stable of plan.stableTags.filter(
    (candidate) => candidate.position <= (target?.position ?? 0),
  )) {
    if (trackingBranchExists(git, stableSnapshotBranch(stable.tag))) continue;
    const stack =
      stable.position === 0
        ? null
        : createRebasedStack(root, plan.oldSha, plan.baseSha, stable.sha, verify);
    if (stack !== null) dependencySetups.add(stack.dependencySetup);
    stableCandidates.push(
      stableCrossingCandidate(
        stable.tag,
        stack?.sha ?? plan.oldSha,
        // The trunk has already adopted the position-zero stack.
        stable.position === 0 ? "on" : options.mode,
      ),
    );
  }

  if (target === null || target.sha === plan.baseSha) {
    const blocked = blockedReport(decidedPlan, census, censusUnavailableReason);
    if (!options.dryRun) createStableSnapshots(root, stableCandidates, true);
    return {
      schemaVersion: 1,
      mode: options.mode,
      dryRun: options.dryRun,
      status: "no-op",
      oldSha: plan.oldSha,
      baseSha: plan.baseSha,
      target: target === null ? null : { tag: target.tag, sha: target.sha },
      newSha: null,
      stableCandidates,
      verificationDependencySetup: [],
      decision,
      blocked,
    };
  }

  // Verify every replay before the first mutation. A feasibility mismatch or
  // failed check therefore leaves all remote refs untouched.
  const targetStack = createRebasedStack(root, plan.oldSha, plan.baseSha, target.sha, verify);
  dependencySetups.add(targetStack.dependencySetup);
  const newSha = targetStack.sha;
  const refreshedPlan =
    censusConflictCount === 0 ? decidedPlan : postAdvanceBlockedPlan(git, decidedPlan, newSha);
  const blocked = blockedReport(refreshedPlan, census, censusUnavailableReason);
  if (!options.dryRun) {
    const previousBeforeRun =
      options.mode === "on" ? remoteBranchSha(root, "hyprws-previous") : null;
    if (options.mode === "on") {
      requireSuccess(
        "validate leased push hyprws",
        pushResult(root, [
          "--dry-run",
          "origin",
          `${newSha}:${HYPRWS_REF}`,
          `--force-with-lease=${HYPRWS_REF}:${plan.oldSha}`,
        ]),
      );
    }
    const pushedSnapshots = createStableSnapshots(root, stableCandidates);
    if (options.mode === "candidate") {
      requireSuccess(
        "push hyprws-next",
        pushResult(root, ["--force", "origin", `${newSha}:${HYPRWS_REF}-next`]),
      );
    } else {
      requireSuccess(
        "push hyprws-previous",
        pushResult(root, ["--force", "origin", `${plan.oldSha}:${HYPRWS_REF}-previous`]),
      );
      hooks.beforeHyprwsPush?.();
      const leasedPush = pushResult(root, [
        "origin",
        `${newSha}:${HYPRWS_REF}`,
        `--force-with-lease=${HYPRWS_REF}:${plan.oldSha}`,
      ]);
      if (leasedPush.status !== 0 || leasedPush.error !== undefined) {
        for (const branch of pushedSnapshots.toReversed()) {
          restoreRemoteBranch(root, branch, null);
        }
        restoreRemoteBranch(root, "hyprws-previous", previousBeforeRun);
      }
      requireSuccess("leased push hyprws", leasedPush);
    }
  }
  return {
    schemaVersion: 1,
    mode: options.mode,
    dryRun: options.dryRun,
    status: "advanced",
    oldSha: plan.oldSha,
    baseSha: plan.baseSha,
    target: { tag: target.tag, sha: target.sha },
    newSha,
    stableCandidates,
    verificationDependencySetup: [...dependencySetups].toSorted(),
    decision,
    blocked,
  };
};

export const renderSummary = (result: AutoRebaseResult): string => {
  const pushOrdering =
    result.dryRun || (result.status !== "advanced" && result.stableCandidates.length === 0)
      ? "none"
      : result.status === "no-op"
        ? "create-only release/*"
        : result.mode === "candidate"
          ? "create-only release/*, then force-update hyprws-next"
          : "lease preflight, create-only release/*, hyprws-previous, then leased hyprws; a lease failure rolls back snapshots and hyprws-previous";
  const lines = [
    "# hyprws auto-rebase",
    "",
    `- Mode: \`${result.mode}\`${result.dryRun ? " (dry run)" : ""}`,
    `- Status: \`${result.status}\``,
    `- Old head: \`${result.oldSha}\``,
    `- Base: \`${result.baseSha}\``,
    `- Target: ${result.target === null ? "none" : `\`${result.target.tag}\` (\`${result.target.sha}\`)`}`,
    `- Rebased head: ${result.newSha === null ? "none" : `\`${result.newSha}\``}`,
    `- Stable candidates: ${result.stableCandidates.length}`,
    `- Dependency setup: ${result.verificationDependencySetup.length === 0 ? "not run" : result.verificationDependencySetup.join(", ")}`,
    `- Push ordering: ${pushOrdering}`,
    `- pairwise merge-tree: ${
      result.decision.pairwiseFirstConflict === null
        ? "clean"
        : `conflict at ${result.decision.pairwiseFirstConflict.shortSha}`
    }`,
    `- decided by: ${
      result.decision.censusUnavailableReason !== null
        ? `pairwise (census unavailable: ${result.decision.censusUnavailableReason})`
        : result.decision.census === null
          ? "pairwise (census not needed)"
          : `census (${
              result.decision.census.conflictingForkCommitCount === 0
                ? "0 conflicts"
                : `${result.decision.census.conflictingForkCommitCount} conflicts at ${result.blocked?.blockingShortSha ?? result.decision.pairwiseFirstConflict?.shortSha ?? "unknown"}`
            })`
    }`,
  ];
  if (result.status === "no-op") {
    lines.push("", "No clean upstream tag lies beyond the current base.");
    for (const candidate of result.stableCandidates) {
      const status = result.dryRun ? "Snapshot pending" : "Created snapshot";
      lines.push(`- ${status}: \`${candidate.branch}\` at \`${candidate.sha}\``);
    }
  }
  if (result.blocked !== null) {
    lines.push(
      "",
      "## Blocked beyond the clean window",
      "",
      `- First conflict: ${inlineCode(`${result.blocked.blockingShortSha} ${result.blocked.subject}`)}`,
      `- Remaining upstream commits: ${result.blocked.remainingUpstreamCount}`,
      `- Newest later tag: ${result.blocked.newestUpstreamTagBeyondWindow ?? "none"}`,
    );
  }
  return `${lines.join("\n")}\n`;
};

const writeOutput = (path: string, contents: string): void => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents, "utf8");
};

const fetchRefs = (git: SystemGit): void => {
  git.run(["fetch", "--prune", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  git.run(["fetch", "--prune", "--tags", "upstream", "main"]);
};

export const run = (argv: ReadonlyArray<string>, cwd = process.cwd()): number => {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const options = parseAutoRebaseArgs(argv);
    const bootstrap = new SystemGit(cwd);
    const root = bootstrap.run(["rev-parse", "--show-toplevel"]).trim();
    const git = new SystemGit(root);
    if (options.fetch) fetchRefs(git);
    // Read exactly once. Every later hyprws mutation uses this expected old SHA.
    const oldSha = git.run(["rev-parse", "origin/hyprws^{commit}"]).trim();
    const plan = buildAutoRebasePlan(
      git,
      oldSha,
      options.target,
      carriedArtifact(options.feasibility),
    );
    reportFeasibilitySource(plan.feasibilitySource);
    let result: AutoRebaseResult;
    try {
      result = executeAutoRebase(root, options, plan, verifyReplay);
    } catch (error) {
      // The declarations are already on disk, so the always() retain step can still record
      // this attempt: leave the bounded failure receipt it reads
      // (RSI-Software/t3code-hyprws#1018).
      if (options.issueJson !== null) writeAutoFailure(root, options.issueJson, "execute", error);
      throw error;
    }
    const summary = renderSummary(result);
    if (options.summary !== null) writeOutput(NodePath.resolve(root, options.summary), summary);
    else process.stdout.write(summary);
    if (options.issueJson !== null) {
      writeOutput(
        NodePath.resolve(root, options.issueJson),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
    if (options.githubOutput) {
      const output = process.env.GITHUB_OUTPUT;
      if (!output) throw new UsageError("--github-output requires GITHUB_OUTPUT");
      NodeFS.appendFileSync(
        output,
        [
          `status=${result.blocked !== null ? "blocked" : result.stableCandidates.length > 0 ? "stable-candidate" : "clear"}`,
          `execution_status=${result.status}`,
          `target=${result.target?.tag ?? ""}`,
          `new_sha=${result.newSha ?? ""}`,
          `blocked=${result.blocked === null ? "false" : "true"}`,
          `blocked_status=${result.blocked === null ? "clear" : "blocked"}`,
          `blocking_sha=${result.blocked?.blockingSha ?? ""}`,
          // The bot-carried unblock walk targets this tag (RSI-Software/t3code-hyprws#444).
          `blocked_tag=${result.blocked?.newestUpstreamTagBeyondWindow ?? ""}`,
          `stable_candidate_count=${result.stableCandidates.length}`,
          `stable_status=${result.stableCandidates.length === 0 ? "none" : "stable-candidate"}`,
        ].join("\n") + "\n",
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`usage: ${error.message}\nTry --help.\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`failed: ${message}\n`);
    return 1;
  }
};

export { parseAutoRebaseArgs as parseArgs };

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
