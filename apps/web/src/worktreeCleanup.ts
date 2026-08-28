import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import type { ThreadShell } from "./types";

export function getOrphanedWorktreePathForThread(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  threadId: ThreadShell["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = targetThread.worktreePath?.trim();
  if (!targetWorktreePath) {
    return null;
  }

  // Threads can store one worktree as `/repo/wt` and `/repo/wt/`, and
  // confirming deletion force-removes the checkout for every thread on it.
  const targetKey = normalizeProjectPathForComparison(targetWorktreePath);
  const isShared = threads.some(
    (thread) =>
      thread.id !== threadId &&
      thread.worktreePath !== null &&
      normalizeProjectPathForComparison(thread.worktreePath) === targetKey,
  );

  return isShared ? null : targetWorktreePath;
}

/**
 * Worktrees that nothing would point at once every thread in `threadIds` is
 * gone. A path only counts when every thread linked to it is inside the batch.
 */
export function getOrphanedWorktreePathsForThreads(
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "worktreePath">>,
  threadIds: ReadonlySet<ThreadShell["id"]>,
): ReadonlyArray<string> {
  const survivingPaths = new Set<string>();
  for (const thread of threads) {
    if (threadIds.has(thread.id)) continue;
    const path = normalizeWorktreePath(thread.worktreePath);
    if (path) survivingPaths.add(path);
  }

  const orphaned: string[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    if (!threadIds.has(thread.id)) continue;
    const path = normalizeWorktreePath(thread.worktreePath);
    if (!path || survivingPaths.has(path) || seen.has(path)) continue;
    seen.add(path);
    orphaned.push(path);
  }
  return orphaned;
}

/** The same path string can identify different worktrees in different environments. */
export function scopedWorktreePathKey(environmentId: string, worktreePath: string): string {
  return `${environmentId}:${worktreePath}`;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}
