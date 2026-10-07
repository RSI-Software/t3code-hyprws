// Fork-owned delegated rounds (RSI-Software/t3code-hyprws#1652). A parent
// continues one app-owned delegated task instead of delegating a fresh child
// per round, so the child keeps its own context. `delegated_task.request`
// with `continueTaskId` reopens the same task row on the current parent run
// and sends the round's brief to the child thread; the upstream finalize path
// then delivers one result per round, keyed by the child run that produced it.
// Archiving the child thread releases it: continuation refuses an archived or
// deleted child, and unarchiving makes it continuable again.
import {
  isOrchestrationV2WorkActive,
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";

export type DelegatedRoundCommandFork = Extract<
  OrchestrationV2Command,
  { readonly type: "delegated_task.request" }
>;

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

const isTerminalTask = (status: OrchestrationV2Subagent["status"]) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted";

/**
 * The reopened task row, or why the round is refused. A round needs a
 * finished app-owned task whose child is neither released nor busy.
 */
export const decideDelegatedRoundFork = (input: {
  readonly continueTaskId: string;
  readonly parentThreadId: string;
  readonly parentRunId: OrchestrationV2Run["id"];
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly child:
    | {
        readonly thread: Pick<OrchestrationV2AppThread, "id" | "archivedAt" | "deletedAt">;
        readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>;
      }
    | undefined;
  readonly completionWake: OrchestrationV2Subagent["completionWake"];
  readonly now: DateTime.Utc;
}): OrchestrationV2Subagent | { readonly refused: string } => {
  const task = input.subagents.find(
    (candidate) =>
      candidate.id === input.continueTaskId &&
      candidate.origin === "app_owned" &&
      candidate.childThreadId !== null,
  );
  if (task === undefined) {
    return {
      refused: `Task ${input.continueTaskId} is not an app-owned delegated task of thread ${input.parentThreadId}.`,
    };
  }
  if (!isTerminalTask(task.status)) {
    return { refused: `Task ${task.id} is still running a round; wait for its result first.` };
  }
  if (
    input.child === undefined ||
    input.child.thread.deletedAt !== null ||
    input.child.thread.archivedAt !== null
  ) {
    return {
      refused: `Task ${task.id} was released: its child thread is archived or deleted. Unarchive it or delegate a fresh task.`,
    };
  }
  if (input.child.runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))) {
    return { refused: `Task ${task.id} has child work still running; wait for it to finish.` };
  }
  // The projection keeps a stored delivery when a payload omits it, so the
  // round resets it explicitly. Delivery sweeps only collect terminal pending
  // tasks, and this round's finalize replaces the state with its own plan.
  return {
    ...task,
    runId: input.parentRunId,
    ...(input.completionWake === undefined ? {} : { completionWake: input.completionWake }),
    completionDelivery: { state: "pending", observedByRunId: null },
    status: "running",
    result: null,
    startedAt: input.now,
    completedAt: null,
    updatedAt: input.now,
  };
};

const isPairResult = (
  task: Pick<OrchestrationV2Subagent, "childThreadId" | "threadId">,
  transfer: OrchestrationV2ContextTransfer,
) =>
  transfer.type === "subagent_result" &&
  transfer.sourceThreadId === task.childThreadId &&
  transfer.targetThreadId === task.threadId;

/**
 * Whether a published result already covers this finalize. Upstream delivers
 * once per child/parent pair, which still holds for a finished task. A task
 * still running owes one result per child run; a transfer from before run
 * keys (no `sourcePoint.runId`) can only be the first run's.
 */
export const delegatedRoundCoveredFork = (
  task: Pick<OrchestrationV2Subagent, "status">,
  transfer: OrchestrationV2ContextTransfer,
  childRun: Pick<OrchestrationV2Run, "id" | "ordinal">,
): boolean =>
  !isOrchestrationV2WorkActive(task.status) ||
  transfer.sourcePoint.runId === childRun.id ||
  (transfer.sourcePoint.runId === undefined && childRun.ordinal === 1);

/**
 * A round after the first already published a result. Later rounds leave the
 * original timeline node and turn item as the first round left them.
 */
