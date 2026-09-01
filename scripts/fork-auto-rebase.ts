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
  type ReplayVerifier,
  type VerificationDependencySetup,
} from "./fork-auto-rebase-plan.ts";

export {
  buildAutoRebasePlan,
  createRebasedStack,
  selectNewestTag,
  selectVerificationDependencySetup,
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
  pushResult,
  remoteBranchExists,
  remoteBranchSha,
  restoreRemoteBranch,
} from "./lib/fork-rebase-push.ts";
import {
  buildBlockedIssue,
  inlineCode,
  stableCandidateBody,
  type BlockedIssue,
  type RebaseStopCensus,
  type StableCandidate,
} from "./lib/fork-rebase-issues.ts";
import { HYPRWS_REF, positionUpstreamReleaseTags } from "./lib/fork-policy.ts";

export type RebaseMode = "off" | "candidate" | "on";

export interface AutoRebaseOptions {
  readonly mode: RebaseMode;
  readonly fetch: boolean;
  readonly target: string | null;
  readonly dryRun: boolean;
  readonly githubOutput: boolean;
  readonly summary: string | null;
  readonly issueJson: string | null;
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
});

export const parseAutoRebaseArgs = (argv: ReadonlyArray<string>): AutoRebaseOptions => {
  const options = { ...defaultOptions() };
  const seen = new Set<string>();
  const booleans = new Set(["--fetch", "--dry-run", "--github-output"]);
  const values = new Set(["--mode", "--target", "--summary", "--issue-json"]);
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
    else options.issueJson = value;
  }
  return options;
};

const trackingBranchExists = (git: Pick<FeasibilityGit, "runResult">, branch: string): boolean =>
  git.runResult(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).status === 0;

const createStableSnapshots = (
  root: string,
  candidates: Array<StableCandidate>,
  skipExisting = false,
): ReadonlyArray<string> => {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate === undefined || !remoteBranchExists(root, candidate.branch)) continue;
    if (!skipExisting) {
      throw new Error(`refusing to replace create-only branch origin/${candidate.branch}`);
    }
    process.stdout.write(`skip stable snapshot: origin/${candidate.branch} already exists\n`);
    candidates.splice(index, 1);
  }
  return candidates.map((candidate) => {
    requireSuccess(
      `create origin/${candidate.branch}`,
      pushResult(root, ["origin", `${candidate.sha}:refs/heads/${candidate.branch}`]),
    );
    return candidate.branch;
  });
};

export type StopCensusRunner = (
  root: string,
  headSha: string,
  baseSha: string,
  target: PositionedTag,
) => RebaseStopCensus;

const STOP_CENSUS_LIMIT = 128;
const STOP_CENSUS_TIME_LIMIT_MS = 6 * 60 * 1000;

interface StopCensusLimits {
  readonly stopLimit: number;
  readonly timeLimitMs: number;
  readonly now: () => number;
}

const defaultStopCensusLimits = (): StopCensusLimits => ({
  stopLimit: STOP_CENSUS_LIMIT,
  timeLimitMs: STOP_CENSUS_TIME_LIMIT_MS,
  now: () => NodePerfHooks.performance.now(),
});

const hasStage = (stages: string, stage: number): boolean =>
  stages.split("\n").some((line) => line.includes(` ${stage}\t`));

