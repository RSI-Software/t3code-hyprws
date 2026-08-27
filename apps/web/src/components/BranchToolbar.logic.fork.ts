import {
  FolderCogIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  type LucideIcon,
} from "lucide-react";

import type { EnvMode } from "./BranchToolbar.logic";

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
