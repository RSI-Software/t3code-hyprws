import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ClientCapabilities from "../platform/capabilities.ts";
import type { PlatformConnectionRegistration } from "./catalog.ts";

/**
 * Saved-connection precedence (RSI-Software/t3code-hyprws#1350). Upstream's
 * platform primary replaces a persisted registration for the same
 * environment, which is right for a spawned backend. An attached server comes
 * and goes, so replacing would delete the user's saved connection the first
 * time the attachment drops. Platforms that attach opt in, and the saved
 * connection stays the way that environment is reached.
 */
export const savedConnectionsOutrankPrimary = Effect.map(
  Effect.serviceOption(ClientCapabilities.PrimaryEnvironmentAuth),
  (auth) => Option.isSome(auth) && auth.value.savedConnectionsOutrankPrimary === true,
);

export const keepsSavedConnection = (
  enabled: boolean,
  registration: PlatformConnectionRegistration,
  persistedTarget: unknown,
): boolean =>
  enabled && persistedTarget !== undefined && registration._tag === "PrimaryConnectionRegistration";
