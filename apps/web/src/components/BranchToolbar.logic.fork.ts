import {
  FolderCogIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  type LucideIcon,
} from "lucide-react";

import type { ThreadId, VcsRef } from "@t3tools/contracts";

import { deriveLocalBranchNameFromRemoteRef, type EnvMode } from "./BranchToolbar.logic";

/**
 * Fork: the label for the fork-only "worktrunk" mode, `null` for every
 * upstream mode so `resolveEnvModeLabel` can fall through to its own answers.
 */
export function resolveForkEnvModeLabel(mode: EnvMode): string | null {
  return mode === "worktrunk" ? "New worktrunk" : null;
}

/**
 * Fork: the workspace icon across local / worktree / worktrunk, including the
 * fork-only worktrunk shape that upstream's ternary has no arm for.
 */
export function resolveForkWorkspaceIcon(input: {
  activeWorktrunk: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
}): LucideIcon {
  if (input.activeWorktrunk || input.effectiveEnvMode === "worktrunk") {
    return FolderCogIcon;
  }
  if (input.effectiveEnvMode === "worktree") return FolderGit2Icon;
  return input.activeWorktreePath ? FolderGitIcon : FolderIcon;
}

/** Fork: how a branch picked on a removed worktree rebinds the thread. */
export interface UnusableWorktreeRebindFork {
  readonly branch: string;
  readonly worktreePath: string | null;
  /** The branch has no worktree yet: create one at the server's default path first. */
  readonly createWorktree: boolean;
}

/**
 * Fork: the rebind for a branch picked while the thread's worktree is gone, or
 * `null` when the worktree is usable and upstream's selection runs. Such a pick
 * never runs a checkout move (it would resolve the dead worktree and fail) and
 * never switches the project checkout: the branch's own worktree is reused,
 * the root's branch rebinds to the root, and any other branch gets a worktree.
 */
export function resolveUnusableWorktreeRebindFork(input: {
  hasServerThread: boolean;
  activeProjectCwd: string;
  threadWorktreePath: string | null;
  usableActiveWorktreePath: string | null;
  refName: Pick<VcsRef, "name" | "isRemote" | "worktreePath">;
}): UnusableWorktreeRebindFork | null {
  const { activeProjectCwd, threadWorktreePath, usableActiveWorktreePath, refName } = input;
  if (!input.hasServerThread || threadWorktreePath === null || usableActiveWorktreePath !== null) {
    return null;
  }
  // A remote-only ref rebinds by its local name; `git worktree add` then
  // creates that branch tracking the remote.
  const branch = refName.isRemote ? deriveLocalBranchNameFromRemoteRef(refName.name) : refName.name;
  if (!refName.worktreePath) return { branch, worktreePath: null, createWorktree: true };
  return {
    branch,
    worktreePath: refName.worktreePath === activeProjectCwd ? null : refName.worktreePath,
    createWorktree: false,
  };
}

/**
 * Fork: applies a `resolveUnusableWorktreeRebindFork` result as a metadata
 * rebind. `createWorktree` returns the created path, or `null` after it has
 * reported its own failure, which leaves the thread unchanged.
 */
export async function applyUnusableWorktreeRebindFork(
  rebind: UnusableWorktreeRebindFork,
  deps: {
    threadId: ThreadId;
    hasSession: boolean;
    createWorktree: (branch: string) => Promise<string | null>;
    stopThreadSession: (threadId: ThreadId) => unknown;
    updateThreadMetadata: (input: {
      threadId: ThreadId;
      branch: string;
      worktreePath: string | null;
    }) => unknown;
  },
): Promise<void> {
  const worktreePath = rebind.createWorktree
    ? await deps.createWorktree(rebind.branch)
    : rebind.worktreePath;
  if (rebind.createWorktree && worktreePath === null) return;
  if (deps.hasSession) void deps.stopThreadSession(deps.threadId);
  void deps.updateThreadMetadata({ threadId: deps.threadId, branch: rebind.branch, worktreePath });
}
