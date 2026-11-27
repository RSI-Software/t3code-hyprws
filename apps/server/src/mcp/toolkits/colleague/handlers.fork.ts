// Fork-owned handlers for the colleague MCP tools (colleague-collab). Each read goes to the
// colleague's server as the grant it gave this one, which answers only what that grant may read.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Colleagues from "../../../collaborator/Colleagues.fork.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ColleagueToolkitFork } from "./tools.fork.ts";

const failure = (code: OrchestratorMcpFailure["code"]) => (error: { readonly message: string }) =>
  Effect.fail(new OrchestratorMcpFailure({ code, message: error.message }));

const unknownColleague = {
  ColleagueNoneSavedErrorFork: failure("invalid_request"),
  ColleagueUnknownNameErrorFork: failure("invalid_request"),
};

export const ColleagueToolkitHandlersLiveFork = McpToolAccess.toLayer(ColleagueToolkitFork, {
  t3_colleague_threads: McpToolAccess.reads((input) =>
    Colleagues.ColleaguesFork.use((colleagues) => colleagues.threadsOf(input)).pipe(
      Effect.catchTags(unknownColleague),
    ),
  ),
  t3_colleague_thread_read: McpToolAccess.reads((input) =>
    Colleagues.ColleaguesFork.use((colleagues) => colleagues.threadOf(input)).pipe(
      Effect.catchTags(unknownColleague),
      Effect.catch(failure("orchestration_error")),
    ),
  ),
});
