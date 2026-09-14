// Fork-owned sibling of `decider.ts` for the checkout-move commands
// (RSI-Software/t3code-hyprws#962). The upstream decider dispatches here through
// one marked hook before its command switch; the switch itself never sees a
// `thread.checkout-move.*` command. Pure like the upstream decider: no I/O, no
// layers beyond the event-base plumbing passed in.
import {
  type CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import type * as PlatformError from "effect/PlatformError";

import { requireThread } from "./commandInvariants.ts";
import { decideCheckoutMoveComplete, decideCheckoutMovePrepare } from "./CheckoutMoveState.ts";
import {
  OrchestrationCommandInvariantError,
  type OrchestrationCommandRejection,
} from "./Errors.ts";

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

/** The fork's checkout-move commands, extracted from the upstream union. */
export type CheckoutMoveCommand = Extract<
  OrchestrationCommand,
  { type: `thread.checkout-move.${string}` }
>;

export const isCheckoutMoveCommand = (
  command: OrchestrationCommand,
): command is CheckoutMoveCommand => command.type.startsWith("thread.checkout-move.");

/** The slice of `decider.ts`'s local `withEventBase` the fork cases need. */
type WithEventBase = (input: {
  readonly aggregateKind: "thread";
  readonly aggregateId: OrchestrationEvent["aggregateId"];
  readonly occurredAt: string;
  readonly commandId: CommandId;
}) => Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
>;

/**
 * A `thread.turn.start` on a thread with a checkout move queued or preparing is
 * refused — the same check the woven decider carried, moved behind this seam.
 */
export const refuseTurnStartDuringCheckoutMoveFork = Effect.fn(
  "refuseTurnStartDuringCheckoutMoveFork",
)(function* (
  targetThread: OrchestrationThread,
  command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
): Effect.fn.Return<void, OrchestrationCommandRejection> {
  if (
    targetThread.checkoutMove?.status === "queued" ||
    targetThread.checkoutMove?.status === "preparing"
  ) {
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `thread ${command.threadId} has a checkout move in progress`,
    });
  }
});

/**
 * Decides the fork's checkout-move commands; `null` for anything else so the
 * caller falls through to the upstream switch. The case bodies are moved
 * verbatim from the woven decider, including both expected-context guards —
 * upstream exports no reusable expected-context helper (`thread.pull-request.sync`
 * inlines its own), so the guards live here in the fork sibling.
 */
export const decideCheckoutMoveFork = Effect.fn("decideCheckoutMoveFork")(function* ({
  command,
  readModel,
  withEventBase,
}: {
  readonly command: CheckoutMoveCommand;
  readonly readModel: OrchestrationReadModel;
  readonly withEventBase: WithEventBase;
}): Effect.fn.Return<
  PlannedOrchestrationEvent,
  OrchestrationCommandRejection | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "thread.checkout-move.request":
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "checkout move requests must be enriched with server-owned identities",
      });

    case "thread.checkout-move.prepare": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (thread.checkoutMove?.status === "queued" || thread.checkoutMove?.status === "preparing") {
        const decision = decideCheckoutMovePrepare({
          command,
          projection: { effective: thread.checkoutMove.source, move: thread.checkoutMove },
        });
        if (decision.status !== "accepted") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: decision.status === "rejected" ? decision.reason : "duplicate preparation",
          });
        }
        return {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: decision.event.type,
          payload: { threadId: decision.event.threadId, move: decision.event.move },
        };
      }
      if (
        thread.branch !== command.sourceThreadBranch ||
        thread.worktreePath !== command.sourceThreadWorktreePath
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "checkout move context changed before command commit",
        });
      }
      if (command.reverseOfRequestId !== undefined) {
        const prior = thread.checkoutMove;
        if (
          prior?.requestId !== command.reverseOfRequestId ||
          prior.status !== "committed" ||
          prior.destination === null ||
          !Equal.equals(prior.destination, command.source) ||
          !Equal.equals(prior.source, command.destination)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "reverse move no longer matches the effective checkout",
          });
        }
      }
      const occurredAt = command.createdAt;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.checkout-move-updated",
        payload: {
          threadId: command.threadId,
          move: {
            requestId: command.requestId,
            source: command.source,
            sourceThreadBranch: command.sourceThreadBranch,
            sourceThreadWorktreePath: command.sourceThreadWorktreePath,
            requestedPath: command.destination.checkoutRoot,
            destination: command.destination,
            expectedCheckoutRoot: command.source.checkoutRoot,
            status: command.queued || thread.session?.activeTurnId != null ? "queued" : "preparing",
            ...(command.reverseOfRequestId
              ? { reverseOfRequestId: command.reverseOfRequestId }
              : {}),
            completedSteps: [],
            effectiveProvider: null,
            requestedAt: occurredAt,
            updatedAt: occurredAt,
          },
        },
      };
    }

    case "thread.checkout-move.complete": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (!thread.checkoutMove) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "checkout move request is missing",
        });
      }
      if (
        (thread.checkoutMove.sourceThreadBranch !== undefined &&
          thread.branch !== thread.checkoutMove.sourceThreadBranch) ||
        (thread.checkoutMove.sourceThreadWorktreePath !== undefined &&
          thread.worktreePath !== thread.checkoutMove.sourceThreadWorktreePath)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "thread metadata changed during move preparation",
        });
      }
      const decision = decideCheckoutMoveComplete({
        command,
        projection: { effective: thread.checkoutMove.source, move: thread.checkoutMove },
      });
      if (decision.status !== "accepted") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: decision.status === "rejected" ? decision.reason : "duplicate completion",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: decision.event.type,
        payload: { threadId: decision.event.threadId, move: decision.event.move },
      };
    }

    default:
      return yield* Effect.die(new Error("unreachable checkout-move command"));
  }
});
