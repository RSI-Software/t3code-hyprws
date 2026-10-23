// Fork-owned work view for thread reads on `/mcp` and `/api/mcp/external`
// (RSI-Software/t3code-hyprws device-auth domain). Run status alone reads a
// thread as finished while the provider still works in the background: a
// foreground turn that ended with subagents or monitors left running, or a
// provider-native subagent thread, which has no runs at all. This reads the
// same projection the UI shows, so an agent watching a thread sees what the
// sidebar's "Waiting on N subagents" sees.
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  type McpNativeTurnFork,
  McpThreadWorkFork,
  type OrchestrationV2ExecutionNode,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadDetail,
  OrchestratorMcpThreadListItem,
  OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { threadManagementFailureFork } from "./OrchestratorMcpService.ts";

const WORK_POLL_INTERVAL_MS = 500;
/** Only provider-native subagent rows read their nodes; this bounds a list page's reads. */
export const NATIVE_TURN_READ_CONCURRENCY = 4;

type McpNativeTurn = McpNativeTurnFork;
export type McpThreadWork = McpThreadWorkFork;

type WorkShell = Pick<
  OrchestrationV2ThreadShell,
  | "lineage"
  | "creationSource"
  | "status"
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
const hasNativeTurn = (shell: Pick<WorkShell, "lineage" | "creationSource">) =>
  isProviderNativeSubagentThread(shell);

/**
 * The provider-native turn, read as client-runtime's
 * `deriveProviderSubagentStatus` reads it: the last runless root turn.
 */
export const nativeTurnOf = (nodes: ReadonlyArray<NativeTurnNode>): McpNativeTurn | null => {
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
export const threadWork = (shell: WorkShell, nativeTurn: McpNativeTurn | null): McpThreadWork => {
  const tasks = shell.pendingBackgroundTasks ?? [];
  const runStatus = shell.activityRunStatus ?? null;
  // As in client-runtime's shellRuntime, held background work outranks a run
  // waiting on its checkpoint; the roster is empty while a run can be interrupted.
  // A queued latest run is one the queue will deliver: the shell skips held queues.
  const state =
    shell.pendingRuntimeRequest !== null
      ? "awaiting_response"
      : (runStatus !== null && runStatus !== "waiting") ||
          shell.status === "queued" ||
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
    // Nodes are read after the shell, so a turn that ended between the reads
    // carries a newer time than the shell; report the latest.
    updatedAt: [DateTime.formatIso(shell.updatedAt), nativeTurn?.startedAt, nativeTurn?.completedAt]
      .filter((time) => time != null)
      .toSorted()
      .at(-1)!,
  };
};

// `/mcp` carries `work` optionally on upstream's contract; the external
// surface always reports it.
export const McpThreadListItem = Schema.Struct({
  ...OrchestratorMcpThreadListItem.fields,
  work: McpThreadWorkFork,
});

export const McpThreadReadResult = Schema.Struct({
  ...OrchestratorMcpThreadReadResult.fields,
  thread: Schema.Struct({ ...OrchestratorMcpThreadDetail.fields, work: McpThreadWorkFork }),
});
export type McpThreadReadResult = typeof McpThreadReadResult.Type;

export const McpThreadWaitResult = Schema.Struct({
  ...OrchestratorMcpThreadWaitResult.fields,
  work: McpThreadWorkFork,
});
export type McpThreadWaitResult = typeof McpThreadWaitResult.Type;

/** A run wait pins one run; a work wait spans the thread, so the two never combine. */
export const assertWaitTarget = (input: OrchestratorMcpThreadWaitInput) =>
  input.until === "work" && input.runId !== undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "runId waits on one run; until=work waits on the whole thread. Pass one, not both.",
        }),
      )
    : Effect.void;

type WorkReads = Pick<
  ThreadManagementService.ThreadManagementServiceShape,
  "getThreadRecords" | "getProjectThreadRecords" | "waitForThread"
>;

/** Only a provider-native subagent thread reads its nodes; every other thread has runs. */
export const workOf = (threads: WorkReads, shell: OrchestrationV2ThreadShell) =>
  hasNativeTurn(shell)
    ? threads.getThreadRecords(shell.id, ["nodes"]).pipe(
        Effect.map((records) => threadWork(shell, nativeTurnOf(records.nodes))),
        Effect.mapError(threadManagementFailureFork),
      )
    : Effect.succeed(threadWork(shell, null));

/**
 * Waits until nothing runs and no background work holds the thread, or a
 * request waits on a person. Never pins a run: background work outlives the
 * run that started it. `loadShell` owns the caller's visibility rules.
 */
export const waitForWork = Effect.fn("McpThreadWork.waitForWork")(function* (
  threads: WorkReads,
  loadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell, OrchestratorMcpFailure>,
  threadId: ThreadId,
  timeoutMs: number,
) {
  const current = loadShell(threadId).pipe(
    Effect.flatMap((shell) => workOf(threads, shell).pipe(Effect.map((work) => ({ shell, work })))),
  );
  // A restart ends its run before the continuation run exists, so an idle
  // read asks upstream's run wait, pinned to that ended run, whether a
  // continuation is still pending. The shell's latest run skips held queues.
  const continuationPending = (shell: OrchestrationV2ThreadShell, waitMs: number) =>
    shell.latestRunId === null
      ? Effect.succeed(false)
      : threads
          .waitForThread({
            projectId: shell.projectId,
            threadId,
            runId: shell.latestRunId,
            timeoutMs: waitMs,
          })
          .pipe(
            Effect.map((wait) => wait.timedOut || wait.run?.id !== shell.latestRunId),
            Effect.mapError(threadManagementFailureFork),
          );
  const settles = (read: Effect.Success<typeof current>, waitMs: number) =>
    read.work.state === "idle"
      ? continuationPending(read.shell, waitMs).pipe(Effect.map((pending) => !pending))
      : Effect.succeed(read.work.state === "awaiting_response");
  const waited = yield* Effect.gen(function* () {
    while (true) {
      const read = yield* current;
      if (yield* settles(read, WORK_POLL_INTERVAL_MS)) return read;
      yield* Effect.sleep(Duration.millis(WORK_POLL_INTERVAL_MS));
    }
  }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));
  // As with a run wait, the final read decides, so work that settled while
  // the timeout won the race does not count as timed out.
  const final = Option.isSome(waited) ? waited.value : yield* current;
  const settled = Option.isSome(waited) || (yield* settles(final, 1));
  const { shell, work } = final;
  const pendingCount = yield* threads
    .getProjectThreadRecords({ projectId: shell.projectId, threadId }, ["runtimeRequests"])
    .pipe(
      Effect.mapError(threadManagementFailureFork),
      Effect.map(ThreadManagementService.pendingRequestCount),
    );
  // A final read that sees a pending request reports needed input instead
  // of a timeout, matching the run wait; work still says what runs.
  return {
    threadId,
    runId: shell.latestRunId,
    status: shell.activityRunStatus ?? shell.status,
    timedOut: !settled && pendingCount === 0,
    work,
    pendingRequestCount: pendingCount,
  } satisfies McpThreadWaitResult;
});
