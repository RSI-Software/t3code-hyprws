// Fork-owned work view on the in-thread `/mcp` thread tools. Upstream's list, read, and wait
// report run status only, so a thread whose run ended with subagents, monitors, or delegated
// children still running reads as done. List, read, and run waits call the upstream service
// first, keeping its authorization and output, then add the work `/api/mcp/external` reports.
import {
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadWaitInput,
  type ThreadId,
} from "@t3tools/contracts";
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

const loadShell = (
  threads: ThreadManagementService.ThreadManagementServiceShape,
  threadId: ThreadId,
) =>
  threads.getThreadShell(threadId).pipe(
    Effect.mapError(OrchestratorMcpService.threadManagementFailureFork),
    Effect.filterOrElse(
      (shell): shell is OrchestrationV2ThreadShell => shell !== null && shell.deletedAt === null,
      () =>
        OrchestratorMcpService.threadNotFound(
          threads,
          threadId,
          `Thread ${threadId} was not found.`,
        ),
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
 * A work wait skips upstream's run wait: that pins the latest run, and a held
 * queued run never ends on its own, so it would spend the whole budget. Reads
 * on `/mcp` need only the orchestration capability and a live target, which
 * the capability check and `loadShell` enforce here.
 */
export const waitForThreadFork = Effect.fn("OrchestratorMcpThreadWork.waitForThread")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  input: OrchestratorMcpThreadWaitInput,
) {
  yield* assertWaitTarget(input);
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const { until, ...runWait } = input;
  if (until === "work") {
    if (!scope.capabilities.has("orchestration")) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This MCP credential does not grant orchestration capabilities.",
      });
    }
    return yield* waitForWork(
      threads,
      (threadId) => loadShell(threads, threadId),
      input.threadId,
      Math.min(
        OrchestratorMcpService.maxWaitTimeoutMsFork,
        Math.max(1, input.timeoutMs ?? OrchestratorMcpService.defaultWaitTimeoutMsFork),
      ),
    );
  }
  const service = yield* OrchestratorMcpService.OrchestratorMcpService;
  const result = yield* service.waitForThread(scope, runWait);
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
