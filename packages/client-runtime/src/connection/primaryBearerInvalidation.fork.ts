import * as Effect from "effect/Effect";

import type * as ClientCapabilities from "../platform/capabilities.ts";

/**
 * Pipe for the primary connection broker (RSI-Software/t3code-hyprws#1350):
 * a failed prepare, such as a rejected WebSocket ticket, invalidates the
 * platform's cached primary bearer so the retry never reuses a dead one.
 * Platforms without an invalidator keep upstream behavior.
 */
export const invalidatePrimaryBearerOnFailure =
  (auth: ClientCapabilities.PrimaryEnvironmentAuth["Service"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const invalidate = auth.invalidateBearerToken;
    return invalidate === undefined ? effect : Effect.tapError(effect, () => invalidate());
  };
