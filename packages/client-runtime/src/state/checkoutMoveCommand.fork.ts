// Fork-only (zmux-estate): the thread checkout-move command, spread into
// `createThreadEnvironmentAtoms` through one hook so upstream's command table
// keeps its shape.
import type { EnvironmentId, ThreadCheckoutMoveRequestInput } from "@t3tools/contracts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestThreadCheckoutMove } from "../operations/checkoutMove.fork.ts";
import {
  type AtomCommandConcurrency,
  type AtomCommandScheduler,
  createEnvironmentCommand,
} from "./runtime.ts";

export function checkoutMoveThreadCommandsFork<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
  scheduler: AtomCommandScheduler,
  concurrency: AtomCommandConcurrency<{
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: string };
  }>,
) {
  return {
    moveCheckout: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:move-checkout",
      execute: (input: ThreadCheckoutMoveRequestInput) => requestThreadCheckoutMove(input),
      scheduler,
      concurrency,
    }),
  };
}
