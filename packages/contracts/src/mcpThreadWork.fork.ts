// Fork-owned thread work schema (RSI-Software/t3code-hyprws device-auth
// domain): what a thread is doing beyond its runs, as the in-thread `/mcp` and
// the external `/api/mcp/external` thread tools report it. The server derives it.
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";
import { OrchestrationV2ExecutionNode } from "./orchestrationV2.ts";

const McpNativeTurnFork = Schema.Struct({
  status: OrchestrationV2ExecutionNode.fields.status,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
}).annotate({
  description:
    "The provider-native turn of a subagent thread the provider started itself. Such a thread has no runs, so this is its only status: pending, running, and waiting are active; completed, failed, cancelled, interrupted, and rolled_back are terminal.",
});
export type McpNativeTurnFork = typeof McpNativeTurnFork.Type;

const McpBackgroundTaskFork = Schema.Struct({
  taskId: Schema.String,
  kind: Schema.Literals(["subagent", "command", "monitor", "background_task"]),
  description: Schema.NullOr(Schema.String),
  childThreadId: Schema.NullOr(ThreadId),
  holdsCompletion: Schema.Boolean,
});

export const McpThreadWorkFork = Schema.Struct({
  state: Schema.Literals(["awaiting_response", "running", "waiting_on_background", "idle"]),
  background: Schema.Array(McpBackgroundTaskFork),
  nativeTurn: Schema.NullOr(McpNativeTurnFork),
  updatedAt: IsoDateTime,
}).annotate({
  description:
    "What the thread is doing now, beyond its runs. state: awaiting_response when a request waits on a person; running while a run is active or queued to be delivered (a held queue is idle), or a native turn is active; waiting_on_background when work a turn started still runs and holds the thread open (subagents, monitors, background tasks), which outranks a run waiting only on its checkpoint; idle otherwise. background lists that work; a command, such as a dev server, may stay listed while idle because it does not hold the thread. updatedAt is the last change T3 recorded: T3 learns of background work from the provider and does not poll it, so an old updatedAt means no news, not proof of progress.",
});
export type McpThreadWorkFork = typeof McpThreadWorkFork.Type;

export const McpThreadWaitUntilFork = Schema.Literals(["run", "work"]).annotate({
  description:
    "run (default) waits for one run to end. work waits until nothing runs and no background work holds the thread, or a request waits on a person; it takes no runId.",
});
