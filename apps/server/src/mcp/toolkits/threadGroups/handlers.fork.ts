// Fork-owned handlers for the thread group MCP tools (thread-ordering), plus
// the launch hook that places agent-launched threads. Both act through
// `ThreadGroupsServiceFork`, so every client sees the change live.
import {
  OrchestratorMcpFailure,
  type ThreadId,
  type ThreadLaunchGroupFork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadGroups from "../../../orchestration-v2/ThreadGroupsService.fork.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ThreadGroupsToolkitFork } from "./tools.fork.ts";

export const ThreadGroupsToolkitHandlersLiveFork = McpToolAccess.toLayer(ThreadGroupsToolkitFork, {
  t3_thread_group_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const groups = yield* ThreadGroups.ThreadGroupsServiceFork;
      return yield* groups.describe(yield* groups.snapshot, caller?.id);
    }),
  ),
  t3_thread_group_update: McpToolAccess.writesThreads(
    ({ edit }) => (edit.type === "set-membership" ? edit.threadIds : []),
    ({ edit }) =>
      Effect.gen(function* () {
        // Thread control, as for the other thread tools.
        const { caller } = yield* readCaller();
        const groups = yield* ThreadGroups.ThreadGroupsServiceFork;
        return yield* groups.describe(yield* groups.mutate(edit), caller?.id);
      }),
  ),
});

/**
 * The launch tools' view of `prepareLaunch`. The service is read from the
 * handler's build context rather than declared on the upstream launch tools,
 * whose tests build without it.
 */
export const prepareLaunchGroupFork = Effect.fn("ThreadGroupsToolkitFork.prepareLaunchGroup")(
  function* (callerThreadId: ThreadId | undefined, group: ThreadLaunchGroupFork | undefined) {
    const service = Option.getOrUndefined(
      yield* Effect.serviceOption(ThreadGroups.ThreadGroupsServiceFork),
    );
    if (service === undefined) {
      if (typeof group !== "object") return (_threadId: ThreadId) => Effect.void;
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "This environment has no thread groups. No thread was created.",
      });
    }
    return yield* service.prepareLaunch(callerThreadId, group).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `${error.message} No thread was created; t3_thread_group_list lists the groups.`,
          }),
      ),
    );
  },
);

/** Runs a batch launch so each thread it accepts joins as it is accepted. */
export const placeLaunchedThreadsFork =
  (join: (threadId: ThreadId) => Effect.Effect<void>) =>
  <A, E, R>(launch: Effect.Effect<A, E, R>) =>
    Effect.provideService(launch, ThreadGroups.LaunchedThreadPlacementFork, join);
