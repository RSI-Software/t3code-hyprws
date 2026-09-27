import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import type { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";

/**
 * Resolves the checkout a client turn start leases.
 *
 * A worktree removed outside T3 no longer resolves to a repository. There is
 * then no checkout to contend for, so its own path stands in as the lease key
 * and the provider reactor recovers the thread. Dying here instead surfaces as
 * an RPC defect that drops the client's websocket. Every other resolve error
 * becomes a typed turn-start rejection that carries its detail, for the same
 * reason.
 */
export const resolveTurnCheckoutFork = (
  registry: Pick<VcsDriverRegistry["Service"], "resolve">,
  cwd: string,
) =>
  registry.resolve({ cwd }).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "VcsUnsupportedOperationError" &&
        error.operation === "VcsDriverRegistry.resolve",
      () => Effect.succeed({ repository: { rootPath: cwd } }),
    ),
    Effect.mapError(
      (error) =>
        new OrchestrationCommandInvariantError({
          commandType: "thread.turn.start",
          detail: `Could not resolve the checkout at ${cwd}: ${error.message}`,
          cause: error,
        }),
    ),
  );
