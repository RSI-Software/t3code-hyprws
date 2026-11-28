import type { LocalDispatchSnapshot } from "../ChatView.logic";

export function updateWorktrunkDispatchFork(
  active: LocalDispatchSnapshot,
  update: Pick<
    LocalDispatchSnapshot,
    "preparingWorktree" | "preparingWorktrunk" | "submissionIntent" | "providerInstanceId"
  >,
): LocalDispatchSnapshot | null {
  return Boolean(active.preparingWorktrunk) === Boolean(update.preparingWorktrunk)
    ? null
    : { ...active, ...update };
}
