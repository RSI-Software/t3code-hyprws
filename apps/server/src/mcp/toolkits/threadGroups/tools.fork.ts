// Fork-owned MCP tools for the environment's sidebar thread groups
// (thread-ordering). `McpHttpServer.ts` registers them through the marked
// `thread-ordering/mcp-thread-groups-toolkit` hook.
import {
  OrchestratorMcpFailure,
  ThreadGroupEditFork,
  ThreadGroupErrorFork,
  ThreadGroupsDescribedFork,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadGroups from "../../../orchestration-v2/ThreadGroupsService.fork.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadGroups.ThreadGroupsServiceFork,
];

const ThreadGroupListTool = Tool.make("t3_thread_group_list", {
  description:
    "List the sidebar thread groups in this environment: each group's id, title, parent thread, and member threads, plus the calling thread's group. Groups are visual only; they do not change how threads run.",
  success: ThreadGroupsDescribedFork,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "List thread groups")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ThreadGroupUpdateTool = Tool.make("t3_thread_group_update", {
  description:
    'Change the sidebar thread groups every client of this environment shows. Pass one change as edit. type="set-membership" moves threadIds into target {type:"existing",groupId}, a {type:"new",title} group of at least two threads, or out of any group with {type:"none"}; asParent makes the first thread the group\'s parent, shown first with the rest under it. type="rename" retitles a group, "set-parent" sets or clears (null) its parent, "remove" dissolves it without touching its threads. A thread belongs to at most one group, and a group left with fewer than two threads dissolves. Returns every group after the change.',
  // MCP needs an object root, so the edit union sits under one key.
  parameters: Schema.Struct({ edit: ThreadGroupEditFork }),
  success: ThreadGroupsDescribedFork,
  failure: Schema.Union([OrchestratorMcpFailure, ThreadGroupErrorFork]),
  dependencies,
})
  .annotate(Tool.Title, "Update thread groups")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ThreadGroupsToolkitFork = Toolkit.make(ThreadGroupListTool, ThreadGroupUpdateTool);
