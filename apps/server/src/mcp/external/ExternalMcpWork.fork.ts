// Fork-owned work view for `/api/mcp/external` (RSI-Software/t3code-hyprws
// device-auth domain). Run status alone reads a thread as finished while the
// provider still works in the background: a foreground turn that ended with
// subagents or monitors left running, or a provider-native subagent thread,
// which has no runs at all. This reads the same projection the UI shows, so an
// external client sees what the sidebar's "Waiting on N subagents" sees.
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  IsoDateTime,
  OrchestrationV2ExecutionNode,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const ExternalMcpNativeTurn = Schema.Struct({
  status: OrchestrationV2ExecutionNode.fields.status,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
}).annotate({
  description:
    "The provider-native turn of a subagent thread the provider started itself. Such a thread has no runs, so this is its only status: pending, running, and waiting are active; completed, failed, cancelled, interrupted, and rolled_back are terminal.",
});
export type ExternalMcpNativeTurn = typeof ExternalMcpNativeTurn.Type;

const ExternalMcpBackgroundTask = Schema.Struct({
  taskId: Schema.String,
  kind: Schema.Literals(["subagent", "command", "monitor", "background_task"]),
  description: Schema.NullOr(Schema.String),
  childThreadId: Schema.NullOr(ThreadId),
  holdsCompletion: Schema.Boolean,
});

export const ExternalMcpThreadWork = Schema.Struct({
  state: Schema.Literals(["awaiting_response", "running", "waiting_on_background", "idle"]),
  background: Schema.Array(ExternalMcpBackgroundTask),
  nativeTurn: Schema.NullOr(ExternalMcpNativeTurn),
  updatedAt: IsoDateTime,
}).annotate({
  description:
    "What the thread is doing now, beyond its runs. state: awaiting_response when a request waits on a person; running while a run or native turn is active; waiting_on_background when no turn runs but work a turn started still runs and holds the thread open (subagents, monitors, background tasks); idle otherwise. background lists that work; a command, such as a dev server, may stay listed while idle because it does not hold the thread. updatedAt is the last change T3 recorded: T3 learns of background work from the provider and does not poll it, so an old updatedAt means no news, not proof of progress.",
});
export type ExternalMcpThreadWork = typeof ExternalMcpThreadWork.Type;

/** States a work wait returns on: nothing will change without a person or new work. */
export const isWorkSettled = (work: ExternalMcpThreadWork) =>
  work.state === "idle" || work.state === "awaiting_response";

type WorkShell = Pick<
  OrchestrationV2ThreadShell,
  | "lineage"
  | "creationSource"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "updatedAt"
>;

type NativeTurnNode = Pick<
  OrchestrationV2ExecutionNode,
  "kind" | "runId" | "status" | "startedAt" | "completedAt"
>;

/** Whether a thread's status lives on its runless root turn, which `nativeTurnOf` reads. */
export const hasNativeTurn = (shell: Pick<WorkShell, "lineage" | "creationSource">) =>
  isProviderNativeSubagentThread(shell);

/**
 * The provider-native turn, read as client-runtime's
 * `deriveProviderSubagentStatus` reads it: the last runless root turn.
 */
export const nativeTurnOf = (
  nodes: ReadonlyArray<NativeTurnNode>,
): ExternalMcpNativeTurn | null => {
  const node = nodes.findLast(
    (candidate) => candidate.kind === "root_turn" && candidate.runId === null,
  );
  if (node === undefined) return null;
  return {
    status: node.status,
    startedAt: node.startedAt === null ? null : DateTime.formatIso(node.startedAt),
    completedAt: node.completedAt === null ? null : DateTime.formatIso(node.completedAt),
  };
};

/** `nativeTurn` is null for a thread with runs, and for a native thread whose turn has not arrived. */
export const threadWork = (
  shell: WorkShell,
  nativeTurn: ExternalMcpNativeTurn | null,
): ExternalMcpThreadWork => {
  const tasks = shell.pendingBackgroundTasks ?? [];
  const runStatus = shell.activityRunStatus ?? null;
  // As in client-runtime's shellRuntime, held background work outranks a run
  // waiting on its checkpoint; the roster is empty while a run can be interrupted.
  const state =
    shell.pendingRuntimeRequest !== null
      ? "awaiting_response"
      : (runStatus !== null && runStatus !== "waiting") ||
          (nativeTurn !== null && isOrchestrationV2WorkActive(nativeTurn.status))
        ? "running"
        : backgroundWorkHoldsCompletion(tasks)
          ? "waiting_on_background"
          : runStatus === "waiting"
            ? "running"
            : "idle";
  return {
    state,
    background: tasks.map((task) => ({
      taskId: task.taskId,
      kind: task.kind,
      description: task.description ?? null,
      childThreadId: task.kind === "subagent" ? (task.childThreadId ?? null) : null,
      holdsCompletion: backgroundWorkHoldsCompletion([task]),
    })),
    nativeTurn,
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
};
