// Fork-owned work view on the in-thread `/mcp` thread tools
// (RSI-Software/t3code-hyprws device-auth domain). Upstream's list, read, and
// wait report run status only, so a thread whose run ended with subagents,
// monitors, or delegated children still running reads as done. Each wrapper
// calls the upstream service first, which keeps its authorization and output,
// then adds the work `/api/mcp/external` reports.
import {
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadWaitInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  assertWaitTarget,
  type McpThreadReadResult,
  type McpThreadWaitResult,
  NATIVE_TURN_READ_CONCURRENCY,
  waitForWork,
  workOf,
} from "../../McpThreadWork.fork.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import type { OrchestratorToolkit } from "./tools.ts";

// The budget upstream's run wait clamps to; a work wait spends what it leaves.
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;

const loadShell = (
  threads: ThreadManagementService.ThreadManagementServiceShape,
  threadId: ThreadId,
) =>
  threads.getThreadShell(threadId).pipe(
    Effect.mapError(OrchestratorMcpService.threadManagementFailureFork),
    Effect.filterOrFail(
      (shell): shell is OrchestrationV2ThreadShell => shell !== null && shell.deletedAt === null,
      () =>
        new OrchestratorMcpFailure({
          code: "thread_not_found",
          message: `Thread ${threadId} was not found.`,
        }),
    ),
  );

export const listThreadsFork = Effect.fn("OrchestratorMcpThreadWork.listThreads")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  input: OrchestratorMcpThreadListInput,
) {
  const service = yield* OrchestratorMcpService.OrchestratorMcpService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const result = yield* service.listThreads(scope, input);
  const shells = yield* threads
    .listProjectThreads({
      projectId: result.projectId,
      includeSubagents: input.includeSubagents !== false,
    })
    .pipe(Effect.mapError(OrchestratorMcpService.threadManagementFailureFork));
  const shellById = new Map(shells.map((shell) => [shell.id, shell]));
  // A row deleted between the two reads drops out rather than reporting stale work.
  const rows = yield* Effect.forEach(
    result.threads,
    (thread) => {
      const shell = shellById.get(thread.threadId);
      return shell === undefined
        ? Effect.succeed([])
        : workOf(threads, shell).pipe(Effect.map((work) => [{ ...thread, work }]));
    },
    { concurrency: NATIVE_TURN_READ_CONCURRENCY },
  );
  return { ...result, threads: rows.flat() };
});

export const readThreadFork = Effect.fn("OrchestratorMcpThreadWork.readThread")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  input: OrchestratorMcpThreadReadInput,
) {
  const service = yield* OrchestratorMcpService.OrchestratorMcpService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const result = yield* service.readThread(scope, input);
  const work = yield* workOf(threads, yield* loadShell(threads, input.threadId));
  return { ...result, thread: { ...result.thread, work } } satisfies McpThreadReadResult;
});

/**
 * A work wait first waits on the latest run, which authorizes the caller and
 * covers the common case, then polls background work with the budget left.
 */
export const waitForThreadFork = Effect.fn("OrchestratorMcpThreadWork.waitForThread")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  input: OrchestratorMcpThreadWaitInput,
) {
  yield* assertWaitTarget(input);
  const service = yield* OrchestratorMcpService.OrchestratorMcpService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const { until, ...runWait } = input;
  const budgetMs = Math.min(
    MAX_WAIT_TIMEOUT_MS,
    Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
  );
  const startedMs = yield* Clock.currentTimeMillis;
  const result = yield* service.waitForThread(scope, runWait);
  if (until === "work" && !result.timedOut && result.pendingRequestCount === 0) {
    const elapsedMs = (yield* Clock.currentTimeMillis) - startedMs;
    return yield* waitForWork(
      threads,
      (threadId) => loadShell(threads, threadId),
      input.threadId,
      Math.max(1, budgetMs - elapsedMs),
    );
  }
  // The run's outcome stands; work reports what still runs after it.
  const work = yield* workOf(threads, yield* loadShell(threads, input.threadId));
  return { ...result, work } satisfies McpThreadWaitResult;
});

const withScope =
  <I, A, R>(
    run: (
      scope: McpInvocationContext.McpInvocationScope,
      input: I,
    ) => Effect.Effect<A, OrchestratorMcpFailure, R>,
  ) =>
  (input: I) =>
    Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) => run(scope, input));

/** Replaces upstream's three thread-read handlers; access stays a plain read. */
export const threadWorkHandlersFork = {
  t3_thread_list: McpToolAccess.reads(withScope(listThreadsFork)),
  t3_thread_read: McpToolAccess.reads(withScope(readThreadFork)),
  t3_thread_wait: McpToolAccess.reads(withScope(waitForThreadFork)),
} satisfies Pick<
  McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>,
  "t3_thread_list" | "t3_thread_read" | "t3_thread_wait"
>;
