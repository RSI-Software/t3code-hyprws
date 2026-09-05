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

export const ThreadCheckoutMove = Schema.Struct({
  requestId: CommandId,
  source: CheckoutPhysicalIdentity,
  sourceThreadBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  sourceThreadWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
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

export const ThreadCheckoutMoveRequestCommand = Schema.Struct({
  type: Schema.Literal("thread.checkout-move.request"),
  commandId: CommandId,
  threadId: ThreadId,
  requestedPath: TrimmedNonEmptyString,
  expectedCheckoutRoot: TrimmedNonEmptyString,
  reverseOfRequestId: Schema.optional(CommandId),
  createdAt: IsoDateTime,
});
export type ThreadCheckoutMoveRequestCommand = typeof ThreadCheckoutMoveRequestCommand.Type;

export const ThreadCheckoutMovePrepareCommand = Schema.Struct({
  type: Schema.Literal("thread.checkout-move.prepare"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  source: CheckoutPhysicalIdentity,
  sourceThreadBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  sourceThreadWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  destination: CheckoutPhysicalIdentity,
  reverseOfRequestId: Schema.optional(CommandId),
  queued: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type ThreadCheckoutMovePrepareCommand = typeof ThreadCheckoutMovePrepareCommand.Type;

export const ThreadCheckoutMoveCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.checkout-move.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  source: CheckoutPhysicalIdentity,
  destination: CheckoutPhysicalIdentity,
  status: Schema.Literals(["committed", "partial", "failed"]),
  completedSteps: Schema.Array(Schema.Literals(["provider", "metadata"])),
  effectiveProvider: Schema.NullOr(CheckoutPhysicalIdentity),
  providerAvailable: Schema.optional(Schema.Boolean),
  detail: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type ThreadCheckoutMoveCompleteCommand = typeof ThreadCheckoutMoveCompleteCommand.Type;

export const ThreadCheckoutMoveEvent = Schema.Struct({
  type: Schema.Literal("thread.checkout-move-updated"),
  threadId: ThreadId,
  move: ThreadCheckoutMove,
});
export type ThreadCheckoutMoveEvent = typeof ThreadCheckoutMoveEvent.Type;