const moveAside = (worktree: string, cemetery: string, path: string, index: number): void => {
  const absolute = NodePath.resolve(worktree, path);
  if (!absolute.startsWith(`${NodePath.resolve(worktree)}${NodePath.sep}`)) {
    throw new Error(`refusing to resolve a conflict path outside the census worktree: ${path}`);
  }
  try {
    NodeFS.lstatSync(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  NodeFS.mkdirSync(cemetery, { recursive: true });
  NodeFS.renameSync(absolute, NodePath.join(cemetery, String(index)));
};

const timedOut = (result: GitCommandResult): boolean =>
  result.error instanceof Error && "code" in result.error && result.error.code === "ETIMEDOUT";

export const rehearseStopCensus = (
  root: string,
  headSha: string,
  baseSha: string,
  target: PositionedTag,
  limits: StopCensusLimits = defaultStopCensusLimits(),
): RebaseStopCensus => {
  const startedAt = limits.now();
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-rebase-census-"));
  const cemetery = `${worktree}-files`;
  const rootGit = new SystemGit(root);
  let worktreeGit: SystemGit | null = null;
  const conflictingCommits = new Set<string>();
  let conflictingFileCount = 0;
  let stopCount = 0;
  let movedFileCount = 0;
  let truncatedBy: RebaseStopCensus["truncatedBy"] = null;
  const remainingTime = (): number => limits.timeLimitMs - (limits.now() - startedAt);
  const runRebase = (args: ReadonlyArray<string>): GitCommandResult | null => {
    const remaining = remainingTime();
    if (remaining <= 0) {
      truncatedBy = "time-limit";
      return null;
    }
    const result = worktreeGit?.runResult(args, Math.max(1, Math.ceil(remaining))) ?? null;
    if (result !== null && timedOut(result)) {
      truncatedBy = "time-limit";
      return null;
    }
    return result;
  };
  const rebaseArgs = [
    "-c",
    "core.editor=true",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "rerere.enabled=false",
    "-c",
    "rerere.autoupdate=false",
    "rebase",
  ] as const;
  try {
    rootGit.run(["worktree", "add", "--detach", worktree, headSha]);
    worktreeGit = new SystemGit(worktree);
    let rebase = runRebase([...rebaseArgs, "--empty=drop", "--onto", target.sha, baseSha, headSha]);
    while (
      truncatedBy === null &&
      rebase !== null &&
      (rebase.status !== 0 || rebase.error !== undefined)
    ) {
      if (rebase.error !== undefined) requireSuccess("start or continue census rebase", rebase);
      if (remainingTime() <= 0) {
        truncatedBy = "time-limit";
        break;
      }
      const rebaseHead = worktreeGit.runResult(["rev-parse", "--verify", "REBASE_HEAD"]);
      const conflictPaths = worktreeGit
        .run(["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U", "-z"])
        .split("\0")
        .filter(Boolean);
      if (rebaseHead.status !== 0) requireSuccess("start or continue census rebase", rebase);
      if (conflictPaths.length === 0) {
        rebase = runRebase([...rebaseArgs, "--skip"]);
        continue;
      }
      conflictingCommits.add(rebaseHead.stdout.trim());
      conflictingFileCount += conflictPaths.length;
      stopCount += 1;
      if (stopCount >= limits.stopLimit) {
        truncatedBy = "stop-limit";
        break;
      }
      for (const [index, path] of conflictPaths.entries()) {
        if (remainingTime() <= 0) {
          truncatedBy = "time-limit";
          break;
        }
        const stages = worktreeGit.run(["ls-files", "--stage", "--", path]);
        if (hasStage(stages, 3)) {
          worktreeGit.run(["checkout-index", "--force", "--stage=3", "--", path]);
        } else {
          moveAside(worktree, cemetery, path, movedFileCount + index);
        }
        worktreeGit.run(["add", "--all", "--", path]);
      }
      if (truncatedBy !== null) break;
      movedFileCount += conflictPaths.length;
      rebase = runRebase([...rebaseArgs, "--continue"]);
    }
    return {
      targetTag: target.tag,
      conflictingForkCommitCount: conflictingCommits.size,
      conflictingFileCount,
      truncated: truncatedBy !== null,
      truncatedBy,
      stopLimit: limits.stopLimit,
      timeLimitSeconds: limits.timeLimitMs / 1000,
    };
  } finally {
    worktreeGit?.runResult(["rebase", "--abort"]);
    rootGit.runResult(["worktree", "remove", "--force", worktree]);
    rootGit.runResult(["worktree", "prune"]);
    NodeFS.rmSync(worktree, { recursive: true, force: true });
    NodeFS.rmSync(cemetery, { recursive: true, force: true });
  }
};

const censusUnavailableReason = (root: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message
    .replaceAll(root, "<repository>")
    .replace(/\/(?:private\/)?tmp\/fork-rebase-census-[^\s/:]+(?:-files)?/g, "<temporary-worktree>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return normalized || "unknown census failure";
};

const blockedReport = (
  plan: Pick<AutoRebasePlan, "target" | "newestTagBeyondWindow" | "feasibility">,
  census: RebaseStopCensus | null,
  censusUnavailable: string | null,
): BlockedIssue | null => {
  if (plan.feasibility.ffBoundary.firstConflict === null) return null;
  if (census?.conflictingForkCommitCount === 0) return null;
  return buildBlockedIssue(plan, census, censusUnavailable);
};

const decideByCensus = (
  root: string,
  plan: AutoRebasePlan,
  census: StopCensusRunner,
): Pick<AutoRebaseResult["decision"], "census" | "censusUnavailableReason"> => {
  if (plan.feasibility.ffBoundary.firstConflict === null || plan.censusTarget === null) {
    return { census: null, censusUnavailableReason: null };
  }
  if (plan.censusTarget.sha === plan.baseSha) {
    return {
      census: {
        targetTag: plan.censusTarget.tag,
        conflictingForkCommitCount: 0,
        conflictingFileCount: 0,
        truncated: false,
        truncatedBy: null,
        stopLimit: STOP_CENSUS_LIMIT,
        timeLimitSeconds: STOP_CENSUS_TIME_LIMIT_MS / 1000,
      },
      censusUnavailableReason: null,
    };
  }
  try {
    const result = census(root, plan.oldSha, plan.baseSha, plan.censusTarget);
    if (result.truncated) {
      return {
        census: null,
        censusUnavailableReason: `sequential census did not complete before its ${result.truncatedBy ?? "unknown"} limit`,
      };
    }
    return { census: result, censusUnavailableReason: null };
  } catch (error) {
    return { census: null, censusUnavailableReason: censusUnavailableReason(root, error) };
  }
};

const postAdvanceBlockedPlan = (
  git: FeasibilityGit,
  plan: AutoRebasePlan,
  newSha: string,
): Pick<AutoRebasePlan, "target" | "newestTagBeyondWindow" | "feasibility"> => {
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
  readonly rehearseStopCensus?: StopCensusRunner;
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
  const censusRunner = hooks.rehearseStopCensus ?? rehearseStopCensus;
  const pairwiseFirstConflict = plan.feasibility.ffBoundary.firstConflict;
  const { census, censusUnavailableReason } = decideByCensus(root, plan, censusRunner);
  const censusConflictCount = census?.conflictingForkCommitCount ?? null;
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
    const branch = `release/${stable.tag}-hyprws`;
    if (trackingBranchExists(git, branch)) continue;
    const stack =
      stable.position === 0
        ? null
        : createRebasedStack(root, plan.oldSha, plan.baseSha, stable.sha, verify);
    if (stack !== null) dependencySetups.add(stack.dependencySetup);
    const marker = `<!-- hyprws-stable-candidate: ${stable.tag}-hyprws -->`;
    stableCandidates.push({
      tag: stable.tag,
      branch,
      sha: stack?.sha ?? plan.oldSha,
      title: `Stable candidate ${stable.tag}-hyprws`,
      marker,
      label: "release",
      body: stableCandidateBody(
        stable.tag,
        branch,
        // The trunk has already adopted the position-zero stack.
        stable.position === 0 ? "on" : options.mode,
      ),
    });
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
    const plan = buildAutoRebasePlan(git, oldSha, options.target);
    const result = executeAutoRebase(root, options, plan);
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
