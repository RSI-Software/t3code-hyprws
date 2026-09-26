import {
  FolderCogIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  type LucideIcon,
} from "lucide-react";

import type { EnvironmentId, ThreadId, VcsRef } from "@t3tools/contracts";

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

/**
 * Fork: the metadata rebind for a branch picked while the thread's worktree is
 * gone, or `null` when the worktree is usable and upstream's selection runs.
 * Such a pick only rebinds: a checkout move would resolve the dead worktree and
 * fail, and switching the project checkout first would leave it mutated.
 */
export function resolveUnusableWorktreeRebindFork(input: {
  hasServerThread: boolean;
  activeProjectCwd: string;
  threadWorktreePath: string | null;
  usableActiveWorktreePath: string | null;
  refName: Pick<VcsRef, "name" | "isRemote" | "worktreePath">;
}): { branch: string; worktreePath: string | null } | null {
  const { activeProjectCwd, threadWorktreePath, usableActiveWorktreePath, refName } = input;
  if (!input.hasServerThread || threadWorktreePath === null || usableActiveWorktreePath !== null) {
    return null;
  }
  const worktreePath =
    refName.worktreePath && refName.worktreePath !== activeProjectCwd ? refName.worktreePath : null;
  return {
    branch: refName.isRemote ? deriveLocalBranchNameFromRemoteRef(refName.name) : refName.name,
    worktreePath,
  };
}

/** Fork: applies a `resolveUnusableWorktreeRebindFork` result as a plain metadata rebind. */
export function applyUnusableWorktreeRebindFork(
  rebind: { branch: string; worktreePath: string | null },
  deps: {
    environmentId: EnvironmentId;
    threadId: ThreadId | null | undefined;
    hasSession: boolean;
    stopThreadSession: (command: {
      environmentId: EnvironmentId;
      input: { threadId: ThreadId };
    }) => unknown;
    updateThreadMetadata: (command: {
      environmentId: EnvironmentId;
      input: { threadId: ThreadId; branch: string; worktreePath: string | null };
    }) => unknown;
    onBranchOverride?: ((refName: string | null) => void) | undefined;
    onDone: () => void;
  },
): void {
  const { environmentId, threadId } = deps;
  if (threadId) {
    if (deps.hasSession) void deps.stopThreadSession({ environmentId, input: { threadId } });
    void deps.updateThreadMetadata({ environmentId, input: { threadId, ...rebind } });
    deps.onBranchOverride?.(rebind.branch);
  }
  deps.onDone();
}
