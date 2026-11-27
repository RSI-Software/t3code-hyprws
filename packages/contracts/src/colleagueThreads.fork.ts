// Fork-only (colleague-collab): a saved colleague's agent reads the threads this server lets that
// colleague read. Apart from `collaborator.fork.ts`, which `composerContext.ts` imports, so the MCP
// schemas these build on load without a cycle.
import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import {
  OrchestratorMcpThreadListItem,
  OrchestratorMcpThreadTimelineItem,
} from "./orchestratorMcp.ts";

/** Read-only: the threads this server lets the calling colleague read, and one of them. */
export const COLLEAGUE_THREADS_ROUTE_FORK = "/api/fork/colleague/threads";
export const COLLEAGUE_THREAD_ROUTE_FORK = "/api/fork/colleague/thread";

export const ColleagueThreadsInputFork = Schema.Struct({
  /** Keyword search over title, branch, pull request, project, then message text. */
  query: Schema.optional(TrimmedNonEmptyString.check(Schema.isMinLength(2))),
});
export type ColleagueThreadsInputFork = typeof ColleagueThreadsInputFork.Type;

export const ColleagueThreadFork = Schema.Struct({
  ...OrchestratorMcpThreadListItem.fields,
  /** Where a `query` matched. */
  match: Schema.optional(
    Schema.Struct({
      source: Schema.Literals(["title", "user", "assistant"]),
      snippet: Schema.optional(Schema.String),
    }),
  ),
});
export type ColleagueThreadFork = typeof ColleagueThreadFork.Type;

export const ColleagueThreadsResultFork = Schema.Struct({
  threads: Schema.Array(ColleagueThreadFork),
});
export type ColleagueThreadsResultFork = typeof ColleagueThreadsResultFork.Type;

export const ColleagueThreadInputFork = Schema.Struct({
  threadId: ThreadId,
  /** Older messages: the last page's `earlierPosition`. */
  beforePosition: Schema.optional(NonNegativeInt),
  /** Cut-off text: the item, then `textOffset` from its `nextTextOffset`. */
  itemId: Schema.optional(TurnItemId),
  textOffset: Schema.optional(NonNegativeInt),
});
export type ColleagueThreadInputFork = typeof ColleagueThreadInputFork.Type;

export const ColleagueThreadResultFork = Schema.Struct({
  thread: ColleagueThreadFork,
  /** Newest last. */
  items: Schema.Array(OrchestratorMcpThreadTimelineItem),
  /** null when nothing is older than the page. */
  earlierPosition: Schema.NullOr(NonNegativeInt),
});
export type ColleagueThreadResultFork = typeof ColleagueThreadResultFork.Type;

/** The same reads on this side, naming the saved colleague whose server answers them. */
const ColleagueName = TrimmedNonEmptyString.annotate({ description: "A saved colleague's name." });

export const ColleaguesThreadsInputFork = Schema.Struct({
  /** One colleague; all saved ones when absent. */
  colleague: Schema.optional(ColleagueName),
  ...ColleagueThreadsInputFork.fields,
});
export type ColleaguesThreadsInputFork = typeof ColleaguesThreadsInputFork.Type;

export const ColleaguesThreadsResultFork = Schema.Struct({
  colleagues: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      threads: Schema.optional(Schema.Array(ColleagueThreadFork)),
      /** Why their threads could not be read, such as their machine being offline. */
      error: Schema.optional(Schema.String),
    }),
  ),
});
export type ColleaguesThreadsResultFork = typeof ColleaguesThreadsResultFork.Type;

export const ColleagueThreadOfInputFork = Schema.Struct({
  colleague: ColleagueName,
  ...ColleagueThreadInputFork.fields,
});
export type ColleagueThreadOfInputFork = typeof ColleagueThreadOfInputFork.Type;
