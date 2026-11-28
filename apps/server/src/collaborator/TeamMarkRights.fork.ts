// Fork-only (colleague-collab): whose rights a thread's agent holds, for marking a team project.
import type {
  OrchestrationMessageContext,
  OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

type ThreadRef = Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "activeRunId" | "latestRunId">;

export class TeamMarkRightsFork extends Context.Service<
  TeamMarkRightsFork,
  {
    /**
     * The agent acts for the host only when the host wrote every message of its run, steering
     * included, and of each run up its delegation lineage that started it.
     */
    readonly actsForHost: (thread: ThreadRef) => Effect.Effect<boolean, OrchestratorV2Error>;
  }
>()("t3/collaborator/TeamMarkRights.fork/TeamMarkRightsFork") {}

const fromHost = (context: OrchestrationMessageContext | undefined) =>
  context?.guest === undefined &&
  (context?.collaboratorFork === undefined || context.collaboratorFork.host === true);

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;

  const runFromHost = (threadId: ThreadId, runId: RunId) =>
    threads
      .getThreadRecords(threadId, ["messages"], { messageRunIds: [runId], messageRoles: ["user"] })
      .pipe(Effect.map(({ messages }) => messages.every((message) => fromHost(message.context))));

  const actsForHost = Effect.fn("TeamMarkRightsFork.actsForHost")(function* (thread: ThreadRef) {
    let threadId = thread.id;
    let lineage = thread.lineage;
    let runId = thread.activeRunId ?? thread.latestRunId;
    while (true) {
      if (runId !== null && !(yield* runFromHost(threadId, runId))) return false;
      const parentId = lineage.parentThreadId;
      if (parentId === null || lineage.relationshipToParent !== "subagent") return true;
      const childId = threadId;
      const parent = yield* threads.getThreadRecords(parentId, ["subagents"], {
        subagentChildThreadIds: [childId],
      });
      runId = parent.subagents.find((task) => task.childThreadId === childId)?.runId ?? null;
      threadId = parentId;
      lineage = parent.thread.lineage;
    }
  });

  return TeamMarkRightsFork.of({ actsForHost });
});

export const layer = Layer.effect(TeamMarkRightsFork, make);
