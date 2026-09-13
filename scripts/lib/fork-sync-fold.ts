// @effect-diagnostics nodeBuiltinImport:off - Fold execution runs real git in a lane worktree.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { SystemGit } from "./fork-command.ts";
import { normalizeReplayMessages } from "./fork-replay-messages.ts";

/** The lane a fold replays in: everything the fold touches is inside one existing worktree. */
export interface FoldLane {
  readonly worktree: string;
}

export type TrunkMovement =
  | { readonly kind: "unchanged" }
  | { readonly kind: "linear"; readonly commits: ReadonlyArray<string> }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * Classifies freshly fetched trunk movement against the state a fold already holds.
 *
 * `frontier` is the trunk tip the candidate already incorporates (the push lease `B`), `live` is
 * the freshly observed tip `N`, `sharedBase` is the source's immutable upstream base, and `target`
 * is the pinned target SHA the walk replayed from. Movement folds only when it is a linear
 * landing sequence that keeps the same shared base and the same pinned target; everything else
 * refuses and the caller orphans the lane as evidence.
 */
export const classifyTrunkMovement = (
  root: string,
  frontier: string,
  live: string,
  sharedBase: string,
  target: string,
): TrunkMovement => {
  const git = new SystemGit(root);
  if (frontier === live) return { kind: "unchanged" };
  const resolvedTarget = git.runResult(["rev-parse", `${target}^{commit}`]);
  if (resolvedTarget.status !== 0 || resolvedTarget.stdout.trim() !== target)
    return { kind: "refuse", reason: `target moved: ${target} no longer resolves to a commit` };
  if (!isAncestor(git, frontier, live))
    return {
      kind: "refuse",
      reason: `trunk moved off the incorporated frontier: ${frontier} is not an ancestor of ${live}`,
    };
  if (hasMerge(git, frontier, live))
    return { kind: "refuse", reason: `trunk movement ${frontier}..${live} introduces a merge` };
  const liveBase = git.run(["merge-base", live, target]).trim();
  if (liveBase !== sharedBase)
    return {
      kind: "refuse",
      reason: `shared base moved: merge-base(${live}, ${target}) is ${liveBase}, not ${sharedBase}`,
    };
  return { kind: "linear", commits: revList(git, `${frontier}..${live}`) };
};

const isAncestor = (git: SystemGit, ancestor: string, descendant: string): boolean => {
  const result = git.runResult(["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.status === 0;
};

const revList = (git: SystemGit, range: string): ReadonlyArray<string> =>
  git
    .run(["rev-list", "--reverse", range])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const commitCount = (git: SystemGit, range: string): number =>
  Number(git.run(["rev-list", "--count", range]).trim());

const hasMerge = (git: SystemGit, from: string, to: string): boolean =>
  git.run(["rev-list", "--min-parents=2", `${from}..${to}`]).trim().length > 0;

export type FoldSegment = {
  readonly from: string;
  readonly to: string;
  readonly onto: string;
};

export type FoldReplay =
  | { readonly head: string }
  | { readonly conflict: { readonly commit: string; readonly paths: ReadonlyArray<string> } };

const isRebaseInProgress = (worktree: string): boolean => {
  const gitDir = new SystemGit(worktree).run(["rev-parse", "--git-dir"]).trim();
  if (gitDir === "") return true;
  const root = NodePath.isAbsolute(gitDir) ? gitDir : NodePath.join(worktree, gitDir);
  return ["rebase-merge", "rebase-apply"].some((state) =>
    NodeFS.existsSync(NodePath.join(root, state)),
  );
};

/**
 * Replays one landed trunk segment `from..to` onto the candidate with fixed SHAs, using the same
 * comment-safe and rerere configuration the auto rebase plan rehearses with.
 *
 * The rebase runs as `git rebase --onto <onto> <from> <to>` where `<to>` is a SHA, so git detaches
 * HEAD and never moves the lane branch; the caller owns moving the lane ref. Returns the detached
 * head SHA on success. On a conflict the rebase is left in progress — the existing resume path
 * (`git rebase --continue` with the comment-safe config) finishes it — and the conflicting commit
 * plus unmerged paths are returned.
 */
export const replaySegment = (lane: FoldLane, segment: FoldSegment): FoldReplay => {
  const { worktree } = lane;
  const git = new SystemGit(worktree);
  const args = [
    "-c",
    "core.commentChar=auto",
    "-c",
    "diff.algorithm=histogram",
    "-c",
    "rerere.enabled=true",
    "-c",
    "rerere.autoupdate=false",
    "rebase",
    "--onto",
    segment.onto,
    segment.from,
    segment.to,
  ];
  const rebase = git.runResult(args);
  if (rebase.status === 0 && rebase.error === undefined)
    return { head: git.run(["rev-parse", "HEAD"]).trim() };
  if (!isRebaseInProgress(worktree)) {
    const detail = rebase.error?.message ?? (rebase.stderr.trim() || rebase.stdout.trim());
    throw new Error(`fold rebase failed without entering a resumable state: ${detail}`);
  }
  const commit = git.run(["rev-parse", "REBASE_HEAD"]).trim();
  const paths = git
    .run(["diff", "--name-only", "--diff-filter=U"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { conflict: { commit, paths } };
};

/**
 * Proves a replayed segment: the commit count and the normalized full messages of the landed
 * range `from..to` must equal those of the replayed range `onto..head`, compared through the
 * same whitespace normalization `git rebase` itself applies. Throws on any mismatch.
 */
export const proveSegment = (
  lane: FoldLane,
  segment: FoldSegment & { readonly head: string },
): void => {
  const { worktree } = lane;
  const git = new SystemGit(worktree);
  const originalCount = commitCount(git, `${segment.from}..${segment.to}`);
  const replayedCount = commitCount(git, `${segment.onto}..${segment.head}`);
  if (originalCount !== replayedCount)
    throw new Error(`fold commit count changed: ${originalCount} -> ${replayedCount}`);
  const messages = (range: string): string =>
    git.run(["log", "--reverse", "--topo-order", "--format=%B%x1e", range]);
  if (
    normalizeReplayMessages(messages(`${segment.from}..${segment.to}`)) !==
    normalizeReplayMessages(messages(`${segment.onto}..${segment.head}`))
  )
    throw new Error("fold commit messages changed");
};
