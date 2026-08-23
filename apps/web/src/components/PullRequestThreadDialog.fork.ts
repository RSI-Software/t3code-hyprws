import type { GitPreparePullRequestThreadResult } from "@t3tools/contracts";

import { toastManager } from "./ui/toast";

/**
 * Fork: a pull request worktree whose managed zmux session failed to bind still
 * opens, so the server returns the failure beside the result. V2 keeps no thread
 * activity log to hold it, so the dialog that created the worktree says so.
 */
export function toastZmuxSessionNoticeFork(result: GitPreparePullRequestThreadResult): void {
  const notice = result.zmuxSessionNotice;
  if (notice === undefined) return;
  toastManager.add({ type: "warning", title: notice.summary, description: notice.detail });
}
