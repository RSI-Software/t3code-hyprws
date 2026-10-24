// Fork-owned handlers for the thread group MCP tools (thread-ordering), plus
// the launch hook that places agent-launched threads. Both act through
// `ThreadGroupsServiceFork`, so every client sees the change live.
import {
  OrchestratorMcpFailure,
  type ThreadGroupsSnapshotFork,
  type ThreadId,
  type ThreadLaunchGroupFork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ThreadGroupsServiceFork } from "../../../orchestration-v2/ThreadGroupsService.fork.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { type ThreadGroupListResult, ThreadGroupsToolkitFork } from "./tools.fork.ts";

/** Names each member; a thread deleted since it was grouped is left out. */
const describeGroups = Effect.fn("ThreadGroupsToolkitFork.describe")(function* (
  snapshot: ThreadGroupsSnapshotFork,
) {
  const { caller, threads } = yield* readCaller();
  const groups = yield* Effect.forEach(snapshot.groups, (group) =>
    Effect.gen(function* () {
      const members = yield* Effect.forEach(group.threadIds, (threadId) =>
        threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable)),
      );
      return {
        id: group.id,
        title: group.title,
        parentThreadId: group.parentThreadId ?? null,
        threads: members.flatMap((shell) =>
          shell === null || shell.deletedAt !== null
            ? []
            : [{ threadId: shell.id, title: shell.title }],
        ),
      };
    }),
  );
  const callerGroup =
    caller === undefined
      ? undefined
      : snapshot.groups.find((group) => group.threadIds.includes(caller.id));
  return { groups, callerGroupId: callerGroup?.id ?? null } satisfies ThreadGroupListResult;
});

export const ThreadGroupsToolkitHandlersLiveFork = McpToolAccess.toLayer(ThreadGroupsToolkitFork, {
  t3_thread_group_list: McpToolAccess.reads(() =>
    ThreadGroupsServiceFork.pipe(
      Effect.flatMap((groups) => groups.snapshot),
      Effect.flatMap(describeGroups),
    ),
  ),
  t3_thread_group_update: McpToolAccess.writesThreads(
    ({ edit }) => (edit.type === "set-membership" ? edit.threadIds : []),
    ({ edit }) =>
      Effect.gen(function* () {
        // Thread control, as for the other thread tools.
        yield* readCaller();
        const groups = yield* ThreadGroupsServiceFork;
        return yield* describeGroups(yield* groups.mutate(edit));
      }),
  ),
});

/**
 * Resolves where launched threads go before any exists, so an unknown groupId
 * creates nothing. The returned join never fails: the threads are already
 * launched, and a failed launch reply would invite a duplicate retry. The
 * service is read from the handler's build context rather than declared on
 * the upstream launch tools, whose tests build without it.
 */
export const prepareLaunchGroupFork = Effect.fn("ThreadGroupsToolkitFork.prepareLaunchGroup")(
  function* (callerThreadId: ThreadId | undefined, group: ThreadLaunchGroupFork | undefined) {
    const found = yield* Effect.serviceOption(ThreadGroupsServiceFork);
    const service = Option.getOrUndefined(found);
    let groupId: string | undefined;
    if (service === undefined) {
      if (typeof group === "object") {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This environment has no thread groups. No thread was created.",
        });
      }
    } else if (group === undefined || group === "caller") {
      groupId =
        callerThreadId === undefined ? undefined : (yield* service.groupOf(callerThreadId))?.id;
    } else if (group !== "none") {
      const { groups } = yield* service.snapshot;
      if (!groups.some((candidate) => candidate.id === group.groupId)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Unknown thread group ${group.groupId}. No thread was created; t3_thread_group_list lists the groups.`,
        });
      }
      groupId = group.groupId;
    }
    return (launched: ReadonlyArray<{ readonly threadId: ThreadId; readonly status?: string }>) => {
      const [first, ...rest] = launched
        .filter((thread) => thread.status !== "rolled_back")
        .map((thread) => thread.threadId);
      if (service === undefined || groupId === undefined || first === undefined) return Effect.void;
      return service
        .mutate({
          type: "set-membership",
          threadIds: [first, ...rest],
          target: { type: "existing", groupId },
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTags({
            ThreadGroupErrorFork: (error) =>
              Effect.logWarning("Launched threads were left out of their group", {
                groupId,
                reason: error.message,
              }),
          }),
        );
    };
  },
);
