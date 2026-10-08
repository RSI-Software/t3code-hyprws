import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

const MUTATION_PERMITS = Number.MAX_SAFE_INTEGER;
const defaultLease = {
  admission: Semaphore.makeUnsafe(1),
  mutations: Semaphore.makeUnsafe(MUTATION_PERMITS),
};
class CheckoutSessionStateLease extends Context.Reference<typeof defaultLease>(
  "t3/zmux/CheckoutSessionStateLease.fork/CheckoutSessionStateLease",
  { defaultValue: () => defaultLease },
) {}

const withPermits = <A, E, R>(permits: number, effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(CheckoutSessionStateLease, (lease) =>
    Effect.acquireUseRelease(
      // A pending cleanup holds admission while existing mutations drain.
      // Later mutations cannot jump the queue and starve cleanup.
      lease.admission.withPermits(1)(lease.mutations.take(permits)),
      () => effect,
      () => lease.mutations.release(permits),
    ),
  );

/** Concurrent state commits; no new serialization between ordinary writers. */
export const withCheckoutSessionMutationFork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withPermits(1, effect);

/** Final consumer-state reads and destruction exclude all state commits. */
export const withCheckoutSessionCleanupFork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withPermits(MUTATION_PERMITS, effect);
