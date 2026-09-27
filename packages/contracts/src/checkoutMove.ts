import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CheckoutPhysicalIdentity = Schema.Struct({
  repositoryRoot: TrimmedNonEmptyString,
  checkoutRoot: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
});
export type CheckoutPhysicalIdentity = typeof CheckoutPhysicalIdentity.Type;

export const CheckoutMoveStatus = Schema.Literals([
  "queued",
  "preparing",
  "committed",
  "partial",
  "failed",
]);
export type CheckoutMoveStatus = typeof CheckoutMoveStatus.Type;

/** Why the server, not the user, started a move; absent for a user move. */
export const CheckoutMoveReason = Schema.Literal("worktree-recovery");
export type CheckoutMoveReason = typeof CheckoutMoveReason.Type;

export const ThreadCheckoutMove = Schema.Struct({
  requestId: CommandId,
  source: CheckoutPhysicalIdentity,
  sourceThreadBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  sourceThreadWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  reason: Schema.optional(CheckoutMoveReason),
  requestedPath: TrimmedNonEmptyString,
  destination: Schema.NullOr(CheckoutPhysicalIdentity),
  expectedCheckoutRoot: TrimmedNonEmptyString,
  status: CheckoutMoveStatus,
  reverseOfRequestId: Schema.optional(CommandId),
  detail: Schema.optional(TrimmedNonEmptyString),
  completedSteps: Schema.Array(Schema.Literals(["provider", "metadata"])),
  effectiveProvider: Schema.NullOr(CheckoutPhysicalIdentity),
  providerAvailable: Schema.optional(Schema.Boolean),
  requestedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadCheckoutMove = typeof ThreadCheckoutMove.Type;

/**
 * Asks the server to move a thread to another checkout of the same repository.
 * `expectedCheckoutRoot` is the checkout the client last saw the thread in;
 * the server refuses when it no longer matches. `requestId` makes a retried
 * request idempotent; the server mints one when it is absent.
 */
export const ThreadCheckoutMoveRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestedPath: TrimmedNonEmptyString,
  expectedCheckoutRoot: TrimmedNonEmptyString,
  reverseOfRequestId: Schema.optional(CommandId),
  requestId: Schema.optional(CommandId),
});
export type ThreadCheckoutMoveRequestInput = typeof ThreadCheckoutMoveRequestInput.Type;

export const ThreadCheckoutMoveRequestResult = Schema.Struct({
  requestId: CommandId,
  status: CheckoutMoveStatus,
});
export type ThreadCheckoutMoveRequestResult = typeof ThreadCheckoutMoveRequestResult.Type;

export class ThreadCheckoutMoveError extends Schema.TaggedError<ThreadCheckoutMoveError>()(
  "ThreadCheckoutMoveError",
  {
    threadId: ThreadId,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
