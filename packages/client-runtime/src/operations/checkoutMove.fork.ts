import { CommandId, type ThreadCheckoutMoveRequestInput, WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";

export type { ThreadCheckoutMoveRequestInput } from "@t3tools/contracts";

type CheckoutMoveTag = typeof WS_METHODS.threadCheckoutMoveRequest;

/**
 * Requests a fork-owned thread checkout move. The request id is minted here
 * when the caller has none, so a transport retry of the same request replays
 * idempotently on the server.
 */
export const requestThreadCheckoutMove: (
  input: ThreadCheckoutMoveRequestInput,
) => Effect.Effect<
  EnvironmentRpcSuccess<CheckoutMoveTag>,
  EnvironmentRpcFailure<CheckoutMoveTag> | EnvironmentRpcUnavailableError,
  Crypto.Crypto | EnvironmentSupervisor
> = Effect.fn("EnvironmentCommands.moveThreadCheckout")(function* (input) {
  const requestId =
    input.requestId ??
    (yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
      Effect.orDie,
      Effect.map(CommandId.make),
    ));
  return yield* request(WS_METHODS.threadCheckoutMoveRequest, { ...input, requestId });
});
