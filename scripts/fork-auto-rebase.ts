#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone Git bot runs before an Effect runtime exists.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerformance from "node:perf_hooks";

import {
  buildFeasibility,
  type FeasibilityGit,
  type ForkRebaseFeasibility,
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
import { linkInstalledModules } from "./lib/fork-rebase-worktree.ts";

const UPSTREAM_TAG = /^v\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

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

export interface PositionedTag {
  readonly tag: string;
  readonly sha: string;
  readonly position: number;
  readonly stable: boolean;
}

export interface AutoRebasePlan {
  readonly oldSha: string;
  readonly upstreamSha: string;
  readonly baseSha: string;
  readonly target: PositionedTag | null;
  readonly stableTags: ReadonlyArray<PositionedTag>;
  readonly newestTagBeyondWindow: PositionedTag | null;
  readonly feasibility: ForkRebaseFeasibility;
}

export type VerificationDependencySetup = "shared-install" | "fresh-install";

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
  readonly blocked: BlockedIssue | null;
}

export class UsageError extends Error {}

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

export const parseArgs = (argv: ReadonlyArray<string>): AutoRebaseOptions => {
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

export class SystemGit implements FeasibilityGit {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  run(args: ReadonlyArray<string>): string {
    return NodeChildProcess.execFileSync("git", [...args], {
      cwd: this.cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  runResult(args: ReadonlyArray<string>, timeout?: number): GitCommandResult {
    const result = NodeChildProcess.spawnSync("git", [...args], {
      cwd: this.cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...(timeout === undefined ? {} : { timeout }),
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }
}

const commandResult = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): GitCommandResult => {
  const result = NodeChildProcess.spawnSync(command, [...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

const requireSuccess = (operation: string, result: GitCommandResult): string => {
  if (result.status === 0 && result.error === undefined) return result.stdout;
  const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
  throw new Error(`${operation} failed${detail.length === 0 ? "" : `: ${detail}`}`);
};

const lines = (value: string): ReadonlyArray<string> =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export const selectNewestTag = (tags: ReadonlyArray<PositionedTag>): PositionedTag | null =>
  tags.toSorted((left, right) => {
    if (left.position !== right.position) return right.position - left.position;
    if (left.stable !== right.stable) return left.stable ? -1 : 1;
    return right.tag.localeCompare(left.tag, undefined, { numeric: true });
  })[0] ?? null;

const originHasStableRelease = (git: Pick<FeasibilityGit, "run">, tag: string): boolean =>
  git
    .run(["ls-remote", "origin", `refs/heads/release/${tag}-hyprws`, `refs/tags/${tag}-hyprws.*`])
    .trim().length > 0;

const readPositionedTags = (
  git: Pick<FeasibilityGit, "run">,
  positions: ReadonlyMap<string, number>,
): ReadonlyArray<PositionedTag> =>
  lines(
    git.run([
      "for-each-ref",
      "--format=%(refname:strip=2)%09%(objectname)%09%(*objectname)",
      "refs/tags/v*",
    ]),
  ).flatMap((record) => {
    const [tag = "", objectSha = "", peeledSha = ""] = record.split("\t");
    if (!UPSTREAM_TAG.test(tag)) return [];
    const sha = peeledSha || objectSha;
    const position = positions.get(sha);
    return position === undefined ? [] : [{ tag, sha, position, stable: STABLE_TAG.test(tag) }];
  });

export const buildAutoRebasePlan = (
  git: FeasibilityGit,
  oldSha: string,
  targetOverride: string | null,
): AutoRebasePlan => {
  const upstreamSha = git.run(["rev-parse", "upstream/main^{commit}"]).trim();
  const baseSha = git.run(["merge-base", oldSha, upstreamSha]).trim();
  const feasibility = buildFeasibility(git, oldSha, upstreamSha, baseSha);
  const upstreamCommits = lines(
    git.run(["rev-list", "--first-parent", "--reverse", `${baseSha}..${upstreamSha}`]),
  );
  const positions = new Map<string, number>([[baseSha, 0]]);
  upstreamCommits.forEach((sha, index) => positions.set(sha, index + 1));
  const tags = readPositionedTags(git, positions);
  const cleanTags = tags.filter((tag) => tag.position <= feasibility.ffBoundary.cleanCommitCount);
  let target = selectNewestTag(cleanTags);
  if (targetOverride !== null) {
    if (!UPSTREAM_TAG.test(targetOverride)) {
      throw new UsageError(`--target must be an upstream release tag: ${targetOverride}`);
    }
    const sha = git.run(["rev-parse", `${targetOverride}^{commit}`]).trim();
    const position = positions.get(sha);
    if (position === undefined || position > feasibility.ffBoundary.cleanCommitCount) {
      throw new UsageError(
        `--target must be inside the clean upstream first-parent window: ${targetOverride}`,
      );
    }
    target = {
      tag: targetOverride,
      sha,
      position,
      stable: STABLE_TAG.test(targetOverride),
    };
  }
  const targetPosition = target?.position ?? 0;
  return {
    oldSha,
    upstreamSha,
    baseSha,
    target,
    stableTags: tags
      .filter(
        (tag) =>
          tag.stable && tag.position <= targetPosition && !originHasStableRelease(git, tag.tag),
      )
      .toSorted(
        (left, right) => left.position - right.position || left.tag.localeCompare(right.tag),
      ),
    newestTagBeyondWindow: selectNewestTag(
      tags.filter((tag) => tag.position > feasibility.ffBoundary.cleanCommitCount),
    ),
    feasibility,
  };
};

const forkReplay = (git: SystemGit, base: string, head: string): string =>
  git.run([
    "log",
    "--reverse",
    "--topo-order",
    "--format=%s%n%(trailers:only,unfold=true)%x1e",
    `${base}..${head}`,
  ]);

export const verifyReplayMetadata = (
  originalCount: number,
  replayedCount: number,
  originalLog: string,
  replayedLog: string,
): void => {
  if (originalCount !== replayedCount) {
    throw new Error(`replay commit count changed: ${originalCount} -> ${replayedCount}`);
  }
  if (originalLog !== replayedLog) throw new Error("replay subjects or trailers changed");
};

const verificationEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.HYPRWS_PUSH_TOKEN;
  return env;
};

const verifyReplay = (
  root: string,
  worktree: string,
  oldSha: string,
  baseSha: string,
  targetSha: string,
  newSha: string,
): VerificationDependencySetup => {
  const original = new SystemGit(root);
  const rebased = new SystemGit(worktree);
  const originalCount = Number(
    original.run(["rev-list", "--count", `${baseSha}..${oldSha}`]).trim(),
  );
  const replayedCount = Number(
    rebased.run(["rev-list", "--count", `${targetSha}..${newSha}`]).trim(),
  );
  verifyReplayMetadata(
    originalCount,
    replayedCount,
    forkReplay(original, baseSha, oldSha),
    forkReplay(rebased, targetSha, newSha),
  );

  const dependencyDiff = original.runResult([
    "diff",
    "--quiet",
    oldSha,
    targetSha,
    "--",
    "pnpm-lock.yaml",
    "package.json",
    ":(glob)**/package.json",
  ]);
  if (dependencyDiff.status !== 0 && dependencyDiff.status !== 1) {
    requireSuccess("inspect dependency manifest changes", dependencyDiff);
  }
  const dependencySetup: VerificationDependencySetup =
    dependencyDiff.status === 1 ? "fresh-install" : "shared-install";
  const env = verificationEnvironment();
  if (dependencySetup === "fresh-install") {
    requireSuccess("vp i", commandResult("vp", ["i"], worktree, env));
  } else {
    linkInstalledModules(root, worktree);
  }
  for (const [command, args] of [
    ["vp", ["run", "fork:delta", "--check"]],
    ["vp", ["check"]],
    ["vp", ["run", "typecheck"]],
  ] as const) {
    requireSuccess(`${command} ${args.join(" ")}`, commandResult(command, args, worktree, env));
  }
  return dependencySetup;
};

export type ReplayVerifier = (
  root: string,
  worktree: string,
  oldSha: string,
  baseSha: string,
  targetSha: string,
  newSha: string,
) => VerificationDependencySetup;

interface RebasedStack {
  readonly sha: string;
  readonly dependencySetup: VerificationDependencySetup;
}

export const createRebasedStack = (
  root: string,
  oldSha: string,
  baseSha: string,
  targetSha: string,
  verify: ReplayVerifier = verifyReplay,
): RebasedStack => {
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-auto-rebase-"));
  const rootGit = new SystemGit(root);
  try {
    rootGit.run(["worktree", "add", "--detach", worktree, oldSha]);
    const worktreeGit = new SystemGit(worktree);
    const rebase = worktreeGit.runResult([
      "-c",
      "rerere.enabled=false",
      "-c",
      "rerere.autoupdate=false",
      "rebase",
      "--onto",
      targetSha,
      baseSha,
      oldSha,
    ]);
    if (rebase.status !== 0 || rebase.error !== undefined) {
      worktreeGit.runResult(["rebase", "--abort"]);
      requireSuccess(`git rebase --onto ${targetSha} ${baseSha} ${oldSha}`, rebase);
    }
    const newSha = worktreeGit.run(["rev-parse", "HEAD"]).trim();
    return {
      sha: newSha,
      dependencySetup: verify(root, worktree, oldSha, baseSha, targetSha, newSha),
    };
  } finally {
    rootGit.runResult(["worktree", "remove", "--force", worktree]);
    rootGit.runResult(["worktree", "prune"]);
    NodeFS.rmSync(worktree, { recursive: true, force: true });
  }
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
  now: () => NodePerformance.performance.now(),
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
  root: string,
  plan: Pick<AutoRebasePlan, "target" | "newestTagBeyondWindow" | "feasibility">,
  headSha: string,
  baseSha: string,
  census: StopCensusRunner,
): BlockedIssue | null => {
  if (plan.feasibility.ffBoundary.firstConflict === null) return null;
  if (plan.newestTagBeyondWindow === null) return buildBlockedIssue(plan);
  try {
    return buildBlockedIssue(plan, census(root, headSha, baseSha, plan.newestTagBeyondWindow));
  } catch (error) {
    return buildBlockedIssue(plan, null, censusUnavailableReason(root, error));
  }
};

const postAdvanceBlockedPlan = (
  git: FeasibilityGit,
  plan: AutoRebasePlan,
  newSha: string,
): Pick<AutoRebasePlan, "target" | "newestTagBeyondWindow" | "feasibility"> => {
  if (plan.target === null) throw new Error("cannot refresh a blocked plan without a target");
  const baseSha = plan.target.sha;
  const feasibility = buildFeasibility(git, newSha, plan.upstreamSha, baseSha);
  const upstreamCommits = lines(
    git.run(["rev-list", "--first-parent", "--reverse", `${baseSha}..${plan.upstreamSha}`]),
  );
  const positions = new Map<string, number>([[baseSha, 0]]);
  upstreamCommits.forEach((sha, index) => positions.set(sha, index + 1));
  return {
    target: plan.target,
    newestTagBeyondWindow: selectNewestTag(
      readPositionedTags(git, positions).filter(
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
  const census = hooks.rehearseStopCensus ?? rehearseStopCensus;
  if (options.mode === "off") {
    const blocked = blockedReport(root, plan, plan.oldSha, plan.baseSha, census);
    return {
      schemaVersion: 1,
      mode: options.mode,
      dryRun: options.dryRun,
      status: "off",
      oldSha: plan.oldSha,
      baseSha: plan.baseSha,
      target: plan.target === null ? null : { tag: plan.target.tag, sha: plan.target.sha },
      newSha: null,
      stableCandidates,
      verificationDependencySetup: [],
      blocked,
    };
  }
  for (const stable of plan.stableTags) {
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

  if (plan.target === null || plan.target.sha === plan.baseSha) {
    const blocked = blockedReport(root, plan, plan.oldSha, plan.baseSha, census);
    if (!options.dryRun) createStableSnapshots(root, stableCandidates, true);
    return {
      schemaVersion: 1,
      mode: options.mode,
      dryRun: options.dryRun,
      status: "no-op",
      oldSha: plan.oldSha,
      baseSha: plan.baseSha,
      target: plan.target === null ? null : { tag: plan.target.tag, sha: plan.target.sha },
      newSha: null,
      stableCandidates,
      verificationDependencySetup: [],
      blocked,
    };
  }

  // Verify every replay before the first mutation. A feasibility mismatch or
  // failed check therefore leaves all remote refs untouched.
  const targetStack = createRebasedStack(root, plan.oldSha, plan.baseSha, plan.target.sha, verify);
  dependencySetups.add(targetStack.dependencySetup);
  const newSha = targetStack.sha;
  const refreshedPlan = postAdvanceBlockedPlan(git, plan, newSha);
  const blocked = blockedReport(root, refreshedPlan, newSha, plan.target.sha, census);
  if (!options.dryRun) {
    const previousBeforeRun =
      options.mode === "on" ? remoteBranchSha(root, "hyprws-previous") : null;
    if (options.mode === "on") {
      requireSuccess(
        "validate leased push hyprws",
        pushResult(root, [
          "--dry-run",
          "origin",
          `${newSha}:refs/heads/hyprws`,
          `--force-with-lease=refs/heads/hyprws:${plan.oldSha}`,
        ]),
      );
    }
    const pushedSnapshots = createStableSnapshots(root, stableCandidates);
    if (options.mode === "candidate") {
      requireSuccess(
        "push hyprws-next",
        pushResult(root, ["--force", "origin", `${newSha}:refs/heads/hyprws-next`]),
      );
    } else {
      requireSuccess(
        "push hyprws-previous",
        pushResult(root, ["--force", "origin", `${plan.oldSha}:refs/heads/hyprws-previous`]),
      );
      hooks.beforeHyprwsPush?.();
      const leasedPush = pushResult(root, [
        "origin",
        `${newSha}:refs/heads/hyprws`,
        `--force-with-lease=refs/heads/hyprws:${plan.oldSha}`,
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
    target: { tag: plan.target.tag, sha: plan.target.sha },
    newSha,
    stableCandidates,
    verificationDependencySetup: [...dependencySetups].toSorted(),
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
    const options = parseArgs(argv);
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

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
