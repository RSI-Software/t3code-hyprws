// Fork-only (colleague-collab): an agent marks or unmarks a team project only for a user who holds
// sharing rights, as the RPC path requires them (`withTeamProjectScopesFork`).
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TeamMarkRights from "../../../collaborator/TeamMarkRights.fork.ts";
import { callerLinkOrigin } from "../../linkOrigin.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";

/** Only an update that carries the mark is checked. A client or link never holds sharing rights. */
export const requireTeamMarkRightsFork = Effect.fn("McpTeamProjectFork.require")(function* (input: {
  readonly teamFork?: boolean | undefined;
}) {
  if (input.teamFork === undefined) return;
  const caller = yield* loadCaller();
  const thread = caller.caller;
  const linked = caller.scope.client !== undefined || callerLinkOrigin(caller) !== undefined;
  if (
    linked ||
    (thread !== undefined &&
      !(yield* TeamMarkRights.TeamMarkRightsFork.use((rights) => rights.actsForHost(thread)).pipe(
        // Built from the request's thread service, so the upstream toolkit gains no dependency.
        Effect.provide(TeamMarkRights.layer),
        Effect.mapError(unavailable),
      )))
  )
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Marking or unmarking a team project takes sharing rights, which the user this call acts for lacks. The host can change it in the project's settings.",
    });
});
