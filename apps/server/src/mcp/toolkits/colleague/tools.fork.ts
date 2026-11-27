// Fork-owned MCP tools (colleague-collab): an agent reads its user's saved colleagues' threads, as
// that user's colleague grant on each colleague's server. `McpHttpServer.ts` registers them through
// the marked `colleague-collab/mcp-colleague-toolkit` hook.
import {
  ColleagueThreadFork,
  ColleagueThreadResultFork,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as Colleagues from "../../../collaborator/Colleagues.fork.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, Colleagues.ColleaguesFork];

const colleague = TrimmedNonEmptyString.annotate({ description: "A saved colleague's name." });

const ColleagueThreadsTool = Tool.make("t3_colleague_threads", {
  description:
    "List what the user's saved colleagues are working on: every thread in their team projects, plus threads they shared with the user. Newest first. Read-only, on each colleague's machine. `colleague`: one by name, else all. `query`: keyword search by title, branch, PR, project, then message text. Read one with `t3_colleague_thread_read`.",
  parameters: Schema.Struct({
    colleague: Schema.optional(colleague),
    query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMinLength(2))),
  }),
  success: Schema.Struct({
    colleagues: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        threads: Schema.optional(Schema.Array(ColleagueThreadFork)),
        /** Why their threads could not be read, such as their machine being offline. */
        error: Schema.optional(Schema.String),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List colleagues' threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ColleagueThreadReadTool = Tool.make("t3_colleague_thread_read", {
  description:
    "Read a thread `t3_colleague_threads` listed, on that colleague's machine: its newest messages; older: `beforePosition=earlierPosition`. Read-only: it never sends, runs a turn, or changes anything there. In your reply, name it as its `link` verbatim.",
  parameters: Schema.Struct({
    colleague,
    threadId: ThreadId,
    beforePosition: Schema.optional(NonNegativeInt),
  }),
  success: ColleagueThreadResultFork,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a colleague's thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ColleagueToolkitFork = Toolkit.make(ColleagueThreadsTool, ColleagueThreadReadTool);
