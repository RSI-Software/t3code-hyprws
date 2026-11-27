// Fork-owned handlers for the colleague MCP tools (colleague-collab). Each read goes to the
// colleague's server as the grant it gave this one, which answers only what that grant may read.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Colleagues from "../../../collaborator/Colleagues.fork.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ColleagueToolkitFork } from "./tools.fork.ts";

// The agent named no colleague the user saved; anything else failed on the way.
const askedWrong = new Set(["ColleagueNoneSavedErrorFork", "ColleagueUnknownNameErrorFork"]);

const mcpFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: askedWrong.has(error._tag) ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

export const ColleagueToolkitHandlersLiveFork = McpToolAccess.toLayer(ColleagueToolkitFork, {
  t3_colleague_threads: McpToolAccess.reads((input) =>
    Colleagues.ColleaguesFork.use((colleagues) => colleagues.threadsOf(input)).pipe(
      Effect.mapError(mcpFailure),
    ),
  ),
  t3_colleague_thread_read: McpToolAccess.reads((input) =>
    Colleagues.ColleaguesFork.use((colleagues) => colleagues.threadOf(input)).pipe(
      Effect.mapError(mcpFailure),
    ),
  ),
});
