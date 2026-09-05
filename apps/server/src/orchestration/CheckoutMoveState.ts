import {
  type CheckoutPhysicalIdentity,
  type ThreadCheckoutMove,
  type ThreadCheckoutMoveCompleteCommand,
  type ThreadCheckoutMoveEvent,
  type ThreadCheckoutMovePrepareCommand,
} from "@t3tools/contracts";

export interface CheckoutMoveProjection {
  readonly effective: CheckoutPhysicalIdentity;
  readonly move: ThreadCheckoutMove | null;
}

export type CheckoutMoveDecision =
  | { readonly status: "accepted"; readonly event: ThreadCheckoutMoveEvent }
  | { readonly status: "idempotent"; readonly event: null }
  | { readonly status: "rejected"; readonly reason: string };

function sameIdentity(left: CheckoutPhysicalIdentity, right: CheckoutPhysicalIdentity): boolean {
  return (
    left.repositoryRoot === right.repositoryRoot &&
    left.checkoutRoot === right.checkoutRoot &&
    left.revision === right.revision &&
    left.branch === right.branch
  );
}

function sameOptionalIdentity(
  left: CheckoutPhysicalIdentity | null,
  right: CheckoutPhysicalIdentity | null,
): boolean {
  return left === null || right === null ? left === right : sameIdentity(left, right);
}

export function decideCheckoutMovePrepare(input: {
  readonly command: ThreadCheckoutMovePrepareCommand;
  readonly projection: CheckoutMoveProjection;
}): CheckoutMoveDecision {
  const current = input.projection.move;
  const nextStatus = input.command.queued ? "queued" : "preparing";
  if (!current || current.requestId !== input.command.requestId) {
    return { status: "rejected", reason: "checkout move request was superseded" };
  }
  if (
    current.status === nextStatus &&
    current.destination !== null &&
    sameIdentity(current.destination, input.command.destination) &&
    sameIdentity(current.source, input.command.source)
  ) {
    return { status: "idempotent", event: null };
  }
  if (current.status !== "queued" && current.status !== "preparing") {
    return { status: "rejected", reason: "checkout move is no longer preparable" };
  }
  if (
    !sameIdentity(current.source, input.command.source) ||
    current.requestedPath !== input.command.destination.checkoutRoot
  ) {
    return { status: "rejected", reason: "checkout move source identity changed" };
  }
  if (input.command.source.repositoryRoot !== input.command.destination.repositoryRoot) {
    return { status: "rejected", reason: "destination belongs to another repository" };
  }
  return {
    status: "accepted",
    event: {
      type: "thread.checkout-move-updated",
      threadId: input.command.threadId,
      move: {
        ...current,
        destination: input.command.destination,
        status: nextStatus,
        updatedAt: input.command.createdAt,
      },
    },
  };
}

export function decideCheckoutMoveComplete(input: {
  readonly command: ThreadCheckoutMoveCompleteCommand;
  readonly projection: CheckoutMoveProjection;
}): CheckoutMoveDecision {
  const current = input.projection.move;
  if (!current || current.requestId !== input.command.requestId) {
    return { status: "rejected", reason: "checkout move completion lost its request CAS" };
  }
  if (current.status !== "preparing") {
    if (
      current.status === input.command.status &&
      current.providerAvailable === input.command.providerAvailable &&
      current.detail === input.command.detail &&
      sameIdentity(current.source, input.command.source) &&
      current.destination !== null &&
      sameIdentity(current.destination, input.command.destination) &&
      current.completedSteps.join("\0") === input.command.completedSteps.join("\0") &&
      sameOptionalIdentity(current.effectiveProvider, input.command.effectiveProvider)
    ) {
      return { status: "idempotent", event: null };
    }
    return { status: "rejected", reason: "checkout move is not preparing" };
  }
  if (
    !sameIdentity(current.source, input.command.source) ||
    current.destination === null ||
    !sameIdentity(current.destination, input.command.destination)
  ) {
    return { status: "rejected", reason: "checkout move identity changed during preparation" };
  }
  return {
    status: "accepted",
    event: {
      type: "thread.checkout-move-updated",
      threadId: input.command.threadId,
      move: {
        ...current,
        status: input.command.status,
        completedSteps: input.command.completedSteps,
        effectiveProvider: input.command.effectiveProvider,
        providerAvailable: input.command.providerAvailable,
        ...(input.command.detail ? { detail: input.command.detail } : {}),
        updatedAt: input.command.createdAt,
      },
    },
  };
}
