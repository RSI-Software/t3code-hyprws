import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ClientCapabilities from "../platform/capabilities.ts";
import type { ConnectionCatalogEntry, PlatformConnectionRegistration } from "./catalog.ts";

/**
 * Saved-connection precedence (RSI-Software/t3code-hyprws#1350,
 * RSI-Software/t3code-hyprws#1412). Upstream's platform primary replaces and
 * deletes a persisted registration for the same environment, which is right
 * for a spawned backend. An attached server comes and goes, so platforms that
 * attach opt in: the attached primary wins while present, so the environment
 * stays local, and the saved connection is kept and returns when the
 * attachment drops.
 */
export const savedConnectionsOutrankPrimary = Effect.map(
  Effect.serviceOption(ClientCapabilities.PrimaryEnvironmentAuth),
  (auth) => Option.isSome(auth) && auth.value.savedConnectionsOutrankPrimary === true,
);

export const make = Effect.fn("SavedConnectionPrecedence.make")(function* (
  enabled: boolean,
  platformEnvironmentIds: Ref.Ref<ReadonlySet<EnvironmentId>>,
  installEntry: (entry: ConnectionCatalogEntry) => Effect.Effect<void>,
) {
  const shadowed = yield* Ref.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(new Map());

  /**
   * Installs an attached primary above a saved connection for its environment,
   * keeping the saved one persisted. True when it handled the registration.
   */
  const shadow = Effect.fn("SavedConnectionPrecedence.shadow")(function* (
    registration: PlatformConnectionRegistration,
    persisted: boolean,
    previous: ConnectionCatalogEntry | undefined,
    entry: ConnectionCatalogEntry,
  ) {
    if (!enabled || !persisted) return false;
    if (registration._tag !== "PrimaryConnectionRegistration") return false;
    const environmentId = entry.target.environmentId;
    if (previous !== undefined && previous.target._tag !== "PrimaryConnectionTarget") {
      yield* Ref.update(shadowed, (current) => new Map(current).set(environmentId, previous));
    }
    yield* Ref.update(platformEnvironmentIds, (current) => new Set(current).add(environmentId));
    yield* installEntry(entry);
    return true;
  });

  /** Puts the saved connection back when its attached primary drops. */
  const restore = Effect.fn("SavedConnectionPrecedence.restore")(function* (
    environmentId: EnvironmentId,
  ) {
    const saved = (yield* Ref.get(shadowed)).get(environmentId);
    if (saved === undefined) return false;
    yield* Ref.update(shadowed, (current) => {
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
    yield* installEntry(saved);
    return true;
  });

  return { shadow, restore };
});
