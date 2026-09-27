import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";

/** A client turn start whose checkout could not be resolved, so it was not leased. */
export class TurnStartCheckoutUnresolvedError extends Schema.TaggedError<TurnStartCheckoutUnresolvedError>()(
  "TurnStartCheckoutUnresolvedError",
  { cwd: Schema.String, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Resolves the checkout a client turn start leases.
 *
 * A worktree removed outside T3 no longer resolves to a repository. There is
 * then no checkout to contend for, so its own path stands in as the lease key
 * and turn start recovers the thread. Dying here instead surfaces as
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
        new TurnStartCheckoutUnresolvedError({
          cwd,
          detail: `Could not resolve the checkout at ${cwd}: ${error.message}`,
          cause: error,
        }),
    ),
  );
