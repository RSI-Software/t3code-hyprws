// @effect-diagnostics nodeBuiltinImport:off - Automatic rebase planning runs before Effect.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { UsageError } from "./lib/fork-cli.ts";
import { runCommand, SystemGit } from "./lib/fork-command.ts";
import {
  buildFeasibility,
  type FeasibilityGit,
  type ForkRebaseFeasibility,
  type GitCommandResult,
} from "./lib/fork-rebase-feasibility.ts";
import {
  parseUpstreamReleaseTag,
  positionUpstreamReleaseTags,
  selectNewestReleaseTag,
  type PositionedReleaseTag,
} from "./lib/fork-policy.ts";
import { linkInstalledModules } from "./lib/fork-rebase-worktree.ts";

export type PositionedTag = PositionedReleaseTag;

export interface AutoRebasePlan {
  readonly oldSha: string;
  readonly upstreamSha: string;
  readonly baseSha: string;
  readonly horizon: PositionedTag | null;
  readonly censusTarget: PositionedTag | null;
  readonly target: PositionedTag | null;
  readonly stableTags: ReadonlyArray<PositionedTag>;
  readonly newestTagBeyondWindow: PositionedTag | null;
  readonly feasibility: ForkRebaseFeasibility;
}

export type VerificationDependencySetup = "shared-install" | "fresh-install";

export const commandResult = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): GitCommandResult => {
  return runCommand(command, args, { cwd, env });
};

export const requireSuccess = (operation: string, result: GitCommandResult): string => {
  if (result.status === 0 && result.error === undefined) return result.stdout;
  const detail = result.error?.message ?? (result.stderr.trim() || result.stdout.trim());
  throw new Error(`${operation} failed${detail.length === 0 ? "" : `: ${detail}`}`);
};

export const lines = (value: string): ReadonlyArray<string> =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export const selectNewestTag = selectNewestReleaseTag;

const originHasStableRelease = (git: Pick<FeasibilityGit, "run">, tag: string): boolean =>
  git
    .run(["ls-remote", "origin", `refs/heads/release/${tag}-hyprws`, `refs/tags/${tag}-hyprws.*`])
    .trim().length > 0;

export const buildAutoRebasePlan = (
  git: FeasibilityGit,
  oldSha: string,
  targetOverride: string | null,
): AutoRebasePlan => {
  const upstreamSha = git.run(["rev-parse", "upstream/main^{commit}"]).trim();
  const baseSha = git.run(["merge-base", oldSha, upstreamSha]).trim();
  const upstreamCommits = lines(
    git.run(["rev-list", "--first-parent", "--reverse", `${baseSha}..${upstreamSha}`]),
  );
  const positions = new Map<string, number>([[baseSha, 0]]);
  upstreamCommits.forEach((sha, index) => positions.set(sha, index + 1));
  const tags = positionUpstreamReleaseTags(git, [baseSha, ...upstreamCommits]);
  const horizon = selectNewestTag(tags);
  const feasibility = buildFeasibility(git, oldSha, horizon?.sha ?? baseSha, baseSha);
  let censusTarget = horizon;
  if (targetOverride !== null) {
    if (parseUpstreamReleaseTag(targetOverride) === null) {
      throw new UsageError(`--target must be an upstream release tag: ${targetOverride}`);
    }
    const sha = git.run(["rev-parse", `${targetOverride}^{commit}`]).trim();
    const position = positions.get(sha);
    if (position === undefined || position > feasibility.ffBoundary.cleanCommitCount) {
      throw new UsageError(
        `--target must be inside the clean upstream first-parent window: ${targetOverride}`,
      );
    }
    censusTarget = {
      tag: targetOverride,
      sha,
      position,
      stable: parseUpstreamReleaseTag(targetOverride)?.channel === "stable",
    };
  }
  const targetPosition = censusTarget?.position ?? 0;
  const target = selectNewestTag(
    tags.filter(
      (tag) =>
        tag.position <= targetPosition && tag.position <= feasibility.ffBoundary.cleanCommitCount,
    ),
  );
  return {
    oldSha,
    upstreamSha,
    baseSha,
    horizon,
    censusTarget,
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
    // %B, not %s plus parsed trailers: a rebase that rewrites a message can drop body lines
    // (git strips comment-char lines when it cleans one up) without touching subject or trailers.
    "--format=%B%x1e",
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
  if (originalLog !== replayedLog) throw new Error("replay commit messages changed");
};

const verificationEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.HYPRWS_PUSH_TOKEN;
  return env;
};

export const selectVerificationDependencySetup = (
  git: Pick<FeasibilityGit, "runResult">,
  baseSha: string,
  targetSha: string,
): VerificationDependencySetup => {
  const dependencyDiff = git.runResult([
    "diff",
    "--quiet",
    baseSha,
    targetSha,
    "--",
    "pnpm-lock.yaml",
    "package.json",
    ":(glob)**/package.json",
  ]);
  if (dependencyDiff.status !== 0 && dependencyDiff.status !== 1) {
    requireSuccess("inspect dependency manifest changes", dependencyDiff);
  }
  return dependencyDiff.status === 1 ? "fresh-install" : "shared-install";
};

export const verifyReplay = (
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

  const dependencySetup = selectVerificationDependencySetup(original, baseSha, targetSha);
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
    ["vp", ["run", "test"]],
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
