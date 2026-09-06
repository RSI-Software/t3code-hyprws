// @effect-diagnostics nodeBuiltinImport:off - Snapshot creation runs in the standalone fork bot and its lanes.

/**
 * One definition of a crossed stable upstream tag, shared by the nightly bot and
 * the unblock apply lane.
 *
 * The invariant: a stable upstream tag is snapshotted and announced by whichever
 * lane moves the fork base past it. The bot only ever sees the tags inside its own
 * walk window, so a tag the fork base crosses through an agent or human apply is
 * invisible to it forever after (RSI-Software/t3code-hyprws#499).
 */

import { createRebasedStack, verifyReplayShape } from "./fork-auto-rebase-plan.ts";
import { SystemGit } from "./lib/fork-command.ts";
import {
  originHasStableRelease,
  positionUpstreamReleaseTags,
  stableSnapshotBranch,
  type PositionedReleaseTag,
  type TagPolicyGit,
} from "./lib/fork-policy.ts";
import { pushResult, remoteBranchExists } from "./lib/fork-rebase-push.ts";
import {
  stableCandidateBody,
  type RebaseMode,
  type StableCandidate,
  type StableCandidateLane,
} from "./lib/fork-rebase-issues.ts";

export interface CrossingGit extends TagPolicyGit {
  run(args: ReadonlyArray<string>): string;
}

const lines = (value: string): ReadonlyArray<string> =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Stable upstream tags on the first-parent walk out of `oldBaseSha` up to and
 * including `newBaseSha`, minus the ones `origin` already has. Oldest first.
 *
 * `oldBaseSha` itself is position zero and never crossed: the lane that landed the
 * fork on it already owed it a snapshot.
 */
export const crossedStableTags = (
  git: CrossingGit,
  oldBaseSha: string,
  newBaseSha: string,
): ReadonlyArray<PositionedReleaseTag> => {
  if (oldBaseSha === newBaseSha) return [];
  const walk = [
    oldBaseSha,
    ...lines(git.run(["rev-list", "--first-parent", "--reverse", `${oldBaseSha}..${newBaseSha}`])),
  ];
  return positionUpstreamReleaseTags(git, walk)
    .filter((tag) => tag.stable && tag.position > 0 && !originHasStableRelease(git, tag.tag))
    .toSorted((left, right) => left.position - right.position || left.tag.localeCompare(right.tag));
};

/** The candidate record a lane announces for one stable upstream tag it snapshotted. */
export const stableCrossingCandidate = (
  tag: string,
  sha: string,
  mode: RebaseMode,
  lane: StableCandidateLane = "bot",
): StableCandidate => {
  const branch = stableSnapshotBranch(tag);
  return {
    tag,
    branch,
    sha,
    title: `Stable candidate ${tag}-hyprws`,
    marker: `<!-- hyprws-stable-candidate: ${tag}-hyprws -->`,
    label: "release",
    body: stableCandidateBody(tag, branch, mode, lane),
  };
};

/**
 * Push the create-only snapshot branches. A snapshot is immutable once `origin` has
 * it: `skipExisting` drops an already-published candidate from the batch, and
 * without it a collision is a hard stop rather than a silent replacement.
 */
export const createStableSnapshots = (
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
    const push = pushResult(root, ["origin", `${candidate.sha}:refs/heads/${candidate.branch}`]);
    if (push.status !== 0 || push.error !== undefined) {
      const detail = push.error?.message ?? (push.stderr.trim() || push.stdout.trim());
      throw new Error(
        `create origin/${candidate.branch} failed${detail.length === 0 ? "" : `: ${detail}`}`,
      );
    }
    return candidate.branch;
  });
};

export interface StableCrossingRequest {
  /** A repository or linked worktree that can reach the fork stack and the upstream tags. */
  readonly root: string;
  /** The fork head as it stood before the apply. */
  readonly oldSha: string;
  /** The upstream base that head sat on. */
  readonly oldBaseSha: string;
  /** The upstream base the apply lands the fork on. */
  readonly newBaseSha: string;
  readonly warn: (message: string) => void;
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Snapshot and describe every stable upstream tag this apply crosses.
 *
 * Each snapshot is the pre-apply stack forward-rebased onto the stable tag, which is
 * exactly what the bot publishes. The replay is checked for shape only: the cut route
 * in `fork-sync-stable.ts` re-runs the full verification on the snapshot before it
 * mints a tag, so paying for that twice would only slow the apply down.
 *
 * Nothing here throws. The apply this follows has already been rehearsed, checked, and
 * proved, so a stale remote read or a conflict against an older upstream tag is
 * reported and skipped rather than allowed to void it. Every candidate returned is on
 * `origin`, and every tag left without one is named in a warning.
 */
export const snapshotCrossedStableTags = (
  request: StableCrossingRequest,
): ReadonlyArray<StableCandidate> => {
  let crossed: ReadonlyArray<PositionedReleaseTag>;
  try {
    crossed = crossedStableTags(
      new SystemGit(request.root),
      request.oldBaseSha,
      request.newBaseSha,
    );
  } catch (error) {
    request.warn(
      `crossed stable upstream tags not enumerated: ${detailOf(error)}\n` +
        `Check ${request.oldBaseSha}..${request.newBaseSha} for an unsnapshotted stable tag by hand.`,
    );
    return [];
  }

  const candidates: Array<StableCandidate> = [];
  for (const stable of crossed) {
    try {
      const stack = createRebasedStack(
        request.root,
        request.oldSha,
        request.oldBaseSha,
        stable.sha,
        verifyReplayShape,
      );
      const candidate = stableCrossingCandidate(stable.tag, stack.sha, "on", "unblock-apply");
      // One push per tag, so a tag that cannot be snapshotted costs only itself.
      if (createStableSnapshots(request.root, [candidate], true).length === 0) continue;
      candidates.push(candidate);
    } catch (error) {
      request.warn(
        `stable snapshot ${stableSnapshotBranch(stable.tag)} not created: ${detailOf(error)}\n` +
          `Snapshot it by hand before cutting ${stable.tag}-hyprws.`,
      );
    }
  }
  return candidates;
};
