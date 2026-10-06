// Fork-owned tools for owner-approved external MCP clients at
// `/api/mcp/external` (RSI-Software/t3code-hyprws device-auth domain). Names
// carry `t3_external_` so a client never mistakes them for the provider-thread
// catalog at `/mcp`, whose tools act relative to a calling T3 thread.
import {
  AuthSessionId,
  OrchestratorMcpCreatedThread,
  OrchestratorMcpFailure,
  OrchestratorMcpInteractionMode,
  OrchestratorMcpRuntimeMode,
  OrchestratorMcpTarget,
  OrchestratorMcpThreadDetail,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListItem,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ExternalMcpPolicy } from "../../../auth/ExternalMcpGrant.fork.ts";
import { ExternalMcpThreadWork } from "../../external/ExternalMcpWork.fork.ts";
import {
  ExternalMcpPrincipalFork,
  ExternalMcpServiceFork,
} from "../../external/ExternalMcpService.fork.ts";

const dependencies = [ExternalMcpPrincipalFork, ExternalMcpServiceFork];

/** Required on every mutation: the retry key that makes it idempotent. */
const ClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
  description:
    "Caller-chosen key, stable across retries of one request and distinct between requests. A retry with the same key and request replays the first result instead of acting twice; the same key with a different request is refused.",
});

const WhoamiResult = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  clientLabel: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  policy: ExternalMcpPolicy,
});

const ProjectListResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({ projectId: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
  ),
});

const ThreadListInput = Schema.Struct({
  ...OrchestratorMcpThreadListInput.fields,
  projectId: ProjectId,
});

const ThreadListResult = Schema.Struct({
  projectId: ProjectId,
  threads: Schema.Array(
    Schema.Struct({ ...OrchestratorMcpThreadListItem.fields, work: ExternalMcpThreadWork }),
  ),
  nextCursor: Schema.NullOr(Schema.Number),
  total: Schema.Number,
});

const ThreadReadResult = Schema.Struct({
  ...OrchestratorMcpThreadReadResult.fields,
  thread: Schema.Struct({ ...OrchestratorMcpThreadDetail.fields, work: ExternalMcpThreadWork }),
});

const ThreadWaitInput = Schema.Struct({
  ...OrchestratorMcpThreadWaitInput.fields,
  until: Schema.optional(
    Schema.Literals(["run", "work"]).annotate({
      description:
        "run (default) waits for one run to end. work waits until nothing runs and no background work holds the thread, or a request waits on a person; it takes no runId.",
    }),
  ),
});

const ThreadWaitResult = Schema.Struct({
  ...OrchestratorMcpThreadWaitResult.fields,
  work: ExternalMcpThreadWork,
});

const ThreadCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  prompt: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120_000))),
  target: Schema.optional(OrchestratorMcpTarget),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
  clientRequestId: ClientRequestId,
});

const ThreadSendInput = Schema.Struct({
  ...OrchestratorMcpThreadSendInput.fields,
  clientRequestId: ClientRequestId,
});

const ThreadInterruptInput = Schema.Struct({
  ...OrchestratorMcpThreadInterruptInput.fields,
  clientRequestId: ClientRequestId,
});

const WhoamiTool = Tool.make("t3_external_whoami", {
  description:
    "Report this credential's identity and grant: session, client label, expiry, the projects it reaches, whether it may coordinate threads, and its runtime and interaction mode ceilings.",
  success: WhoamiResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Describe this credential")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ProjectListTool = Tool.make("t3_external_project_list", {
  description: "List the T3 projects this credential may read and, when granted, coordinate.",
  success: ProjectListResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "List T3 projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadListTool = Tool.make("t3_external_thread_list", {
  description:
    "List threads in one granted project, newest first. Filter by run status, title, or settled state and paginate with the returned cursor. Each thread's work shows what run status misses: background work an ended turn left running, and the turn of a subagent thread the provider started itself.",
  parameters: ThreadListInput,
  success: ThreadListResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "List T3 threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadReadTool = Tool.make("t3_external_thread_read", {
  description:
    "Read a thread's durable state and a paginated timeline. thread.status is run status; thread.work adds background work and a provider-native subagent's turn. The messages view returns user and assistant messages and proposed plans; activity returns every summarized item. Continue with afterPosition=nextPosition, and recover long text with itemId and textOffset=nextTextOffset.",
  parameters: OrchestratorMcpThreadReadInput,
  success: ThreadReadResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read a T3 thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadWaitTool = Tool.make("t3_external_thread_wait", {
  description:
    "Wait up to timeoutMs (default 60s, at most 10 minutes) for a thread run to reach a terminal state. Without runId the latest run is selected; an idle thread returns at once. A run can end while work it started still runs: the result's work says so, and until=work waits for that work too. A timeout interrupts nothing, so call again after timedOut=true.",
  parameters: ThreadWaitInput,
  success: ThreadWaitResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Wait for a T3 thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadCreateTool = Tool.make("t3_external_thread_create", {
  description:
    "Create a top-level thread in a granted project, recorded as created by an agent over MCP. With prompt it starts at once. Provider and model default to the project's; runtime and interaction modes default to this credential's ceilings and never exceed them. Needs a coordinating credential.",
  parameters: ThreadCreateInput,
  success: OrchestratorMcpCreatedThread,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Create a T3 thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ThreadSendTool = Tool.make("t3_external_thread_send", {
  description:
    "Send a message to a thread in a granted project. mode='auto' starts an idle thread, steers an active turn, or queues behind one not yet steerable; queue, steer, and restart force one behavior. A thread running above this credential's ceilings is refused. Needs a coordinating credential.",
  parameters: ThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Send to a T3 thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ThreadInterruptTool = Tool.make("t3_external_thread_interrupt", {
  description:
    "Request interruption of a thread's running turn. Without runId the newest interruptible run is selected; a thread with nothing running returns without effect. Needs a coordinating credential.",
  parameters: ThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a T3 thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ExternalMcpToolkitFork = Toolkit.make(
  WhoamiTool,
  ProjectListTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadWaitTool,
  ThreadCreateTool,
  ThreadSendTool,
  ThreadInterruptTool,
);
