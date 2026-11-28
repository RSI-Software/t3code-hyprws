// Fork-only (colleague-collab): an agent marks or unmarks a team project only for a user who holds
// sharing rights, as the RPC path requires them (`withTeamProjectScopesFork`).
import {
  COLLABORATOR_SHARE_SCOPES,
  mcpClientScopes,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { callerLinkOrigin } from "../../linkOrigin.ts";
import { type Caller, loadCaller, unavailable } from "../../threadAccess.ts";

const refused = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      "Marking or unmarking a team project takes sharing rights, which the user this call acts for lacks. The host can change it in the project's settings.",
  });

/**
 * A client or link acts for its grant, which never carries sharing rights. A thread's agent acts
 * for this environment's user, unless a collaborator or guest wrote the message it is answering.
 */
export const teamMarkRightsFork = Effect.fn("McpTeamProjectFork.rights")(function* (
  caller: Caller,
) {
  const access = caller.scope.client?.access ?? callerLinkOrigin(caller)?.access;
  if (access !== undefined) {
    const grant = mcpClientScopes(access);
    if (COLLABORATOR_SHARE_SCOPES.every((scope) => grant.includes(scope))) return;
    return yield* refused();
  }
  const thread = caller.caller;
  const runId = thread?.activeRunId ?? thread?.latestRunId ?? null;
  if (thread === undefined || runId === null) return;
  const { runs } = yield* caller.threads
    .getThreadRecords(thread.id, ["runs"], { runIds: [runId] })
    .pipe(Effect.mapError(unavailable));
  const run = runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return;
  const messages = yield* caller.threads
    .getMessagesById(thread.id, [run.userMessageId])
    .pipe(Effect.mapError(unavailable));
  const context = messages.get(run.userMessageId)?.context;
  const collaborator = context?.collaboratorFork;
  if (context?.guest !== undefined || (collaborator !== undefined && collaborator.host !== true))
    return yield* refused();
});

/** Only an update that carries the mark is checked. */
export const requireTeamMarkRightsFork = (input: { readonly teamFork?: boolean | undefined }) =>
  input.teamFork === undefined
    ? Effect.void
    : loadCaller().pipe(Effect.flatMap(teamMarkRightsFork));
