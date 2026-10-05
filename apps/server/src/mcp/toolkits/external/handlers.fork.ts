// Fork-owned handlers for the external MCP tools: each reads the request's
// principal and calls one `ExternalMcpServiceFork` method. A refusal is a tool
// error (`isError: true`) whose text leads with the failure code, since the
// MCP server reports only the failure's message.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure } from "@t3tools/contracts";

import {
  type ExternalMcpPrincipal,
  ExternalMcpPrincipalFork,
  ExternalMcpServiceFork,
} from "../../external/ExternalMcpService.fork.ts";
import { ExternalMcpToolkitFork } from "./tools.fork.ts";

export const ExternalMcpToolkitHandlersLiveFork = ExternalMcpToolkitFork.toLayer(
  Effect.gen(function* () {
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

    return ExternalMcpToolkitFork.of({
      t3_external_thread_settle: (input) =>
        withPrincipal((principal) => service.settleThread(principal, input)),
      t3_external_whoami: () =>
        withPrincipal((principal) =>
          Effect.succeed({
            sessionId: principal.sessionId,
            subject: principal.subject,
            clientLabel: principal.clientLabel,
            expiresAt:
              principal.expiresAt === null ? null : DateTime.formatIso(principal.expiresAt),
            policy: principal.policy,
          }),
        ),
      t3_external_project_list: () =>
        withPrincipal((principal) =>
          service.listProjects(principal).pipe(Effect.map((projects) => ({ projects }))),
        ),
      t3_external_thread_list: (input) =>
        withPrincipal((principal) => service.listThreads(principal, input)),
      t3_external_thread_read: (input) =>
        withPrincipal((principal) => service.readThread(principal, input)),
      t3_external_thread_wait: (input) =>
        withPrincipal((principal) => service.waitForThread(principal, input)),
      t3_external_thread_create: (input) =>
        withPrincipal((principal) => service.createThread(principal, input)),
      t3_external_thread_send: (input) =>
        withPrincipal((principal) => service.sendToThread(principal, input)),
      t3_external_thread_interrupt: (input) =>
        withPrincipal((principal) => service.interruptThread(principal, input)),
    });
  }),
);