export const delegatedRoundIsLaterFork = (
  task: Pick<OrchestrationV2Subagent, "childThreadId" | "threadId">,
  transfers: ReadonlyArray<OrchestrationV2ContextTransfer>,
): boolean => transfers.some((transfer) => isPairResult(task, transfer));

/**
 * Upstream progress, except that a parent-sent round whose run ended before
 * it started (start failure, cancel while starting) is still that round's
 * result. Upstream skips unstarted runs after the first, which would leave a
 * reopened task waiting on a round that already ended.
 */
export const delegatedRoundProgressFork = (
  projection: Omit<Parameters<typeof delegatedTaskProgress>[0], "messages"> & {
    readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "lineage">;
    readonly messages: ReadonlyArray<
      Pick<OrchestrationV2ConversationMessage, "runId" | "notification" | "senderThreadId">
    >;
  },
) => {
  const progress = delegatedTaskProgress(projection);
  const resultRun = progress.resultRun;
  const parentThreadId = projection.thread.lineage.parentThreadId;
  if (progress.state === "working" || resultRun === undefined || parentThreadId === null) {
    return progress;
  }
  const round = projection.runs
    .filter((run) => run.status !== "rolled_back" && run.ordinal > resultRun.ordinal)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (
    round === undefined ||
    round.startedAt !== null ||
    !TERMINAL_RUN_STATUSES.has(round.status) ||
    !projection.messages.some(
      (message) => message.runId === round.id && message.senderThreadId === parentThreadId,
    )
  ) {
    return progress;
  }
  return { ...progress, resultRun: round };
};

/**
 * Dispatches one round inside the parent's command transaction: reopen the
 * task, then send the brief to the child. The orchestrator passes its own
 * reads, emitter, message dispatch and error mapping, so this module never
 * imports `Orchestrator.ts` back.
 */
export const dispatchDelegatedRoundFork = Effect.fn("dispatchDelegatedRoundFork")(function* <
  E1,
  E2,
  E3,
  E4,
  R1,
  R2,
  R3,
>(input: {
  readonly command: DelegatedRoundCommandFork & { readonly continueTaskId: string };
  readonly parentRunId: OrchestrationV2Run["id"];
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly loadChild: (threadId: OrchestrationV2AppThread["id"]) => Effect.Effect<
    | {
        readonly thread: OrchestrationV2AppThread;
        readonly runs: ReadonlyArray<OrchestrationV2Run>;
      }
    | undefined,
    E1,
    R1
  >;
  readonly emit: (event: Omit<OrchestrationV2DomainEvent, "id">) => Effect.Effect<unknown, E2, R2>;
  readonly sendToChild: (
    message: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
  ) => Effect.Effect<unknown, E3, R3>;
  readonly childMessageId: MessageId;
  readonly refuse: (cause: string) => Effect.Effect<never, E4>;
}) {
  const { command } = input;
  const known = input.subagents.find((candidate) => candidate.id === command.continueTaskId);
  const child =
    known?.childThreadId === undefined || known.childThreadId === null
      ? undefined
      : yield* input.loadChild(known.childThreadId);
  const now = command.createdAt ?? (yield* DateTime.now);
  const decided = decideDelegatedRoundFork({
    continueTaskId: command.continueTaskId,
    parentThreadId: command.parentThreadId,
    parentRunId: input.parentRunId,
    subagents: input.subagents,
    child,
    completionWake: command.completionWake,
    now,
  });
  if ("refused" in decided) return yield* input.refuse(decided.refused);
  if (child === undefined) return yield* input.refuse(`Task ${decided.id} has no child thread.`);
  yield* input.emit({
    type: "subagent.updated",
    threadId: command.parentThreadId,
    runId: input.parentRunId,
    nodeId: decided.id,
    driver: decided.driver,
    providerInstanceId: decided.providerInstanceId,
    occurredAt: now,
    payload: decided,
  });
  yield* input.sendToChild({
    type: "message.dispatch",
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    commandId: command.commandId,
    threadId: child.thread.id,
    senderThreadId: command.parentThreadId,
    messageId: input.childMessageId,
    text: command.task,
    attachments: [],
    modelSelection: child.thread.modelSelection,
    dispatchMode: { type: "start_immediately" },
  });
});
