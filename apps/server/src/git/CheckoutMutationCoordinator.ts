import * as Effect from "effect/Effect";

class CheckoutMutex {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  readonly acquire = Effect.callback<void>((resume) => {
    const enter = () => {
      this.locked = true;
      resume(Effect.void);
    };
    if (this.locked) this.waiters.push(enter);
    else enter();
  });

  readonly release = Effect.sync(() => {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  });
}

const checkouts = new Map<string, CheckoutMutex>();

export function withCheckoutMutationLease<A, E, R>(
  physicalCheckoutRoot: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  let mutex = checkouts.get(physicalCheckoutRoot);
  if (!mutex) {
    mutex = new CheckoutMutex();
    checkouts.set(physicalCheckoutRoot, mutex);
  }
  return Effect.acquireUseRelease(
    mutex.acquire,
    () => effect,
    () => mutex.release,
  );
}
