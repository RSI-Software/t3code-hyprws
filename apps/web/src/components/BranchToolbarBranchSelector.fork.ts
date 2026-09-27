import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback } from "react";

import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import {
  applyUnusableWorktreeRebindFork,
  type UnusableWorktreeRebindFork,
} from "./BranchToolbar.logic.fork";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * Fork: the branch selector's rebind for a thread whose worktree is gone. The
 * returned callback creates a missing worktree at the server's default path,
 * then rebinds the thread's metadata; a failure toasts and changes nothing.
 */
export function useUnusableWorktreeRebindFork(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId | undefined;
  projectCwd: string | null;
  hasSession: boolean;
  onBranchOverride?: ((refName: string | null) => void) | undefined;
  onStart: () => void;
}) {
  const { environmentId, threadId, projectCwd, hasSession, onBranchOverride, onStart } = input;
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, "thread session stop");
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread metadata update",
  );
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });

  return useCallback(
    (
      rebind: UnusableWorktreeRebindFork,
      runBranchAction: (action: () => Promise<void>) => void,
    ) => {
      if (!threadId || !projectCwd) return;
      onStart();
      runBranchAction(() =>
        applyUnusableWorktreeRebindFork(rebind, {
          threadId,
          hasSession,
          createWorktree: async (branch) => {
            const result = await createWorktree({
              environmentId,
              input: { cwd: projectCwd, refName: branch, path: null },
            });
            if (result._tag === "Success") return result.value.worktree.path;
            if (!isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to create worktree.",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return null;
          },
          stopThreadSession: (id) => stopThreadSession({ environmentId, input: { threadId: id } }),
          updateThreadMetadata: (metadata) => {
            onBranchOverride?.(metadata.branch);
            return updateThreadMetadata({ environmentId, input: metadata });
          },
        }),
      );
    },
    [
      createWorktree,
      environmentId,
      hasSession,
      onBranchOverride,
      onStart,
      projectCwd,
      stopThreadSession,
      threadId,
      updateThreadMetadata,
    ],
  );
}
