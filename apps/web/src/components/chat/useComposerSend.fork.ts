import type { StoredThreadEnvMode as EnvModeFork } from "@t3tools/shared/threadEnvMode.fork";

export function worktrunkBootstrapFork(mode: EnvModeFork) {
  return mode === "worktrunk" ? { worktrunk: true } : {};
}

export function worktrunkDispatchFork(mode: EnvModeFork, preparingWorktree: boolean) {
  return { preparingWorktrunk: preparingWorktree && mode === "worktrunk" };
}

/** Upstream clears a reused draft path for worktree mode; Worktrunk must do the same. */
export function clearWorktrunkDraftPathFork(
  mode: EnvModeFork,
  worktreePath: string | null | undefined,
) {
  return mode === "worktrunk" && worktreePath ? { worktreePath: null } : {};
}
