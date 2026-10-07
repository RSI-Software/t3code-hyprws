// Fork-owned pending-request reads and question answers for `/api/mcp/external`
// (RSI-Software/t3code-hyprws device-auth domain). Answers dispatch the same
// `runtime-request.respond` the provider-thread `t3_pending_request_respond`
// tool and the composer send. Approvals are listed so the caller can tell the
// owner; an external credential never decides one.
import {
  type CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalOption,
  ProviderRequestKind,
  type ProviderUserInputAnswers,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ExpectedModesFork } from "../../orchestration-v2/steerTarget.fork.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { threadManagementFailureFork } from "../OrchestratorMcpService.ts";
import type { ExternalMcpPrincipal } from "./ExternalMcpService.fork.ts";

export const ExternalMcpPendingRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("question"),
    requestId: RuntimeRequestId,
    runId: Schema.NullOr(RunId),
    questions: Schema.Array(OrchestrationV2UserInputQuestion),
  }),
  Schema.Struct({
    type: Schema.Literal("approval"),
    requestId: RuntimeRequestId,
    runId: Schema.NullOr(RunId),
    requestKind: ProviderRequestKind,
    detail: Schema.NullOr(Schema.String),
    options: Schema.Array(ProviderApprovalOption),
  }),
]);
export type ExternalMcpPendingRequest = typeof ExternalMcpPendingRequest.Type;

export const ExternalMcpRequestListResult = Schema.Struct({
  threadId: ThreadId,
  requests: Schema.Array(ExternalMcpPendingRequest),
});
export type ExternalMcpRequestListResult = typeof ExternalMcpRequestListResult.Type;

export const ExternalMcpRequestRespondResult = Schema.Struct({ sequence: Schema.Number });
export type ExternalMcpRequestRespondResult = typeof ExternalMcpRequestRespondResult.Type;

export interface ExternalMcpRespondInput {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  readonly answers: typeof ProviderUserInputAnswers.Type;
}

/** What the external service lends this module: the same checks its other tools run. */
export interface ExternalMcpRequestDeps {
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly newCommandId: Effect.Effect<CommandId>;
  readonly loadShell: (
    principal: ExternalMcpPrincipal,
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell, OrchestratorMcpFailure>;
  readonly requireCoordinate: (
    principal: ExternalMcpPrincipal,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly vetThreadModes: (
    principal: ExternalMcpPrincipal,
    thread: Pick<OrchestrationV2AppThread, "runtimeMode" | "interactionMode">,
  ) => Effect.Effect<ExpectedModesFork | undefined, OrchestratorMcpFailure>;
  readonly modesChangedSince: (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) => Effect.Effect<boolean, OrchestratorMcpFailure>;
  readonly audit: (
    principal: ExternalMcpPrincipal,
    operation: string,
    detail: object,
  ) => Effect.Effect<void>;
}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

export const makeExternalMcpRequests = (deps: ExternalMcpRequestDeps) => {
  const loadRequests = (principal: ExternalMcpPrincipal, threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* deps.loadShell(principal, threadId);
      return yield* deps.threadManagement
        .getProjectThreadRecords(
          { projectId: shell.projectId, threadId },
          ["runtimeRequests", "turnItems", "runs"],
          { turnItemTypes: ["user_input_request", "approval_request"] },
        )
        .pipe(Effect.mapError(threadManagementFailureFork));
    });

  return {
    listRequests: (principal: ExternalMcpPrincipal, input: { readonly threadId: ThreadId }) =>
      loadRequests(principal, input.threadId).pipe(
        Effect.map((records): ExternalMcpRequestListResult => ({
          threadId: input.threadId,
          requests: records.runtimeRequests.flatMap((request): ExternalMcpPendingRequest[] => {
            if (request.status !== "pending") return [];
            const item = records.turnItems.findLast(
              (candidate) => "requestId" in candidate && candidate.requestId === request.id,
            );
            if (request.kind === "user_input") {
              return item?.type === "user_input_request"
                ? [
                    {
                      type: "question",
                      requestId: request.id,
                      runId: item.runId,
                      questions: item.questions,
                    },
                  ]
                : [];
            }
            // T3 resolves these itself; the composer shows neither.
            if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") return [];
            const approval = item?.type === "approval_request" ? item : undefined;
            return [
              {
                type: "approval",
                requestId: request.id,
                runId: approval?.runId ?? null,
                requestKind: request.kind,
                detail: approval?.prompt || null,
                options: approval?.options ?? [],
              },
            ];
          }),
        })),
      ),

    respondToRequest: (principal: ExternalMcpPrincipal, input: ExternalMcpRespondInput) =>
      Effect.gen(function* () {
        yield* deps.requireCoordinate(principal);
        const records = yield* loadRequests(principal, input.threadId);
        // A capped grant's vetted modes ride on the answer, so a message-delivered
        // answer is refused at commit if the owner changed the modes meanwhile.
        const expectedModes = yield* deps.vetThreadModes(principal, records.thread);
        const request = records.runtimeRequests.find(
          (candidate) => candidate.id === input.requestId,
        );
        if (request === undefined) {
          return yield* failure(
            "invalid_request",
            `Request ${input.requestId} is not on thread ${input.threadId}.`,
          );
        }
        if (request.kind !== "user_input") {
          return yield* failure(
            "capability_denied",
            `Request ${input.requestId} is not a question; only the environment owner decides approvals, in T3.`,
          );
        }
        if (request.status !== "pending") {
          return yield* failure(
            "invalid_request",
            `Request ${input.requestId} is ${request.status}.`,
          );
        }
        // Like a steer, a live answer resumes the asking turn, so a capped grant
        // answers only a run whose modes are unchanged since it started. A native
        // subagent's question has no run to check, so it stays the owner's.
        const runId = records.turnItems.findLast(
          (candidate) => "requestId" in candidate && candidate.requestId === request.id,
        )?.runId;
        const run = records.runs.find((candidate) => candidate.id === runId);
        if (
          expectedModes !== undefined &&
          request.responseCapability.type === "live" &&
          (run === undefined || (yield* deps.modesChangedSince(input.threadId, run)))
        ) {
          return yield* failure(
            "runtime_mode_escalation_denied",
            `Request ${request.id} is not from a run started under this thread's current modes, so this credential cannot answer it live.`,
          );
        }
        yield* deps.audit(principal, "request.respond", {
          threadId: input.threadId,
          requestId: input.requestId,
        });
        return yield* deps.threadManagement
          .dispatch({
            type: "runtime-request.respond",
            commandId: yield* deps.newCommandId,
            threadId: input.threadId,
            requestId: input.requestId,
            answers: input.answers,
            ...(expectedModes === undefined ? {} : { expectedModes }),
          })
          .pipe(
            Effect.map((result) => ({ sequence: result.sequence })),
            Effect.mapError(threadManagementFailureFork),
          );
      }),
  };
};
