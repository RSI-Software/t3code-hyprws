// Fork-owned handlers for the external MCP tools: each reads the request's
// principal and calls one `ExternalMcpServiceFork` method. A refusal is a tool
// error (`isError: true`) whose text leads with the failure code, since the
// MCP server reports only the failure's message.
//
// Access is declared through upstream's `McpToolAccess`, against the
// outside-client caller the endpoint's middleware provides, so upstream's
// read-only and runtime-mode checks run first. The service then applies the
// grant's project and interaction-mode policy, which upstream's client caller
// does not model yet.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure } from "@t3tools/contracts";

import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  type ExternalMcpPrincipal,
  ExternalMcpPrincipalFork,
  ExternalMcpServiceFork,
} from "../../external/ExternalMcpService.fork.ts";
import { ExternalMcpToolkitFork } from "./tools.fork.ts";

/** A requested mode for upstream's bound; `inherit` leaves it to the grant policy. */
const requestedMode = <M extends string>(mode: M | "inherit" | undefined) =>
  mode === "inherit" ? undefined : mode;

const make = Effect.gen(function* () {
  const service = yield* ExternalMcpServiceFork;
  const withPrincipal = <A>(
    run: (principal: ExternalMcpPrincipal) => Effect.Effect<A, OrchestratorMcpFailure>,
  ) =>
    Effect.gen(function* () {
      return yield* run(yield* ExternalMcpPrincipalFork);
    }).pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.code,
            message: `${error.code}: ${error.message}`,
          }),
      ),
    );

  return {
    t3_external_thread_settle: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) => withPrincipal((principal) => service.settleThread(principal, input)),
    ),
    t3_external_whoami: McpToolAccess.reads(() =>
      withPrincipal((principal) =>
        Effect.succeed({
          sessionId: principal.sessionId,
          subject: principal.subject,
          clientLabel: principal.clientLabel,
          expiresAt: principal.expiresAt === null ? null : DateTime.formatIso(principal.expiresAt),
          policy: principal.policy,
        }),
      ),
    ),
    t3_external_project_list: McpToolAccess.reads(() =>
      withPrincipal((principal) =>
        service.listProjects(principal).pipe(Effect.map((projects) => ({ projects }))),
      ),
    ),
    t3_external_thread_list: McpToolAccess.reads((input) =>
      withPrincipal((principal) => service.listThreads(principal, input)),
    ),
    t3_external_thread_read: McpToolAccess.reads((input) =>
      withPrincipal((principal) => service.readThread(principal, input)),
    ),
    t3_external_thread_wait: McpToolAccess.reads((input) =>
      withPrincipal((principal) => service.waitForThread(principal, input)),
    ),
    // The grant policy resolves the started modes; upstream's bound only refuses broader ones.
    t3_external_thread_create: McpToolAccess.startsThreads(
      (input) => ({
        runtimeMode: requestedMode(input.runtimeMode),
        interactionMode: requestedMode(input.interactionMode),
      }),
      (input) => withPrincipal((principal) => service.createThread(principal, input)),
    ),
    t3_external_thread_send: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) => withPrincipal((principal) => service.sendToThread(principal, input)),
    ),
    t3_external_thread_interrupt: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) => withPrincipal((principal) => service.interruptThread(principal, input)),
    ),
    t3_external_request_list: McpToolAccess.reads((input) =>
      withPrincipal((principal) => service.listRequests(principal, input)),
    ),
    t3_external_request_respond: McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) => withPrincipal((principal) => service.respondToRequest(principal, input)),
    ),
  } satisfies McpToolAccess.Handlers<typeof ExternalMcpToolkitFork.tools>;
});

export const ExternalMcpToolkitHandlersLiveFork = McpToolAccess.toLayer(
  ExternalMcpToolkitFork,
  make,
);
