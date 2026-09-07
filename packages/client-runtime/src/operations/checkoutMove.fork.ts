import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";

/**
 * The checkout-move command is fork-owned end to end: upstream
 * `operations/commands.ts` keeps none of it, so its dispatch helpers stay
 * private there and this module re-derives the two small pieces it needs.
 * Revisit only if upstream ever exports its dispatch seam.
 */
type CheckoutMoveCommand = Extract<
  ClientOrchestrationCommand,
  { readonly type: "thread.checkout-move.request" }
>;

export type ThreadCheckoutMoveRequestInput = Omit<
  CheckoutMoveCommand,
  "type" | "commandId" | "createdAt"
> & {
  readonly commandId?: CommandId;
} & ("createdAt" extends keyof CheckoutMoveCommand
    ? {
        readonly createdAt?: CheckoutMoveCommand["createdAt"];
      }
    : {});

type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;
type CommandEffect = Effect.Effect<
  EnvironmentRpcSuccess<DispatchTag>,
  EnvironmentRpcFailure<DispatchTag> | EnvironmentRpcUnavailableError,
  Crypto.Crypto | EnvironmentSupervisor
>;

function timestampedCommandMetadata(input: {
  readonly commandId?: CommandId;
  readonly createdAt?: string;
}) {
  return Effect.all({
    commandId: Effect.gen(function* () {
      if (input.commandId !== undefined) {
        return input.commandId;
      }
      const crypto = yield* Crypto.Crypto;
      return yield* crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(CommandId.make));
    }),
    createdAt:
      input.createdAt === undefined
        ? DateTime.now.pipe(Effect.map(DateTime.formatIso))
        : Effect.succeed(input.createdAt),
  });
}

function dispatch(command: ClientOrchestrationCommand) {
  return request(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
}

export const requestThreadCheckoutMove: (input: ThreadCheckoutMoveRequestInput) => CommandEffect =
  Effect.fn("EnvironmentCommands.moveThreadCheckout")(function* (input) {
    const metadata = yield* timestampedCommandMetadata(input);
    return yield* dispatch({
      ...input,
      type: "thread.checkout-move.request",
      commandId: metadata.commandId,
      createdAt: metadata.createdAt,
    });
  });
