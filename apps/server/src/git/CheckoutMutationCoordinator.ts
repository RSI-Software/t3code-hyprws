import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class CheckoutMutationCoordinator extends Context.Service<
  CheckoutMutationCoordinator,
  {
    readonly withLease: <A, E, R>(
      physicalCheckoutRoot: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/git/CheckoutMutationCoordinator") {}

export const layer = Layer.sync(CheckoutMutationCoordinator, () => {
  const checkouts = new Map<string, Semaphore.Semaphore>();
  return CheckoutMutationCoordinator.of({
    withLease: (physicalCheckoutRoot, effect) => {
      let semaphore = checkouts.get(physicalCheckoutRoot);
      if (!semaphore) {
        semaphore = Semaphore.makeUnsafe(1);
        checkouts.set(physicalCheckoutRoot, semaphore);
      }
      return semaphore.withPermits(1)(effect);
    },
  });
});
