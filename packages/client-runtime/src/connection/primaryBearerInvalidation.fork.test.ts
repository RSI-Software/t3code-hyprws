import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type * as ClientCapabilities from "../platform/capabilities.ts";
import { invalidatePrimaryBearerOnFailure } from "./primaryBearerInvalidation.fork.ts";

type Auth = ClientCapabilities.PrimaryEnvironmentAuth["Service"];

const authWith = (invalidations: Array<string>): Auth =>
  ({
    invalidateBearerToken: () => Effect.sync(() => void invalidations.push("invalidated")),
  }) as unknown as Auth;

describe("invalidatePrimaryBearerOnFailure", () => {
  it.effect("a rejected ticket invalidates the cached bearer and keeps the failure", () =>
    Effect.gen(function* () {
      const invalidations: Array<string> = [];
      const error = yield* Effect.fail("ticket-rejected").pipe(
        invalidatePrimaryBearerOnFailure(authWith(invalidations)),
        Effect.flip,
      );
      expect(error).toBe("ticket-rejected");
      expect(invalidations).toEqual(["invalidated"]);
    }),
  );

  it.effect("a successful prepare leaves the bearer alone", () =>
    Effect.gen(function* () {
      const invalidations: Array<string> = [];
      const value = yield* Effect.succeed("ticket").pipe(
        invalidatePrimaryBearerOnFailure(authWith(invalidations)),
      );
      expect(value).toBe("ticket");
      expect(invalidations).toEqual([]);
    }),
  );

  it.effect("a platform without an invalidator keeps upstream behavior", () =>
    Effect.gen(function* () {
      const error = yield* Effect.fail("ticket-rejected").pipe(
        invalidatePrimaryBearerOnFailure({} as unknown as Auth),
        Effect.flip,
      );
      expect(error).toBe("ticket-rejected");
    }),
  );
});
