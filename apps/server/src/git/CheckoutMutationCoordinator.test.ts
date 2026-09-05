import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { CheckoutMutationCoordinator, layer } from "./CheckoutMutationCoordinator.ts";

describe("CheckoutMutationCoordinator", () => {
  it.effect("serializes mutations for one physical checkout identity", () =>
    Effect.gen(function* () {
      const coordinator = yield* CheckoutMutationCoordinator;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const order: string[] = [];
      const first = yield* coordinator
        .withLease(
          "/physical/repo",
          Effect.gen(function* () {
            order.push("first-enter");
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            order.push("first-exit");
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const second = yield* coordinator
        .withLease(
          "/physical/repo",
          Effect.sync(() => order.push("second")),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(order).toEqual(["first-enter", "first-exit", "second"]);
    }).pipe(Effect.provide(layer)),
  );
});
